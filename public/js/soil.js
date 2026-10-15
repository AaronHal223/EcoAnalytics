// Soil research engine.
//
// Nobody types in soil numbers. EcoAnalytics looks them up from published
// soil surveys for the garden's location, and is honest about how sure it is.
//
// Sources
//   * USDA NRCS Soil Data Access (SSURGO): the county soil surveys, mapped
//     field by field across the US. Primary source for pH, organic matter,
//     CEC and sand/silt/clay.
//   * ISRIC SoilGrids 2.0: a 250 m global soil map. Used for total nitrogen,
//     and for everything when SSURGO has no data at a point ("Urban land").
//     Fair-use limit ~5 calls/min, so only the centre point is queried.
//   * Regional defaults: last resort when both are unreachable.
//
// Averaging: one map point is a guess (the location may be off, soil changes
// over short distances), so the engine samples a ring of points sized to how
// precise the location is, and takes a weighted average (centre counts
// double). How much the points disagree lowers the confidence score.
//
// Plant-available phosphorus and potassium depend on what was spread on that
// exact yard; no map knows that. They are estimated and always labelled
// low-confidence until the user enters a real soil test.

import { getJSON, postForm, SourceUnavailable } from "./net.js";

const SDA_URL = "https://sdmdataaccess.sc.egov.usda.gov/Tabular/post.rest";
const SOILGRIDS_URL = "https://rest.isric.org/soilgrids/v2.0/properties/query";
// Same-origin routes that the host (render.yaml) forwards to the services above.
// Used only if the browser refuses the direct cross-origin call.
const SDA_PROXY = "proxy/sda";
const SOILGRIDS_PROXY = "proxy/soilgrids/properties/query";

const mode = { sda: "direct", soilgrids: "direct" };
const canProxy = () => /^https?:$/.test(globalThis.location?.protocol || "");

/** Tries the service directly, then through the host's proxy route; remembers what worked. */
async function directThenProxy(key, direct, proxied) {
  if (mode[key] === "proxy") return proxied();
  try {
    return await direct();
  } catch (e) {
    if (!(e instanceof SourceUnavailable) || !canProxy()) throw e;
    const r = await proxied();
    mode[key] = "proxy";
    return r;
  }
}
export const _resetModes = () => { mode.sda = "direct"; mode.soilgrids = "direct"; };
const TOP_CM = 30;

export const IDEAL = {
  ph: [6.2, 6.8], organic_matter_pct: [4.0, 8.0], cec: [10.0, 30.0],
  p_ppm: [25.0, 50.0], k_ppm: [100.0, 175.0],
};
const UNITS = { ph: "pH", organic_matter_pct: "%", clay_pct: "%", sand_pct: "%", silt_pct: "%",
  cec: "cmol/kg", total_n_gkg: "g/kg", p_ppm: "ppm", k_ppm: "ppm" };
const LABELS = { ph: "Soil pH", organic_matter_pct: "Organic matter", clay_pct: "Clay", sand_pct: "Sand",
  silt_pct: "Silt", cec: "Nutrient holding (CEC)", total_n_gkg: "Total nitrogen",
  p_ppm: "Phosphorus (est.)", k_ppm: "Potassium (est.)" };
const SOURCE_QUALITY = { soil_test: 1.0, ssurgo: 0.85, soilgrids: 0.65, derived: 0.35, regional: 0.3 };

// ---- Ring of sample points ---------------------------------------------------
export function ringRadiusKm(loc) {
  const p = loc.precision_km;
  return p <= 0.6 ? 0.3 : p <= 5 ? 2.0 : p <= 20 ? 6.0 : 8.0;
}

export function samplePoints(lat, lon, radiusKm, n = 6) {
  const pts = [[lat, lon, 2.0]];
  const dlat = radiusKm / 111.0;
  const dlon = radiusKm / (111.0 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  for (let i = 0; i < n; i++) {
    const a = 2 * Math.PI * i / n;
    pts.push([lat + dlat * Math.sin(a), lon + dlon * Math.cos(a), 1.0]);
  }
  return pts;
}

function locationQuality(loc) {
  const p = loc.precision_km;
  return p <= 0.6 ? 1.0 : p <= 5 ? 0.85 : p <= 20 ? 0.7 : 0.4;
}

// ---- USDA SSURGO ---------------------------------------------------------------
const SDA_COLS = ["comppct_r", "compname", "hzdept_r", "hzdepb_r", "ph1to1h2o_r", "om_r",
  "cec7_r", "sandtotal_r", "silttotal_r", "claytotal_r"];
const SDA_KEYS = { ph1to1h2o_r: "ph", om_r: "organic_matter_pct", cec7_r: "cec",
  sandtotal_r: "sand_pct", silttotal_r: "silt_pct", claytotal_r: "clay_pct" };

export function sdaQuery(lat, lon) {
  return "SELECT c.comppct_r, c.compname, ch.hzdept_r, ch.hzdepb_r, ch.ph1to1h2o_r, ch.om_r, " +
    "ch.cec7_r, ch.sandtotal_r, ch.silttotal_r, ch.claytotal_r " +
    "FROM mapunit mu INNER JOIN component c ON c.mukey = mu.mukey " +
    "INNER JOIN chorizon ch ON ch.cokey = c.cokey " +
    "WHERE mu.mukey IN (SELECT * FROM SDA_Get_Mukey_from_intersection_with_WktWgs84(" +
    `'point(${lon.toFixed(6)} ${lat.toFixed(6)})')) AND ch.hzdept_r < ${TOP_CM}`;
}

const num = v => (v === null || v === undefined || v === "" || Number.isNaN(+v)) ? null : +v;

/** Depth-weighted over 0-30 cm, then weighted by each component's share of the map unit. */
export function parseSdaRows(rows) {
  rows = rows || [];
  if (rows.length && String(rows[0][0]).toLowerCase() === "comppct_r") rows = rows.slice(1);
  const sums = {}, w = {};
  for (const row of rows) {
    const r = Object.fromEntries(SDA_COLS.map((c, i) => [c, row[i]]));
    const pct = num(r.comppct_r), top = num(r.hzdept_r), bot = num(r.hzdepb_r);
    if (!pct || top === null || bot === null) continue;
    const thick = Math.max(0, Math.min(bot, TOP_CM) - Math.max(top, 0));
    if (thick <= 0) continue;
    for (const [col, key] of Object.entries(SDA_KEYS)) {
      const v = num(r[col]);
      if (v === null) continue;
      sums[key] = (sums[key] || 0) + v * pct * thick;
      w[key] = (w[key] || 0) + pct * thick;
    }
  }
  return Object.fromEntries(Object.keys(sums).filter(k => w[k] > 0).map(k => [k, sums[k] / w[k]]));
}

export async function fetchSsurgoPoint(lat, lon) {
  const body = { query: sdaQuery(lat, lon), format: "JSON+COLUMNNAME" };
  const d = await directThenProxy("sda", () => postForm(SDA_URL, body), () => postForm(SDA_PROXY, body));
  return parseSdaRows(d?.Table);
}

// ---- ISRIC SoilGrids ------------------------------------------------------------
const SG_KEYS = { phh2o: "ph", soc: "soc_gkg", nitrogen: "total_n_gkg", clay: "clay_pct",
  sand: "sand_pct", silt: "silt_pct", cec: "cec" };
const SG_DIVISOR = { phh2o: 10, soc: 10, nitrogen: 100, clay: 10, sand: 10, silt: 10, cec: 10 };
const SG_DEPTHS = { "0-5cm": 5, "5-15cm": 10, "15-30cm": 15 };

export function parseSoilgrids(data) {
  const out = {};
  for (const layer of data?.properties?.layers || []) {
    if (!(layer.name in SG_KEYS)) continue;
    const div = layer.unit_measure?.d_factor || SG_DIVISOR[layer.name];
    let tot = 0, ws = 0;
    for (const d of layer.depths || []) {
      const mean = d.values?.mean, thick = SG_DEPTHS[d.label];
      if (mean === null || mean === undefined || !thick) continue;
      tot += (mean / div) * thick;
      ws += thick;
    }
    if (ws) out[SG_KEYS[layer.name]] = tot / ws;
  }
  if ("soc_gkg" in out) {
    out.organic_matter_pct = out.soc_gkg * 1.72 / 10;  // Van Bemmelen: OM ~ 1.72 x organic carbon
    delete out.soc_gkg;
  }
  return out;
}

export async function fetchSoilgridsPoint(lat, lon) {
  const params = { lon: lon.toFixed(5), lat: lat.toFixed(5), value: "mean",
    property: Object.keys(SG_KEYS), depth: Object.keys(SG_DEPTHS) };
  return parseSoilgrids(await directThenProxy("soilgrids",
    () => getJSON(SOILGRIDS_URL, params), () => getJSON(SOILGRIDS_PROXY, params)));
}

// ---- Regional defaults (last resort) ----------------------------------------------
const REGION_OF = {};
for (const [r, states] of Object.entries({
  northeast: "ME NH VT MA RI CT NY NJ PA DE MD DC", southeast: "VA WV NC SC GA FL AL MS TN KY AR LA",
  midwest: "OH IN IL MI WI MN IA MO", plains: "ND SD NE KS OK TX", southwest: "AZ NM NV UT",
  mountain: "CO WY MT ID", pacific: "CA HI", northwest: "OR WA AK",
})) for (const s of states.split(" ")) REGION_OF[s] = r;

const REGIONAL = {
  northeast: { ph: 5.9, organic_matter_pct: 3.0, cec: 10, sand_pct: 40, silt_pct: 42, clay_pct: 18 },
  southeast: { ph: 5.6, organic_matter_pct: 1.8, cec: 6, sand_pct: 60, silt_pct: 25, clay_pct: 15 },
  midwest: { ph: 6.5, organic_matter_pct: 3.8, cec: 18, sand_pct: 20, silt_pct: 58, clay_pct: 22 },
  plains: { ph: 7.2, organic_matter_pct: 2.5, cec: 17, sand_pct: 30, silt_pct: 48, clay_pct: 22 },
  southwest: { ph: 7.9, organic_matter_pct: 0.9, cec: 12, sand_pct: 58, silt_pct: 27, clay_pct: 15 },
  mountain: { ph: 7.4, organic_matter_pct: 2.0, cec: 15, sand_pct: 42, silt_pct: 38, clay_pct: 20 },
  pacific: { ph: 6.8, organic_matter_pct: 2.2, cec: 16, sand_pct: 42, silt_pct: 38, clay_pct: 20 },
  northwest: { ph: 5.9, organic_matter_pct: 4.5, cec: 16, sand_pct: 30, silt_pct: 52, clay_pct: 18 },
};
export const regionalDefaults = st => ({ ...REGIONAL[REGION_OF[(st || "").toUpperCase()] || "northeast"] });

// ---- Derived quantities -----------------------------------------------------------
/** USDA soil texture triangle (NRCS rules). */
export function textureClass(sand, silt, clay) {
  const t = sand + silt + clay;
  if (t <= 0) return "unknown";
  [sand, silt, clay] = [sand, silt, clay].map(x => 100 * x / t);
  if (silt + 1.5 * clay < 15) return "sand";
  if (silt + 2 * clay < 30) return "loamy sand";
  if ((clay >= 7 && clay < 20 && sand > 52) || (clay < 7 && silt < 50)) return "sandy loam";
  if (clay >= 7 && clay < 27 && silt >= 28 && silt < 50 && sand <= 52) return "loam";
  if ((silt >= 50 && clay >= 12 && clay < 27) || (silt >= 50 && silt < 80 && clay < 12)) return "silt loam";
  if (silt >= 80 && clay < 12) return "silt";
  if (clay >= 20 && clay < 35 && silt < 28 && sand > 45) return "sandy clay loam";
  if (clay >= 27 && clay < 40 && sand > 20 && sand <= 45) return "clay loam";
  if (clay >= 27 && clay < 40 && sand <= 20) return "silty clay loam";
  if (clay >= 35 && sand > 45) return "sandy clay";
  if (clay >= 40 && silt >= 40) return "silty clay";
  return "clay";
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const estimatePppm = om => clamp(20 + 4 * om, 10, 80);
export const estimateKppm = (cec, clay) => clamp(50 + 4 * cec + 1.5 * clay, 40, 300);
/** ~20 lb N/acre per 1% organic matter per season -> lb N per 100 sq ft. */
export const nMineralized = om => Math.round(om * 20 / 435.6 * 1000) / 1000;

function status(key, v) {
  if (!IDEAL[key]) return null;
  const [lo, hi] = IDEAL[key];
  return v < lo ? "low" : v > hi ? "high" : "ok";
}

function confidence(source, loc, spreadRel) {
  const agreement = 1 / (1 + 2.5 * Math.max(0, spreadRel));
  const score = Math.round(Math.min(1, (SOURCE_QUALITY[source] ?? 0.3) * locationQuality(loc) * agreement) * 100) / 100;
  return [score >= 0.65 ? "high" : score >= 0.4 ? "medium" : "low", score];
}

function aggregate(samples, key) {
  const vals = samples.filter(([s]) => key in s).map(([s, w]) => [s[key], w]);
  if (!vals.length) return null;
  const ws = vals.reduce((a, [, w]) => a + w, 0);
  const mean = vals.reduce((a, [v, w]) => a + v * w, 0) / ws;
  const lo = Math.min(...vals.map(([v]) => v)), hi = Math.max(...vals.map(([v]) => v));
  let spread = 0.25;  // a single point can't be cross-checked
  if (vals.length > 1) {
    const sd = Math.sqrt(vals.reduce((a, [v, w]) => a + w * (v - mean) ** 2, 0) / ws);
    spread = key === "ph" ? sd : sd / Math.max(Math.abs(mean), 1e-6);
  }
  return { mean, lo, hi, spread };
}

const r2 = x => (x === null || x === undefined) ? null : Math.round(x * 100) / 100;

function soilValue(key, value, source, conf, score, extra = {}) {
  return { key, value: r2(value), unit: UNITS[key], label: LABELS[key], source,
    confidence: conf, confidence_score: score, low: extra.low ?? null, high: extra.high ?? null,
    ideal: IDEAL[key] || null, status: status(key, value) };
}

/** Researches the soil at `loc`. `soilTest` values (if any) override estimates. */
export async function researchSoil(loc, soilTest = null) {
  return applySoilTest(await researchSoilBase(loc), soilTest);
}

const P_K_NOTE = "Phosphorus and potassium can't be mapped (they depend on what's been added to your yard before). They're estimates until you enter a soil test.";

/** Returns a copy of `report` with real soil-test numbers replacing the estimates. */
export function applySoilTest(report, soilTest) {
  const test = Object.fromEntries(Object.entries(soilTest || {})
    .filter(([k, v]) => k in report.values && v !== null && v !== "" && Number.isFinite(+v)));
  if (!Object.keys(test).length) return report;
  const values = { ...report.values };
  for (const [k, v] of Object.entries(test)) {
    values[k] = { ...soilValue(k, +v, "soil_test", "high", 1.0), label: LABELS[k].replace(" (est.)", "") };
  }
  const notes = report.notes.filter(n => !(n === P_K_NOTE && "p_ppm" in test && "k_ppm" in test));
  return {
    ...report, values, notes, sources: [...report.sources, "Your soil test"],
    n_mineralized_lb_per_100sqft: nMineralized(values.organic_matter_pct.value),
  };
}

/** The lookup itself (network), without any soil-test overrides. Cacheable. */
export async function researchSoilBase(loc) {
  const radius = ringRadiusKm(loc);
  const pts = samplePoints(loc.lat, loc.lon, radius);
  const notes = [], sources = [];

  const [ssurgoRaw, sg] = await Promise.all([
    Promise.all(pts.map(async ([la, lo, w]) => {
      try { const v = await fetchSsurgoPoint(la, lo); return Object.keys(v).length ? [v, w] : null; }
      catch (e) { if (e instanceof SourceUnavailable) return null; throw e; }
    })),
    fetchSoilgridsPoint(loc.lat, loc.lon).catch(() => ({})),
  ]);
  const ssurgo = ssurgoRaw.filter(Boolean);
  if (ssurgo.length) sources.push("USDA NRCS SSURGO (Soil Data Access)");
  if (Object.keys(sg).length) sources.push("ISRIC SoilGrids 2.0");

  const regional = regionalDefaults(loc.state);
  const values = {};
  for (const key of ["ph", "organic_matter_pct", "cec", "sand_pct", "silt_pct", "clay_pct"]) {
    const agg = aggregate(ssurgo, key);
    let mean, lo = null, hi = null, spread, src;
    if (agg) ({ mean, lo, hi, spread } = agg), src = "ssurgo";
    else if (key in sg) [mean, spread, src] = [sg[key], 0.25, "soilgrids"];
    else [mean, spread, src] = [regional[key], 0.4, "regional"];
    const [c, s] = confidence(src, loc, spread);
    values[key] = soilValue(key, mean, src, c, s, { low: r2(lo), high: r2(hi) });
  }

  if ("total_n_gkg" in sg) {
    const [c, s] = confidence("soilgrids", loc, 0.25);
    values.total_n_gkg = soilValue("total_n_gkg", sg.total_n_gkg, "soilgrids", c, s);
  } else {
    values.total_n_gkg = soilValue("total_n_gkg", values.organic_matter_pct.value * 10 * 0.05, "derived", "low", 0.3);
  }
  const om = values.organic_matter_pct.value, cec = values.cec.value, clay = values.clay_pct.value;
  values.p_ppm = soilValue("p_ppm", Math.round(estimatePppm(om) * 10) / 10, "derived", "low", 0.25);
  values.k_ppm = soilValue("k_ppm", Math.round(estimateKppm(cec, clay) * 10) / 10, "derived", "low", 0.25);

  if (!ssurgo.length && !Object.keys(sg).length) {
    sources.push("Regional averages (soil services unreachable)");
    notes.push("Soil services couldn't be reached, so these are broad regional averages. Try again later or enter soil-test results.");
  }
  if (loc.precision_km > 5) notes.push("Location is approximate, so soil was averaged over a wide area. Enter your address or ZIP for a tighter estimate.");
  notes.push(P_K_NOTE);
  notes.push("Survey maps describe native soil. Raised beds filled with bagged soil or yards built on fill can differ a lot.");

  return {
    values, texture_class: textureClass(values.sand_pct.value, values.silt_pct.value, values.clay_pct.value),
    n_mineralized_lb_per_100sqft: nMineralized(values.organic_matter_pct.value),
    radius_km: radius, points_sampled: pts.length, points_with_data: ssurgo.length, sources, notes,
  };
}
