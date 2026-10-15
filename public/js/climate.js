// Local climate from real weather history.
//
// Pulls the last three complete years of daily weather for the garden from
// the Open-Meteo historical archive (free, no key) and turns it into:
//   * frost-free season (median last spring / first fall 32F night),
//   * growing degree days (base 50F) inside that season, for warm crops,
//   * cool-season growing days (mean temperature 40-75F),
//   * monthly rainfall and reference evapotranspiration (ET0: how much water
//     a well-watered crop loses), which drive the water-cost model.
// Three years, not one, so a single odd spring doesn't decide what you plant.

import { getJSON } from "./net.js";

const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const MM_PER_IN = 25.4;
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_STARTS = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335, 366];

const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const r = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

function doyOf(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000) + 1;
}

export function doyLabel(doy) {
  const d = new Date(Date.UTC(2023, 0, 1) + (Math.round(doy) - 1) * 86400000);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function windowFraction(start, end) {
  const out = [];
  for (let m = 0; m < 12; m++) {
    const a = MONTH_STARTS[m], b = MONTH_STARTS[m + 1];
    out.push(r(Math.max(0, Math.min(b, end) - Math.max(a, start + 1)) / (b - a)));
  }
  return out;
}

/** Pure function over Open-Meteo `daily` arrays (Fahrenheit, mm). */
export function summarize(daily, years) {
  const { time, temperature_2m_max: tmax, temperature_2m_min: tmin,
    precipitation_sum: prcp, et0_fao_evapotranspiration: et0 } = daily;
  const springs = [], falls = [], seasons = [], gdds = [], cools = [];
  const mPr = years.map(() => Array(12).fill(0)), mEt = years.map(() => Array(12).fill(0));
  const mTemp = Array.from({ length: 12 }, () => []);
  const mCool = Array(12).fill(0), mDays = Array(12).fill(0);

  years.forEach((y, yi) => {
    const idx = [];
    for (let i = 0; i < time.length; i++) if (+time[i].slice(0, 4) === y) idx.push(i);
    let lastSpring = null, firstFall = null;
    for (const i of idx) {
      const lo = tmin[i], hi = tmax[i];
      if (lo === null || hi === null) continue;
      const mo = +time[i].slice(5, 7) - 1, doy = doyOf(time[i]);
      if (lo <= 32) { if (mo < 6) lastSpring = doy; else if (firstFall === null) firstFall = doy; }
      const t = (lo + hi) / 2;
      mTemp[mo].push(t); mDays[mo]++;
      if (t >= 40 && t <= 75) mCool[mo]++;
      mPr[yi][mo] += prcp[i] || 0;
      mEt[yi][mo] += et0[i] || 0;
    }
    const daysInYear = y % 4 === 0 ? 366 : 365;
    const sp = lastSpring || 0, fa = firstFall || daysInYear + 1;
    springs.push(sp); falls.push(fa); seasons.push(Math.max(0, fa - sp - 1));
    let g = 0, c = 0;
    for (const i of idx) {
      if (tmin[i] === null || tmax[i] === null) continue;
      const doy = doyOf(time[i]), t = (tmin[i] + tmax[i]) / 2;
      if (doy > sp && doy < fa) g += Math.max(0, (Math.min(tmax[i], 86) + Math.max(tmin[i], 50)) / 2 - 50);
      if (t >= 40 && t <= 75) c++;
    }
    gdds.push(g); cools.push(c);
  });

  const ny = years.length;
  const precip = MONTHS.map((_, m) => r(mPr.reduce((a, y) => a + y[m], 0) / ny / MM_PER_IN));
  const et = MONTHS.map((_, m) => r(mEt.reduce((a, y) => a + y[m], 0) / ny / MM_PER_IN));
  const spM = median(springs), faM = median(falls);
  return {
    frost_free_days: Math.floor(median(seasons)),
    last_spring_frost: spM > 0 ? doyLabel(spM) : null,
    first_fall_frost: faM <= 365 ? doyLabel(faM) : null,
    season_gdd50: Math.round(median(gdds)),
    cool_growing_days: Math.floor(median(cools)),
    monthly_precip_in: precip, monthly_et0_in: et,
    monthly_tmean_f: mTemp.map(v => v.length ? r(mean(v), 1) : null),
    monthly_active_frac_warm: windowFraction(spM, faM),
    monthly_active_frac_cool: MONTHS.map((_, m) => mDays[m] ? r(mCool[m] / mDays[m]) : 0),
    annual_precip_in: r(precip.reduce((a, b) => a + b, 0), 1),
    years, months: MONTHS,
    source: `Open-Meteo historical weather (ERA5), ${years[0]}-${years[ny - 1]}`,
    notes: [],
  };
}

export async function getClimate(lat, lon, today = new Date()) {
  const y = today.getFullYear(), years = [y - 3, y - 2, y - 1];
  try {
    const d = await getJSON(ARCHIVE_URL, {
      latitude: lat.toFixed(2), longitude: lon.toFixed(2),
      start_date: `${years[0]}-01-01`, end_date: `${years[2]}-12-31`,
      daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,et0_fao_evapotranspiration",
      temperature_unit: "fahrenheit", precipitation_unit: "mm", timezone: "auto",
    });
    return summarize(d.daily, years);
  } catch {
    return fallbackClimate(lat, years);
  }
}

/** Latitude-only approximation, used when the weather archive can't be reached. */
export function fallbackClimate(lat, years) {
  const a = Math.abs(lat);
  const ffd = Math.floor(Math.max(90, Math.min(365, 365 - (a - 25) * 11)));
  const sp = Math.max(0, 197 - ffd / 2), fa = Math.min(366, 197 + ffd / 2);
  const peak = 6.5 - (a - 30) * 0.05;
  const et = MONTHS.map((_, m) => r(Math.max(0.6, peak * (0.55 + 0.45 * Math.cos(2 * Math.PI * (m - 6) / 12)))));
  const temp = MONTHS.map((_, m) => r(75 - (a - 30) * 0.9 - (22 + (a - 30) * 0.5) * (1 - Math.cos(2 * Math.PI * (m - 6) / 12)) / 2, 1));
  const cool = temp.map(t => (t >= 40 && t <= 75) ? 1 : 0);
  return {
    frost_free_days: ffd,
    last_spring_frost: sp > 0 ? doyLabel(sp) : null,
    first_fall_frost: fa <= 365 ? doyLabel(fa) : null,
    season_gdd50: Math.round(ffd * Math.max(5, 22 - (a - 30) * 0.5)),
    cool_growing_days: Math.floor(cool.reduce((s, c) => s + c * 30.4, 0)),
    monthly_precip_in: Array(12).fill(3.3), monthly_et0_in: et, monthly_tmean_f: temp,
    monthly_active_frac_warm: windowFraction(sp, fa), monthly_active_frac_cool: cool,
    annual_precip_in: 39.6, years, months: MONTHS,
    source: "Latitude estimate (weather service unreachable)",
    notes: ["Weather history couldn't be loaded; season and water numbers are rough estimates."],
  };
}
