// Season calibration: teach the app what YOUR yard actually produces.
//
// Yields in data.js are typical figures for an intensively planted bed. Your
// yard is not typical. Log pounds picked during the season (optional, one line
// each), then press "Finish season" for a crop. The app compares what you
// picked with what it predicted for that bed size and remembers the ratio.
// Future rankings and ROI for that crop use it. The ratio is always measured
// against the uncalibrated prediction, so it never compounds on itself, and it
// is clamped so one freak season (a hailstorm, a bumper year) can't swing the
// numbers wildly. The last three seasons are averaged.
//
// Pure functions over plain data; app.js keeps the log in localStorage.

import { CROP_BY_ID, baseYieldPerSqft } from "./economics.js";

export const MIN_FACTOR = 0.3;
export const MAX_FACTOR = 2.5;
export const SEASONS_KEPT = 3;

const r = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/** Predicted full-season pounds for all beds of `cropId` in the plan (no calibration applied). */
export function predictedLb(plan, cropId, soil, cl) {
  const c = CROP_BY_ID[cropId];
  if (!c) return 0;
  // Each bed's own sun hours count, so a shady bed isn't mistaken for a poor yard.
  return r(plan.filter(p => p.crop === cropId)
    .reduce((a, p) => a + baseYieldPerSqft(c, soil, cl, Number.isFinite(p.sun) ? p.sun : null) * (+p.sqft || 0), 0), 1);
}

export const sqftOf = (plan, cropId) => plan.filter(p => p.crop === cropId).reduce((a, p) => a + (+p.sqft || 0), 0);

/** Valid harvest entry or null. `lb` must be a positive number, `date` an ISO day. */
export function makeEntry({ crop, lb, date }, now = Date.now()) {
  const pounds = +lb;
  if (!CROP_BY_ID[crop] || !Number.isFinite(pounds) || pounds <= 0 || pounds > 5000) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? date : new Date(now).toISOString().slice(0, 10);
  return { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, crop, lb: r(pounds, 2), date: d };
}

export function loggedLb(log, cropId, year) {
  return r(log.filter(e => e.crop === cropId && +e.date.slice(0, 4) === year).reduce((a, e) => a + e.lb, 0), 2);
}

/**
 * Adds a finished season for a crop. `history` is { cropId: [{year, factor, lb, predicted, sqft}] }.
 * Returns { history, factor, entry } or { error } when there is nothing to compare.
 */
export function finishSeason(history, { crop, year, lb, predicted, sqft }) {
  if (!CROP_BY_ID[crop]) return { error: "Unknown crop." };
  if (!(predicted > 0) || !(sqft > 0)) return { error: "Add this crop to your plan first, so there is a bed size to compare against." };
  if (!(lb > 0)) return { error: "Log at least one harvest first." };
  const factor = r(clamp(lb / predicted, MIN_FACTOR, MAX_FACTOR));
  const entry = { year, factor, lb: r(lb, 1), predicted: r(predicted, 1), sqft };
  const kept = (Array.isArray(history[crop]) ? history[crop] : []).filter(s => s && s.year !== year);
  const seasons = [...kept, entry].sort((a, b) => a.year - b.year).slice(-SEASONS_KEPT);
  return { history: { ...history, [crop]: seasons }, factor, entry };
}

/** { cropId: factor } from history: the average of the last few seasons. */
export function factorsFromHistory(history) {
  const out = {};
  if (!history || typeof history !== "object") return out;
  for (const [crop, seasons] of Object.entries(history)) {
    if (!Array.isArray(seasons)) continue;
    const f = seasons.filter(s => s && Number.isFinite(s.factor)).slice(-SEASONS_KEPT);
    if (f.length && CROP_BY_ID[crop]) out[crop] = r(clamp(f.reduce((a, s) => a + s.factor, 0) / f.length, MIN_FACTOR, MAX_FACTOR));
  }
  return out;
}

export function toCSV(log) {
  const q = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  return ["date,crop,pounds", ...[...log].sort((a, b) => a.date.localeCompare(b.date))
    .map(e => [e.date, CROP_BY_ID[e.crop]?.name ?? e.crop, e.lb].map(q).join(","))].join("\n") + "\n";
}

/**
 * Season report: predicted vs. actual for every crop in the plan this year, plus
 * the conditions behind the prediction. It's what a beta tester sends back so
 * yields can be tuned to real gardens. Location is rounded to about 50 km and
 * nothing identifies the person.
 */
export function seasonReport({ plan, log, soil, cl, location, year, factors = {} }) {
  const q = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const lat = location ? Math.round(location.lat * 2) / 2 : "", lon = location ? Math.round(location.lon * 2) / 2 : "";
  const ids = [...new Set(plan.filter(p => p.sqft > 0).map(p => p.crop))].filter(id => CROP_BY_ID[id]);
  const rows = ids.map(id => {
    const beds = plan.filter(p => p.crop === id && p.sqft > 0);
    const sqft = beds.reduce((a, p) => a + p.sqft, 0);
    const sun = beds.filter(p => Number.isFinite(p.sun)).map(p => p.sun);
    const predicted = predictedLb(plan, id, soil, cl), actual = loggedLb(log, id, year);
    return [year, id, CROP_BY_ID[id].name, sqft, sun.length ? r(sun.reduce((a, b) => a + b, 0) / sun.length, 1) : "", predicted, actual,
      actual > 0 && predicted > 0 ? r(actual / predicted) : "", factors[id] ?? 1, lat, lon, soil?.texture_class ?? "",
      soil?.values?.ph?.value ?? "", soil?.values?.ph?.source ?? "", cl?.frost_free_days ?? "", cl?.season_gdd50 ?? ""];
  });
  const head = "year,crop_id,crop,sqft,sun_hours,predicted_lb,actual_lb,actual_over_predicted,calibration,lat_rounded,lon_rounded,soil_texture,soil_ph,ph_source,frost_free_days,gdd50";
  return [head, ...rows.map(r0 => r0.map(q).join(","))].join("\n") + "\n";
}
