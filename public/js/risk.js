// Good year, bad year.
//
// A single "expected" number hides the thing every grower actually lives
// through: some summers are cool and wet, some springs freeze late. Here we
// replay the plan through each of the last 15 real growing seasons at the
// garden's location (Open-Meteo's free historical archive), using exactly the
// same yield, water and fertilizer models as the rest of the app. That turns
// every crop's return into a range, and the garden into odds:
// "your plan would have paid off in 13 of the last 15 seasons".
//
// The same numbers drive "Plan it for me", which fills a given space with the
// crops that pay best in a typical year *and* hold up in a bad one, capped at a
// quarter of the space each so one crop's bad year can't sink the garden.

import { getJSON } from "./net.js";
import { summarize } from "./climate.js";
import { rankCrops, gardenROI, CROP_BY_ID } from "./economics.js";

const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
export const HISTORY_YEARS = 15;
const r = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/** One climate summary per past year (same shape as getClimate's result). */
export function perYearClimates(daily, years) {
  const out = [];
  for (const y of years) {
    const has = daily.time.some(t => +t.slice(0, 4) === y);
    if (has) out.push({ ...summarize(daily, [y]), year: y });
  }
  return out;
}

export async function getHistory(lat, lon, today = new Date(), n = HISTORY_YEARS) {
  const last = today.getFullYear() - 1;
  const years = Array.from({ length: n }, (_, i) => last - n + 1 + i);
  const d = await getJSON(ARCHIVE_URL, {
    latitude: lat.toFixed(2), longitude: lon.toFixed(2),
    start_date: `${years[0]}-01-01`, end_date: `${last}-12-31`,
    daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,et0_fao_evapotranspiration",
    temperature_unit: "fahrenheit", precipitation_unit: "mm", timezone: "auto",
  });
  const climates = perYearClimates(d.daily, years);
  if (climates.length < 5) throw new Error("Not enough weather history for this spot.");
  return { climates, source: `Open-Meteo historical weather (ERA5), ${climates[0].year}-${climates[climates.length - 1].year}` };
}

/** Linear-interpolated percentile (p in 0..1). */
export function percentile(values, p) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return null;
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

function stats(values) {
  return {
    bad: r(percentile(values, 0.1)), typical: r(percentile(values, 0.5)), good: r(percentile(values, 0.9)),
    worst: r(Math.min(...values)), best: r(Math.max(...values)),
    positive: values.filter(v => v > 0).length, n: values.length,
  };
}

/** Net $ per sq ft for every crop in every past season, summarised as bad (1 in 10) / typical / good year. */
export function cropRisk(soil, climates, settings = {}) {
  const byCrop = {};
  for (const cl of climates) {
    for (const row of rankCrops(soil, cl, settings)) (byCrop[row.id] ||= []).push(row.net_per_sqft);
  }
  return Object.fromEntries(Object.entries(byCrop).map(([id, v]) => [id, stats(v)]));
}

/** The whole plan replayed through each past season. */
export function planRisk(plan, soil, climates, settings = {}) {
  const years = climates.map(cl => {
    const roi = gardenROI(plan, soil, cl, settings);
    return { year: cl.year, net: roi.net, harvest_lb: roi.harvest_lb, frost_free_days: cl.frost_free_days };
  });
  const s = stats(years.map(y => y.net));
  const worstYear = years.reduce((a, b) => (b.net < a.net ? b : a), years[0]);
  const bestYear = years.reduce((a, b) => (b.net > a.net ? b : a), years[0]);
  return { years, ...s, worst_year: worstYear?.year, best_year: bestYear?.year };
}

/** A household only uses so much of some crops, however well they pay (a few basil plants go a long way). */
export const HOUSEHOLD_MAX_SQFT = { basil: 4 };

/** Score used to pick crops: half typical year, half bad year, so reliable crops win ties. */
export function cropScore(id, ranking, risk) {
  const k = risk?.[id];
  if (k) return r(0.5 * k.typical + 0.5 * k.bad, 3);
  return ranking.find(x => x.id === id)?.net_per_sqft ?? 0;
}

/**
 * Fill `area` sq ft with the best crops for this yard.
 * Each crop gets at most `maxShare` of the space (at least 4 sq ft), up to `maxCrops` crops.
 * Only crops that earn money are used. Returns [{crop, sqft, sun}] in whole square feet.
 */
export function autoPlan({ area, ranking, risk = null, sunHours = null, maxShare = 0.25, maxCrops = 6 }) {
  const A = Math.max(0, Math.round(+area || 0));
  if (!A) return [];
  const scored = ranking.map(x => ({ id: x.id, score: cropScore(x.id, ranking, risk) }))
    .filter(x => x.score > 0 && CROP_BY_ID[x.id]).sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  const cap = Math.max(4, Math.round(A * maxShare));
  const out = [];
  let left = A;
  for (const c of scored.slice(0, maxCrops)) {
    if (left <= 0) break;
    const take = Math.min(cap, HOUSEHOLD_MAX_SQFT[c.id] ?? cap, left);
    if (take < 2 && out.length) { out[0].sqft += take; left = 0; break; }
    out.push({ crop: c.id, sqft: take });
    left -= take;
  }
  // Not enough paying crops to fill the space: give the rest to the best ones in turn.
  const growable = out.filter(p => HOUSEHOLD_MAX_SQFT[p.crop] == null);
  const pool = growable.length ? growable : out;
  for (let i = 0; left > 0; i = (i + 1) % pool.length) { const add = Math.min(left, cap); pool[i].sqft += add; left -= add; }
  return out.map(p => ({ ...p, ...(Number.isFinite(sunHours) ? { sun: sunHours } : {}) }));
}
