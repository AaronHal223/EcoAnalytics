"""The money side of a backyard garden.

Four tools, all driven by the researched soil (soil.py) and the local
weather history (climate.py):

1. Crop value ranking:  which crops earn the most dollars per square foot
   in *this* yard, after seed, water and fertilizer.
2. Water cost:          month-by-month irrigation the garden needs beyond
   rainfall, in gallons and dollars on the user's water rate.
3. Fertilizer optimizer: the cheapest set of garden-center bags that covers
   the plan's N-P-K needs (a mixed-integer program, because a backyard
   grower buys whole bags, not "2.3 lb of bone meal"), plus lime/sulfur for
   pH and compost for organic matter.
4. Garden ROI:          harvest value vs. every cost, with payback time.

All prices and yields live in data/*.json so users can edit them.
"""
from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Optional

import numpy as np
from scipy.optimize import Bounds, LinearConstraint, milp

from .climate import MONTHS, Climate
from .soil import SoilReport

DATA = Path(__file__).parent / "data"
GAL_PER_SQFT_INCH = 0.623

# lb of available N per 100 sq ft per planting (extension guidance for vegetables)
N_RATE = {"low": 0.08, "med": 0.25, "high": 0.35}
# lb P2O5 / K2O per 100 sq ft per season, by soil-test status
P_RATE = {"low": 0.25, "ok": 0.10, "high": 0.0}
K_RATE = {"low": 0.30, "ok": 0.15, "high": 0.0}

IRRIGATION_EFFICIENCY = {"drip": 0.90, "hose": 0.75, "sprinkler": 0.65}
DEFAULT_WATER_RATE = 6.00  # $ per 1,000 gallons; edit to match your bill


@lru_cache(maxsize=1)
def load_crops() -> dict[str, dict]:
    return {c["id"]: c for c in json.loads((DATA / "crops.json").read_text())["crops"]}


@lru_cache(maxsize=1)
def load_amendments() -> dict:
    return json.loads((DATA / "amendments.json").read_text())


# --------------------------------------------------------------------------
# Season fit
# --------------------------------------------------------------------------
@dataclass
class SeasonFit:
    plantings: int
    fraction: float   # 0-1 share of a full harvest the season supports
    note: str


def season_fit(crop: dict, cl: Climate) -> SeasonFit:
    days = crop["days"]
    if crop["season"] == "warm":
        ffd = cl.frost_free_days
        gdd_frac = min(1.0, cl.season_gdd50 / crop.get("gdd50", 1000))
        day_frac = min(1.0, max(0.0, (ffd - 14) / (days + 30)))
        frac = min(gdd_frac, day_frac)
        plantings = 1
        while plantings < crop["max_plantings"] and ffd >= (plantings + 1) * days + 30:
            plantings += 1
        if frac < 0.6:
            note = "Season is too short or too cool for a full crop"
        elif frac < 1.0:
            note = "Partial harvest: season is a bit short"
        else:
            note = f"{plantings} planting{'s' if plantings > 1 else ''} fit your frost-free season"
        return SeasonFit(plantings, round(frac, 2), note)

    cool = cl.cool_growing_days
    if crop.get("overwinter"):
        cold_winter = any(t < 45 for t in cl.monthly_tmean_f if not math.isnan(t))
        return SeasonFit(1, 1.0 if cold_winter else 0.5,
                         "Plant in fall, harvest next summer" if cold_winter
                         else "Winters may be too warm for full bulbs")
    plantings = min(crop["max_plantings"], cool // days)
    if plantings >= 1:
        return SeasonFit(plantings, 1.0,
                         f"{plantings} planting{'s' if plantings > 1 else ''} across your cool seasons")
    return SeasonFit(1, round(cool / days, 2), "Cool season is short; expect a partial harvest")


def ph_factor(crop: dict, ph: float) -> float:
    """Yield multiplier for soil pH. The first 0.2 units outside a crop's range
    cost nothing (that's within map/test error); after that, -25% per unit."""
    lo, hi = crop["ph"]
    off = (lo - ph) if ph < lo else (ph - hi) if ph > hi else 0.0
    return round(max(0.5, 1.0 - 0.25 * max(0.0, off - 0.2)), 2)


# --------------------------------------------------------------------------
# Water
# --------------------------------------------------------------------------
def effective_rain_factor(texture: str) -> float:
    """Share of rainfall the root zone actually keeps."""
    if texture in ("sand", "loamy sand"):
        return 0.60
    if texture in ("clay", "silty clay", "sandy clay"):
        return 0.70  # more runoff
    return 0.75


def occupancy(crop: dict, fit: SeasonFit, cl: Climate) -> float:
    """Share of its season window a bed of this crop is actually planted."""
    if crop["season"] == "warm":
        # Warm crops go in after the last frost and keep producing (or get
        # succession-planted) until the first one: the bed is busy all season.
        return 1.0
    if crop.get("overwinter"):
        return 1.0
    return min(1.0, fit.plantings * crop["days"] / max(cl.cool_growing_days, 1))


def monthly_irrigation_in(crop: dict, fit: SeasonFit, cl: Climate, texture: str) -> list[float]:
    """Inches of irrigation per month a bed of this crop needs beyond rain."""
    eff = effective_rain_factor(texture)
    active = cl.monthly_active_frac_warm if crop["season"] == "warm" else cl.monthly_active_frac_cool
    occ = occupancy(crop, fit, cl)
    out = []
    for m in range(12):
        deficit = max(0.0, crop["kc"] * cl.monthly_et0_in[m] - eff * cl.monthly_precip_in[m])
        out.append(deficit * active[m] * occ)
    return out


def gallons(inches: float, sqft: float, method: str = "hose") -> float:
    return inches * sqft * GAL_PER_SQFT_INCH / IRRIGATION_EFFICIENCY.get(method, 0.75)


# --------------------------------------------------------------------------
# 1) Crop value ranking
# --------------------------------------------------------------------------
def cheapest_n_price(organic_only: bool) -> float:
    """$ per lb of *available* N from the cheapest single product."""
    best = math.inf
    for f in load_amendments()["fertilizers"]:
        if organic_only and not f["organic"]:
            continue
        n_lb = f["bag_lb"] * f["n"] / 100 * f["n_avail"]
        if n_lb > 0:
            best = min(best, f["bag_price"] / n_lb)
    return best


@dataclass
class CropRank:
    id: str
    name: str
    season: str
    plantings: int
    season_fraction: float
    soil_fit: float
    yield_lb_per_sqft: float
    value_per_sqft: float
    seed_cost_per_sqft: float
    water_gal_per_sqft: float
    water_cost_per_sqft: float
    fertilizer_cost_per_sqft: float
    net_per_sqft: float
    value_per_100_gal: Optional[float]
    note: str
    soil_note: str


def rank_crops(soil: SoilReport, cl: Climate, water_rate: float = DEFAULT_WATER_RATE,
               method: str = "hose", organic_only: bool = False,
               price_overrides: Optional[dict[str, float]] = None) -> list[CropRank]:
    ph = soil.get("ph")
    n_free = soil.n_mineralized_lb_per_100sqft / 100  # lb N per sq ft
    n_price = cheapest_n_price(organic_only)
    out = []
    for c in load_crops().values():
        price = (price_overrides or {}).get(c["id"], c["price_per_lb"])
        fit = season_fit(c, cl)
        pf = ph_factor(c, ph)
        y = c["yield_lb_per_sqft"] * fit.plantings * fit.fraction * pf
        value = y * price
        seed = c["cost_per_sqft"] * fit.plantings
        gal = gallons(sum(monthly_irrigation_in(c, fit, cl, soil.texture_class)), 1.0, method)
        water = gal / 1000 * water_rate
        n_need = max(0.0, N_RATE[c["n_demand"]] / 100 * fit.plantings - 0.5 * n_free)
        fert = n_need * n_price
        net = value - seed - water - fert
        lo, hi = c["ph"]
        soil_note = ("Soil pH suits it" if pf == 1.0 else
                     f"Prefers pH {lo}-{hi}; your soil is {ph:.1f}")
        out.append(CropRank(
            id=c["id"], name=c["name"], season=c["season"], plantings=fit.plantings,
            season_fraction=fit.fraction, soil_fit=pf, yield_lb_per_sqft=round(y, 2),
            value_per_sqft=round(value, 2), seed_cost_per_sqft=round(seed, 2),
            water_gal_per_sqft=round(gal, 1), water_cost_per_sqft=round(water, 3),
            fertilizer_cost_per_sqft=round(fert, 3), net_per_sqft=round(net, 2),
            value_per_100_gal=round(value / gal * 100, 2) if gal > 0.05 else None,
            note=fit.note, soil_note=soil_note,
        ))
    out.sort(key=lambda r: r.net_per_sqft, reverse=True)
    return out


# --------------------------------------------------------------------------
# 2) Water cost tracking
# --------------------------------------------------------------------------
def water_plan(plan: list[dict], soil: SoilReport, cl: Climate,
               water_rate: float = DEFAULT_WATER_RATE, method: str = "hose") -> dict:
    crops = load_crops()
    monthly_gal = [0.0] * 12
    by_crop = []
    for item in plan:
        c = crops[item["crop"]]
        fit = season_fit(c, cl)
        inches = monthly_irrigation_in(c, fit, cl, soil.texture_class)
        gal = [gallons(i, item["sqft"], method) for i in inches]
        monthly_gal = [a + b for a, b in zip(monthly_gal, gal)]
        by_crop.append({"crop": c["name"], "sqft": item["sqft"], "gallons": round(sum(gal)),
                        "cost": round(sum(gal) / 1000 * water_rate, 2)})
    total = sum(monthly_gal)
    total_sqft = sum(i["sqft"] for i in plan) or 1
    return {
        "months": MONTHS,
        "monthly_gallons": [round(g) for g in monthly_gal],
        "monthly_cost": [round(g / 1000 * water_rate, 2) for g in monthly_gal],
        "monthly_rain_in": cl.monthly_precip_in,
        "monthly_et0_in": cl.monthly_et0_in,
        "total_gallons": round(total),
        "total_cost": round(total / 1000 * water_rate, 2),
        "rain_supplied_gallons": round(sum(
            min(cl.monthly_precip_in[m] * effective_rain_factor(soil.texture_class),
                0.85 * cl.monthly_et0_in[m]) * max(cl.monthly_active_frac_warm[m], cl.monthly_active_frac_cool[m])
            for m in range(12)) * total_sqft * GAL_PER_SQFT_INCH),
        "by_crop": by_crop,
        "water_rate": water_rate,
        "method": method,
        "drip_savings": round((total / 1000 * water_rate) * (1 - IRRIGATION_EFFICIENCY.get(method, 0.75)
                                                             / IRRIGATION_EFFICIENCY["drip"]), 2)
        if method != "drip" else 0.0,
    }


# --------------------------------------------------------------------------
# 3) Fertilizer optimizer
# --------------------------------------------------------------------------
@dataclass
class Purchase:
    name: str
    bags: int
    bag_lb: float
    lbs_to_apply: float
    upfront_cost: float
    season_cost: float          # value of what's actually used this season
    per_100_sqft_lb: float
    leftover_lb: float


@dataclass
class FertilizerPlan:
    area_sqft: float
    need_lb: dict[str, float]          # N, P2O5, K2O after credits
    supplied_lb: dict[str, float]
    credits_lb: dict[str, float]       # free N from organic matter, compost
    purchases: list[Purchase]
    upfront_cost: float
    season_cost: float
    ph_action: Optional[dict]
    compost_action: Optional[dict]
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def ph_adjustment(soil: SoilReport, area_sqft: float) -> Optional[dict]:
    ph, cec = soil.get("ph"), soil.get("cec")
    am = load_amendments()["ph"]
    if ph < 6.0:
        per_unit = min(10.0, max(2.5, 0.4 * cec + 2.0))  # lb lime / 100 sq ft / pH unit
        rate = min(10.0, per_unit * (6.5 - ph))
        p = am["lime"]
        verb, target = "raise", 6.5
    elif ph > 7.3:
        per_unit = min(2.5, max(0.5, 0.1 * cec + 0.2))   # lb sulfur / 100 sq ft / pH unit
        rate = min(2.0, per_unit * (ph - 6.8))
        p = am["sulfur"]
        verb, target = "lower", 6.8
    else:
        return None
    lbs = rate * area_sqft / 100
    bags = max(1, math.ceil(lbs / p["bag_lb"]))
    return {
        "product": p["name"], "action": f"{verb} pH from {ph:.1f} toward {target}",
        "lb_per_100_sqft": round(rate, 1), "lbs": round(lbs, 1), "bags": bags,
        "upfront_cost": round(bags * p["bag_price"], 2),
        # One application lasts roughly three seasons.
        "season_cost": round(lbs * p["bag_price"] / p["bag_lb"] / 3, 2),
        "note": "Mix into the top 6 in. Lime works slowly; apply in fall if you can."
        if verb == "raise" else "Sulfur acts over months; re-check pH next year before adding more.",
    }


def compost_adjustment(soil: SoilReport, area_sqft: float) -> Optional[dict]:
    om = soil.get("organic_matter_pct")
    if om >= 4.0:
        return None
    c = load_amendments()["compost"]
    inches = min(2.0, max(0.5, math.ceil((4.0 - om) / 1.5 * 2) / 2))  # ~1.5% OM per inch, to nearest 0.5
    cuft = area_sqft * inches / 12
    bags = math.ceil(cuft / c["bag_cuft"])
    n_credit = cuft * c["lb_per_cuft"] * c["n_pct"] / 100 * c["n_avail"]
    return {
        "product": c["name"], "inches": inches, "cubic_feet": round(cuft, 1), "bags": bags,
        "upfront_cost": round(bags * c["bag_price"], 2), "season_cost": round(bags * c["bag_price"], 2),
        "n_credit_lb": round(n_credit, 3),
        "note": f"Organic matter is {om:.1f}% (aim for 4-8%). Bulk compost by the yard is usually "
                "half the price of bags for beds over ~50 sq ft.",
    }


def plan_needs(plan: list[dict], soil: SoilReport, cl: Climate) -> tuple[float, float, float, float]:
    crops = load_crops()
    area = sum(i["sqft"] for i in plan)
    n = sum(N_RATE[crops[i["crop"]]["n_demand"]] * season_fit(crops[i["crop"]], cl).plantings
            * i["sqft"] / 100 for i in plan)
    p_status = soil.values["p_ppm"].status or "ok"
    k_status = soil.values["k_ppm"].status or "ok"
    p = P_RATE[p_status] * area / 100
    k = K_RATE[k_status] * area / 100
    return area, n, p, k


def optimize_fertilizer(plan: list[dict], soil: SoilReport, cl: Climate,
                        organic_only: bool = False) -> FertilizerPlan:
    area, n_gross, p_req, k_req = plan_needs(plan, soil, cl)
    compost = compost_adjustment(soil, area)
    om_credit = min(0.5 * n_gross, soil.n_mineralized_lb_per_100sqft * area / 100)
    compost_credit = compost["n_credit_lb"] if compost else 0.0
    n_req = max(0.0, n_gross - om_credit - compost_credit)

    ferts = [f for f in load_amendments()["fertilizers"] if not organic_only or f["organic"]]
    k = len(ferts)
    N = np.array([f["n"] / 100 * f["n_avail"] for f in ferts])
    P = np.array([f["p"] / 100 for f in ferts])
    K = np.array([f["k"] / 100 for f in ferts])
    per_lb = np.array([f["bag_price"] / f["bag_lb"] for f in ferts])
    bag_lb = np.array([f["bag_lb"] for f in ferts], dtype=float)
    bag_price = np.array([f["bag_price"] for f in ferts])

    purchases: list[Purchase] = []
    supplied = {"N": 0.0, "P2O5": 0.0, "K2O": 0.0}
    notes: list[str] = []

    if n_req + p_req + k_req > 1e-6:
        # Variables: [lbs applied x_0..x_k-1, bags bought b_0..b_k-1 (integer)]
        # Minimise money spent at the store, tie-break on product actually used.
        c = np.concatenate([1e-3 * per_lb, bag_price])
        up = lambda base, slack: base + slack * area / 100
        rows, lo, hi = [], [], []

        def add(row_x, l, h):
            rows.append(np.concatenate([row_x, np.zeros(k)]))
            lo.append(l)
            hi.append(h)

        add(N, n_req, up(n_req * 1.5, 0.05))
        add(P, p_req, up(p_req, 0.15))
        add(K, k_req, up(k_req, 0.30))
        for i in range(k):  # x_i <= bag_lb_i * b_i
            row = np.zeros(2 * k)
            row[i], row[k + i] = 1.0, -bag_lb[i]
            rows.append(row)
            lo.append(-np.inf)
            hi.append(0.0)
        cons = LinearConstraint(np.array(rows), np.array(lo), np.array(hi))
        integrality = np.concatenate([np.zeros(k), np.ones(k)])
        bounds = Bounds(np.zeros(2 * k), np.concatenate([np.full(k, np.inf), np.full(k, 20)]))
        res = milp(c, constraints=cons, integrality=integrality, bounds=bounds)
        if not res.success:
            # Upper limits too tight for the available products: keep only minimums.
            for j in range(3):
                hi[j] = np.inf
            res = milp(c, constraints=LinearConstraint(np.array(rows), np.array(lo), np.array(hi)),
                       integrality=integrality, bounds=bounds)
            notes.append("No product mix hit every target exactly; some nutrients are slightly over.")
        if res.success:
            x, b = res.x[:k], np.round(res.x[k:])
            for i, f in enumerate(ferts):
                if x[i] > 1e-4:
                    purchases.append(Purchase(
                        name=f["name"], bags=int(b[i]), bag_lb=f["bag_lb"],
                        lbs_to_apply=round(float(x[i]), 2),
                        upfront_cost=round(float(b[i] * bag_price[i]), 2),
                        season_cost=round(float(x[i] * per_lb[i]), 2),
                        per_100_sqft_lb=round(float(x[i]) / area * 100, 2),
                        leftover_lb=round(float(b[i] * bag_lb[i] - x[i]), 1)))
            supplied = {"N": round(float(N @ x), 3), "P2O5": round(float(P @ x), 3),
                        "K2O": round(float(K @ x), 3)}
    else:
        notes.append("Your soil and compost cover this plan's nutrient needs; no fertilizer to buy.")

    ph = ph_adjustment(soil, area)
    if soil.values["p_ppm"].source != "soil_test":
        notes.append("Phosphorus and potassium targets use estimated soil levels. A home or "
                     "extension soil test would let this plan skip anything you don't need.")
    upfront = sum(p.upfront_cost for p in purchases) + (ph or {}).get("upfront_cost", 0) \
        + (compost or {}).get("upfront_cost", 0)
    season = sum(p.season_cost for p in purchases) + (ph or {}).get("season_cost", 0) \
        + (compost or {}).get("season_cost", 0)
    return FertilizerPlan(
        area_sqft=area,
        need_lb={"N": round(n_req, 3), "P2O5": round(p_req, 3), "K2O": round(k_req, 3)},
        supplied_lb=supplied,
        credits_lb={"N_from_organic_matter": round(om_credit, 3), "N_from_compost": round(compost_credit, 3)},
        purchases=purchases, upfront_cost=round(upfront, 2), season_cost=round(season, 2),
        ph_action=ph, compost_action=compost, notes=notes,
    )


# --------------------------------------------------------------------------
# 4) Garden ROI
# --------------------------------------------------------------------------
def garden_roi(plan: list[dict], soil: SoilReport, cl: Climate,
               water_rate: float = DEFAULT_WATER_RATE, method: str = "hose",
               setup_cost: float = 0.0, setup_years: int = 5, organic_only: bool = False,
               price_overrides: Optional[dict[str, float]] = None) -> dict:
    crops = load_crops()
    water = water_plan(plan, soil, cl, water_rate, method)
    fert = optimize_fertilizer(plan, soil, cl, organic_only)
    rows = []
    harvest_lb = harvest_value = seeds = 0.0
    for item in plan:
        c = crops[item["crop"]]
        price = (price_overrides or {}).get(c["id"], c["price_per_lb"])
        fit = season_fit(c, cl)
        pf = ph_factor(c, soil.get("ph"))
        y = c["yield_lb_per_sqft"] * fit.plantings * fit.fraction * pf * item["sqft"]
        s = c["cost_per_sqft"] * fit.plantings * item["sqft"]
        rows.append({"crop": c["name"], "sqft": item["sqft"], "harvest_lb": round(y, 1),
                     "value": round(y * price, 2), "seed_cost": round(s, 2)})
        harvest_lb += y
        harvest_value += y * price
        seeds += s

    setup_per_year = setup_cost / max(1, setup_years)
    running = seeds + water["total_cost"] + fert.season_cost
    total_cost = running + setup_per_year
    net = harvest_value - total_cost
    yearly_gain = harvest_value - running
    return {
        "rows": rows,
        "harvest_lb": round(harvest_lb, 1),
        "harvest_value": round(harvest_value, 2),
        "costs": {"seeds_and_plants": round(seeds, 2), "water": water["total_cost"],
                  "soil_and_fertilizer": fert.season_cost, "setup_per_year": round(setup_per_year, 2)},
        "upfront_store_cost": round(fert.upfront_cost + seeds + setup_cost, 2),
        "total_cost": round(total_cost, 2),
        "net": round(net, 2),
        "roi_pct": round(net / total_cost * 100, 1) if total_cost > 0 else None,
        "payback_seasons": round(setup_cost / yearly_gain, 1) if setup_cost > 0 and yearly_gain > 0 else None,
        "cost_per_lb": round(total_cost / harvest_lb, 2) if harvest_lb > 0 else None,
        "water": water,
        "fertilizer": fert.to_dict(),
    }
