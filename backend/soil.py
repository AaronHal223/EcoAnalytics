"""Soil research engine.

Nobody types in soil numbers. EcoAnalytics looks them up from published soil
surveys for the garden's location and is honest about how sure it is.

Sources
-------
* USDA NRCS Soil Data Access (SSURGO): the county soil surveys, mapped field
  by field across the US. Primary source for pH, organic matter, CEC and
  sand/silt/clay. https://sdmdataaccess.sc.egov.usda.gov
* ISRIC SoilGrids 2.0: a 250 m global machine-learning soil map. Used for
  total nitrogen, and for everything when SSURGO has no data at a point
  (e.g. mapped as "Urban land"). https://soilgrids.org  (fair-use limit of
  ~5 calls/min, so only the centre point is queried.)
* Regional defaults: last resort when both are unreachable.

Averaging ("find an average that makes sense")
----------------------------------------------
A single map point is a guess: the location may be off (IP / ZIP centroid)
and soil changes over short distances. So the engine samples a ring of
points around the location, sized to how precise the location is:

    device / address  ->  0.3 km ring
    ZIP centroid      ->  2 km ring
    IP address        ->  6 km ring

and takes a weighted average (centre counts double). How much the ring
points disagree feeds the confidence score shown next to every number.

What can't be looked up
-----------------------
Plant-available phosphorus and potassium depend on what was spread on that
exact yard in past years; no map knows that. They are *estimated* from
texture, organic matter and CEC and always labelled low-confidence. Users
can paste in real soil-test results to override any value.
"""
from __future__ import annotations

import math
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from typing import Optional

from .geo import Location
from .http import SourceUnavailable, get_json, post_json

SDA_URL = "https://sdmdataaccess.sc.egov.usda.gov/Tabular/post.rest"
SOILGRIDS_URL = "https://rest.isric.org/soilgrids/v2.0/properties/query"

TOP_CM = 30  # the root zone that matters for a vegetable bed

# Healthy ranges for most vegetables (extension-service consensus).
IDEAL = {
    "ph": (6.2, 6.8),
    "organic_matter_pct": (4.0, 8.0),
    "cec": (10.0, 30.0),
    "p_ppm": (25.0, 50.0),     # Mehlich-3 equivalent
    "k_ppm": (100.0, 175.0),
}

UNITS = {
    "ph": "pH", "organic_matter_pct": "%", "clay_pct": "%", "sand_pct": "%",
    "silt_pct": "%", "cec": "cmol/kg", "total_n_gkg": "g/kg", "p_ppm": "ppm", "k_ppm": "ppm",
}

LABELS = {
    "ph": "Soil pH", "organic_matter_pct": "Organic matter", "clay_pct": "Clay",
    "sand_pct": "Sand", "silt_pct": "Silt", "cec": "Nutrient holding (CEC)",
    "total_n_gkg": "Total nitrogen", "p_ppm": "Phosphorus (est.)", "k_ppm": "Potassium (est.)",
}

SOURCE_QUALITY = {"soil_test": 1.0, "ssurgo": 0.85, "soilgrids": 0.65, "derived": 0.35,
                  "regional": 0.3}
LOCATION_QUALITY = {"device": 1.0, "address": 1.0, "zip": 0.85, "ip": 0.7, "fallback": 0.4}


# --------------------------------------------------------------------------
# Data model
# --------------------------------------------------------------------------
@dataclass
class SoilValue:
    key: str
    value: float
    unit: str
    label: str
    source: str
    confidence: str          # high | medium | low
    confidence_score: float  # 0-1
    low: Optional[float] = None    # spread across sampled points
    high: Optional[float] = None
    ideal: Optional[tuple[float, float]] = None
    status: Optional[str] = None   # low | ok | high


@dataclass
class SoilReport:
    values: dict[str, SoilValue]
    texture_class: str
    n_mineralized_lb_per_100sqft: float
    radius_km: float
    points_sampled: int
    points_with_data: int
    sources: list[str]
    notes: list[str] = field(default_factory=list)

    def get(self, key: str) -> float:
        return self.values[key].value

    def to_dict(self) -> dict:
        d = asdict(self)
        d["values"] = {k: asdict(v) for k, v in self.values.items()}
        return d


# --------------------------------------------------------------------------
# Geometry: ring of sample points
# --------------------------------------------------------------------------
def ring_radius_km(loc: Location) -> float:
    return {"device": 0.3, "address": 0.3, "zip": 2.0, "ip": 6.0}.get(loc.source, 8.0)


def sample_points(lat: float, lon: float, radius_km: float, n: int = 6) -> list[tuple[float, float, float]]:
    """Returns [(lat, lon, weight)]: centre (weight 2) plus n points on a ring."""
    pts = [(lat, lon, 2.0)]
    dlat = radius_km / 111.0
    dlon = radius_km / (111.0 * max(0.2, math.cos(math.radians(lat))))
    for i in range(n):
        a = 2 * math.pi * i / n
        pts.append((lat + dlat * math.sin(a), lon + dlon * math.cos(a), 1.0))
    return pts


# --------------------------------------------------------------------------
# USDA SSURGO via Soil Data Access
# --------------------------------------------------------------------------
_SDA_COLS = ["comppct_r", "compname", "hzdept_r", "hzdepb_r", "ph1to1h2o_r", "om_r",
             "cec7_r", "sandtotal_r", "silttotal_r", "claytotal_r"]


def _sda_query(lat: float, lon: float) -> str:
    return (
        "SELECT c.comppct_r, c.compname, ch.hzdept_r, ch.hzdepb_r, ch.ph1to1h2o_r, ch.om_r, "
        "ch.cec7_r, ch.sandtotal_r, ch.silttotal_r, ch.claytotal_r "
        "FROM mapunit mu "
        "INNER JOIN component c ON c.mukey = mu.mukey "
        "INNER JOIN chorizon ch ON ch.cokey = c.cokey "
        f"WHERE mu.mukey IN (SELECT * FROM SDA_Get_Mukey_from_intersection_with_WktWgs84("
        f"'point({lon:.6f} {lat:.6f})')) AND ch.hzdept_r < {TOP_CM}"
    )


def _f(v) -> Optional[float]:
    try:
        return None if v is None or v == "" else float(v)
    except (TypeError, ValueError):
        return None


def parse_sda_rows(rows: list[list]) -> dict[str, float]:
    """Collapses SSURGO component x horizon rows into one value per property:
    depth-weighted over 0-30 cm, then weighted by each component's share of
    the map unit. Properties with no data at this point are left out."""
    if rows and rows[0] and str(rows[0][0]).lower() == "comppct_r":
        rows = rows[1:]  # drop header row (JSON+COLUMNNAME)
    sums: dict[str, float] = {}
    weights: dict[str, float] = {}
    keymap = {"ph1to1h2o_r": "ph", "om_r": "organic_matter_pct", "cec7_r": "cec",
              "sandtotal_r": "sand_pct", "silttotal_r": "silt_pct", "claytotal_r": "clay_pct"}
    for row in rows:
        r = dict(zip(_SDA_COLS, row))
        pct, top, bot = _f(r["comppct_r"]), _f(r["hzdept_r"]), _f(r["hzdepb_r"])
        if not pct or top is None or bot is None:
            continue
        thick = max(0.0, min(bot, TOP_CM) - max(top, 0.0))
        if thick <= 0:
            continue
        w = pct * thick
        for col, key in keymap.items():
            v = _f(r[col])
            if v is None:
                continue
            sums[key] = sums.get(key, 0.0) + v * w
            weights[key] = weights.get(key, 0.0) + w
    return {k: sums[k] / weights[k] for k in sums if weights[k] > 0}


def fetch_ssurgo_point(lat: float, lon: float) -> dict[str, float]:
    data = post_json(SDA_URL, {"query": _sda_query(lat, lon), "format": "JSON+COLUMNNAME"})
    return parse_sda_rows((data or {}).get("Table", []))


# --------------------------------------------------------------------------
# ISRIC SoilGrids
# --------------------------------------------------------------------------
_SG_KEYS = {"phh2o": "ph", "soc": "soc_gkg", "nitrogen": "total_n_gkg", "clay": "clay_pct",
            "sand": "sand_pct", "silt": "silt_pct", "cec": "cec"}
# mapped units -> our units. pH*10 -> pH; dg/kg -> g/kg; cg/kg -> g/kg;
# g/kg -> %; mmol(c)/kg -> cmol/kg.
_SG_DIVISOR = {"phh2o": 10, "soc": 10, "nitrogen": 100, "clay": 10, "sand": 10, "silt": 10, "cec": 10}
_SG_DEPTHS = {"0-5cm": 5, "5-15cm": 10, "15-30cm": 15}


def parse_soilgrids(data: dict) -> dict[str, float]:
    out: dict[str, float] = {}
    for layer in (data or {}).get("properties", {}).get("layers", []):
        name = layer.get("name")
        if name not in _SG_KEYS:
            continue
        div = (layer.get("unit_measure") or {}).get("d_factor") or _SG_DIVISOR[name]
        tot = wsum = 0.0
        for d in layer.get("depths", []):
            mean = (d.get("values") or {}).get("mean")
            thick = _SG_DEPTHS.get(d.get("label"))
            if mean is None or thick is None:
                continue
            tot += (mean / div) * thick
            wsum += thick
        if wsum:
            out[_SG_KEYS[name]] = tot / wsum
    if "soc_gkg" in out:
        # Van Bemmelen factor: organic matter ~ 1.72 x organic carbon. g/kg -> %.
        out["organic_matter_pct"] = out.pop("soc_gkg") * 1.72 / 10
    return out


def fetch_soilgrids_point(lat: float, lon: float) -> dict[str, float]:
    params = [("lon", f"{lon:.5f}"), ("lat", f"{lat:.5f}"), ("value", "mean")]
    params += [("property", p) for p in _SG_KEYS]
    params += [("depth", d) for d in _SG_DEPTHS]
    return parse_soilgrids(get_json(SOILGRIDS_URL, params=params))


# --------------------------------------------------------------------------
# Regional defaults (last resort)
# --------------------------------------------------------------------------
_REGION_OF = {}
for _r, _states in {
    "northeast": "ME NH VT MA RI CT NY NJ PA DE MD DC",
    "southeast": "VA WV NC SC GA FL AL MS TN KY AR LA",
    "midwest": "OH IN IL MI WI MN IA MO",
    "plains": "ND SD NE KS OK TX",
    "southwest": "AZ NM NV UT",
    "mountain": "CO WY MT ID",
    "pacific": "CA HI",
    "northwest": "OR WA AK",
}.items():
    for _s in _states.split():
        _REGION_OF[_s] = _r

REGIONAL_DEFAULTS = {  # typical garden topsoil, broad strokes
    "northeast": dict(ph=5.9, organic_matter_pct=3.0, cec=10, sand_pct=40, silt_pct=42, clay_pct=18),
    "southeast": dict(ph=5.6, organic_matter_pct=1.8, cec=6, sand_pct=60, silt_pct=25, clay_pct=15),
    "midwest": dict(ph=6.5, organic_matter_pct=3.8, cec=18, sand_pct=20, silt_pct=58, clay_pct=22),
    "plains": dict(ph=7.2, organic_matter_pct=2.5, cec=17, sand_pct=30, silt_pct=48, clay_pct=22),
    "southwest": dict(ph=7.9, organic_matter_pct=0.9, cec=12, sand_pct=58, silt_pct=27, clay_pct=15),
    "mountain": dict(ph=7.4, organic_matter_pct=2.0, cec=15, sand_pct=42, silt_pct=38, clay_pct=20),
    "pacific": dict(ph=6.8, organic_matter_pct=2.2, cec=16, sand_pct=42, silt_pct=38, clay_pct=20),
    "northwest": dict(ph=5.9, organic_matter_pct=4.5, cec=16, sand_pct=30, silt_pct=52, clay_pct=18),
}


def regional_defaults(state: Optional[str]) -> dict[str, float]:
    return dict(REGIONAL_DEFAULTS[_REGION_OF.get((state or "").upper(), "northeast")])


# --------------------------------------------------------------------------
# Derived quantities
# --------------------------------------------------------------------------
def texture_class(sand: float, silt: float, clay: float) -> str:
    """USDA soil texture triangle (NRCS rules)."""
    tot = sand + silt + clay
    if tot <= 0:
        return "unknown"
    sand, silt, clay = (100 * x / tot for x in (sand, silt, clay))
    if silt + 1.5 * clay < 15:
        return "sand"
    if silt + 2 * clay < 30:
        return "loamy sand"
    if (7 <= clay < 20 and sand > 52) or (clay < 7 and silt < 50):
        return "sandy loam"
    if 7 <= clay < 27 and 28 <= silt < 50 and sand <= 52:
        return "loam"
    if (silt >= 50 and 12 <= clay < 27) or (50 <= silt < 80 and clay < 12):
        return "silt loam"
    if silt >= 80 and clay < 12:
        return "silt"
    if 20 <= clay < 35 and silt < 28 and sand > 45:
        return "sandy clay loam"
    if 27 <= clay < 40 and 20 < sand <= 45:
        return "clay loam"
    if 27 <= clay < 40 and sand <= 20:
        return "silty clay loam"
    if clay >= 35 and sand > 45:
        return "sandy clay"
    if clay >= 40 and silt >= 40:
        return "silty clay"
    return "clay"


def estimate_p_ppm(om_pct: float) -> float:
    """Very rough: P depends mostly on fertilizer history, which no map knows."""
    return max(10.0, min(80.0, 20.0 + 4.0 * om_pct))


def estimate_k_ppm(cec: float, clay_pct: float) -> float:
    """Clay and CEC hold potassium; sandy soils lose it."""
    return max(40.0, min(300.0, 50.0 + 4.0 * cec + 1.5 * clay_pct))


def n_mineralized(om_pct: float) -> float:
    """Free nitrogen released by organic matter over a season.
    Rule of thumb: ~20 lb N/acre per 1% OM  ->  lb N per 100 sq ft."""
    return round(om_pct * 20.0 / 435.6, 3)


def _status(key: str, value: float) -> Optional[str]:
    if key not in IDEAL:
        return None
    lo, hi = IDEAL[key]
    return "low" if value < lo else "high" if value > hi else "ok"


def _confidence(source: str, loc_source: str, spread_rel: float) -> tuple[str, float]:
    agreement = 1.0 / (1.0 + 2.5 * max(0.0, spread_rel))
    score = SOURCE_QUALITY.get(source, 0.3) * LOCATION_QUALITY.get(loc_source, 0.4) * agreement
    score = round(min(1.0, score), 2)
    return ("high" if score >= 0.65 else "medium" if score >= 0.4 else "low"), score


# --------------------------------------------------------------------------
# Main entry
# --------------------------------------------------------------------------
_SCALE = {"ph": 1.0}  # pH spread compared in absolute units; everything else relative


def _aggregate(samples: list[tuple[dict[str, float], float]], key: str):
    vals = [(s[key], w) for s, w in samples if key in s]
    if not vals:
        return None
    wsum = sum(w for _, w in vals)
    mean = sum(v * w for v, w in vals) / wsum
    lo, hi = min(v for v, _ in vals), max(v for v, _ in vals)
    if len(vals) > 1:
        var = sum(w * (v - mean) ** 2 for v, w in vals) / wsum
        sd = math.sqrt(var)
        spread = sd / _SCALE[key] if key in _SCALE else sd / max(abs(mean), 1e-6)
    else:
        spread = 0.25  # one point: no way to check agreement, so be modest
    return mean, lo, hi, spread


def research_soil(loc: Location, soil_test: Optional[dict[str, float]] = None,
                  max_workers: int = 7) -> SoilReport:
    radius = ring_radius_km(loc)
    pts = sample_points(loc.lat, loc.lon, radius)
    notes: list[str] = []
    sources: list[str] = []

    # 1) SSURGO across the whole ring, in parallel.
    def one(p):
        try:
            return fetch_ssurgo_point(p[0], p[1]), p[2]
        except SourceUnavailable:
            return None

    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        ssurgo = [r for r in ex.map(one, pts) if r and r[0]]
    if ssurgo:
        sources.append("USDA NRCS SSURGO (Soil Data Access)")

    # 2) SoilGrids at the centre: nitrogen always, everything else as backup.
    try:
        sg = fetch_soilgrids_point(loc.lat, loc.lon)
    except SourceUnavailable:
        sg = {}
    if sg:
        sources.append("ISRIC SoilGrids 2.0")

    regional = regional_defaults(loc.state)
    values: dict[str, SoilValue] = {}

    for key in ("ph", "organic_matter_pct", "cec", "sand_pct", "silt_pct", "clay_pct"):
        agg = _aggregate(ssurgo, key)
        if agg:
            mean, lo, hi, spread = agg
            src = "ssurgo"
        elif key in sg:
            mean, lo, hi, spread, src = sg[key], None, None, 0.25, "soilgrids"
        else:
            mean, lo, hi, spread, src = regional[key], None, None, 0.4, "regional"
        conf, score = _confidence(src, loc.source, spread)
        values[key] = SoilValue(key, round(mean, 2), UNITS[key], LABELS[key], src, conf, score,
                                round(lo, 2) if lo is not None else None,
                                round(hi, 2) if hi is not None else None,
                                IDEAL.get(key), _status(key, mean))

    if "total_n_gkg" in sg:
        conf, score = _confidence("soilgrids", loc.source, 0.25)
        values["total_n_gkg"] = SoilValue("total_n_gkg", round(sg["total_n_gkg"], 2), "g/kg",
                                          LABELS["total_n_gkg"], "soilgrids", conf, score)
    else:
        om = values["organic_matter_pct"].value
        values["total_n_gkg"] = SoilValue("total_n_gkg", round(om * 10 * 0.05, 2), "g/kg",
                                          LABELS["total_n_gkg"], "derived", "low", 0.3)

    om, cec, clay = (values[k].value for k in ("organic_matter_pct", "cec", "clay_pct"))
    for key, est in (("p_ppm", estimate_p_ppm(om)), ("k_ppm", estimate_k_ppm(cec, clay))):
        values[key] = SoilValue(key, round(est, 1), "ppm", LABELS[key], "derived", "low", 0.25,
                                ideal=IDEAL[key], status=_status(key, est))

    # 3) Real soil-test numbers beat every estimate.
    for key, v in (soil_test or {}).items():
        if key in values and v is not None:
            sv = values[key]
            values[key] = SoilValue(key, float(v), sv.unit, sv.label.replace(" (est.)", ""),
                                    "soil_test", "high", 1.0, ideal=sv.ideal,
                                    status=_status(key, float(v)))
    if soil_test:
        sources.append("Your soil test")

    if not ssurgo and not sg:
        sources.append("Regional averages (soil services unreachable)")
        notes.append("Soil services couldn't be reached, so these are broad regional averages. "
                     "Try again later or enter soil-test results.")
    if loc.source in ("ip", "fallback"):
        notes.append("Location is approximate, so soil was averaged over a wide area. "
                     "Enter your address or ZIP for a tighter estimate.")
    if not soil_test:
        notes.append("Phosphorus and potassium can't be mapped (they depend on what's been "
                     "added to your yard before). They're estimates until you enter a soil test.")
    notes.append("Survey maps describe native soil. Raised beds filled with bagged soil or "
                 "yards built on fill can differ a lot.")

    s, si, c = (values[k].value for k in ("sand_pct", "silt_pct", "clay_pct"))
    return SoilReport(
        values=values, texture_class=texture_class(s, si, c),
        n_mineralized_lb_per_100sqft=n_mineralized(values["organic_matter_pct"].value),
        radius_km=radius, points_sampled=len(pts), points_with_data=len(ssurgo),
        sources=sources, notes=notes,
    )
