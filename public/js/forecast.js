// 7-day forecast and watering advice.
//
// Pulls the next week of weather from Open-Meteo (free, no key) and answers the
// question a garden app should answer: "do I need to water, and what does skipping
// cost or save?" The model is deliberately simple and says so:
//   * each day, plants use (reference evapotranspiration x the plan's crop factor),
//   * only rain of 0.1 in or more counts, and only the share your soil holds,
//   * the soil bucket holds a few tenths of an inch before plants are stressed
//     (sandy soil holds less than loam or clay), and
//   * when it runs down, you water enough to refill it.
// The saving is measured against a timer that waters every day and ignores rain.
// Everything is a pure function so the numbers can be checked.

import { getJSON } from "./net.js";
import { CROP_BY_ID, effectiveRainFactor, gallons } from "./economics.js";

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const MM_PER_IN = 25.4;
export const PAST_DAYS = 2;
export const FORECAST_DAYS = 7;
const RAIN_COUNTS_FROM_IN = 0.1;

/** How many inches of water plants can use before they are stressed (about half the root zone's available water). */
export function bucketInches(texture) {
  if (["sand", "loamy sand", "sandy loam"].includes(texture)) return 0.25;
  if (["clay", "silty clay", "sandy clay"].includes(texture)) return 0.6;
  return 0.65;
}

export function parseForecast(daily) {
  const { time, temperature_2m_max: tmax, temperature_2m_min: tmin, precipitation_sum: pr,
    precipitation_probability_max: pop, et0_fao_evapotranspiration: et } = daily;
  return time.map((date, i) => ({
    date, tmax: tmax[i], tmin: tmin[i],
    rain_in: Math.round((pr[i] || 0) / MM_PER_IN * 100) / 100,
    et0_in: Math.round((et[i] || 0) / MM_PER_IN * 100) / 100,
    pop: pop?.[i] ?? null,
  }));
}

export async function getForecast(lat, lon) {
  const d = await getJSON(FORECAST_URL, {
    latitude: lat.toFixed(2), longitude: lon.toFixed(2),
    daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,et0_fao_evapotranspiration",
    temperature_unit: "fahrenheit", precipitation_unit: "mm", timezone: "auto",
    past_days: PAST_DAYS, forecast_days: FORECAST_DAYS,
  });
  return parseForecast(d.daily);
}

/** Beds that are actually growing in this month (a warm crop in January is not). */
export function activeBeds(plan, cl, monthIdx) {
  return plan.filter(p => p.sqft > 0 && CROP_BY_ID[p.crop]).map(p => {
    const c = CROP_BY_ID[p.crop];
    const frac = (c.season === "warm" ? cl.monthly_active_frac_warm : cl.monthly_active_frac_cool)[monthIdx] ?? 0;
    return { ...p, crop: c, active: frac >= 0.5 };
  }).filter(b => b.active);
}

const dayName = iso => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
const dayShort = iso => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * Day-by-day watering plan for the next 7 days.
 * `days` is the parsed forecast including PAST_DAYS earlier days (used to estimate how dry the beds are now).
 */
export function wateringAdvice({ days, plan, soil, cl, method = "hose", waterRate = 6 }) {
  if (!days || days.length <= PAST_DAYS) return { available: false, reason: "no-forecast" };
  const future = days.slice(PAST_DAYS);
  const monthIdx = +future[0].date.slice(5, 7) - 1;
  const beds = activeBeds(plan, cl, monthIdx);
  const frost = frostWatch(future, plan, cl);
  if (!beds.length) {
    return { available: true, active: false, frost, days: future.map(d => ({ ...d, label: dayName(d.date), short: dayShort(d.date) })),
      reason: "Nothing in your plan is growing this time of year, so there is no watering to plan." };
  }
  const area = beds.reduce((a, b) => a + b.sqft, 0);
  const kc = beds.reduce((a, b) => a + b.sqft * b.crop.kc, 0) / area;
  const eff = effectiveRainFactor(soil.texture_class);
  const cap = bucketInches(soil.texture_class);
  const effRain = r => (r >= RAIN_COUNTS_FROM_IN ? r * eff : 0);

  // How dry are the beds right now? Start full two days ago and subtract rain, add use. No watering is assumed in between.
  let deficit = 0;
  for (const d of days.slice(0, PAST_DAYS)) deficit = Math.min(cap, Math.max(0, deficit + kc * d.et0_in - effRain(d.rain_in)));

  let smartIn = 0, timerIn = 0;
  const out = future.map(d => {
    const use = kc * d.et0_in, rain = effRain(d.rain_in);
    deficit = Math.max(0, deficit + use - rain);
    timerIn += use;
    let action = "skip", reason = "Soil still holds enough moisture.", inches = 0;
    if (deficit >= cap) {
      inches = Math.round(deficit * 100) / 100; action = "water"; reason = "Beds have run down to the point plants feel it.";
      smartIn += inches; deficit = 0;
    } else if (rain > 0 && d.rain_in >= RAIN_COUNTS_FROM_IN) reason = "Rain covers it.";
    const gal = inches > 0 ? gallons(inches, area, method) : 0;
    return { ...d, label: dayName(d.date), short: dayShort(d.date), action, reason, inches,
      gallons: Math.round(gal), cost: Math.round(gal / 1000 * waterRate * 100) / 100 };
  });
  const smartGal = gallons(smartIn, area, method), timerGal = gallons(timerIn, area, method);
  const savedGal = Math.max(0, timerGal - smartGal);
  return {
    available: true, active: true, frost, days: out, area_sqft: area, kc: Math.round(kc * 100) / 100, bucket_in: cap, method,
    water_days: out.filter(d => d.action === "water").length, skip_days: out.filter(d => d.action === "skip").length,
    week_gallons: Math.round(smartGal), week_cost: Math.round(smartGal / 1000 * waterRate * 100) / 100,
    timer_gallons: Math.round(timerGal), saved_gallons: Math.round(savedGal),
    saved_cost: Math.round(savedGal / 1000 * waterRate * 100) / 100,
  };
}

/** Freeze check for tender (warm-season) crops that could still be in the ground this month. */
export function frostWatch(days, plan, cl) {
  const m = +days[0].date.slice(5, 7) - 1;
  const live = (cl?.monthly_active_frac_warm?.[m] ?? 0) > 0;
  const tender = live ? [...new Set(plan.filter(p => p.sqft > 0 && CROP_BY_ID[p.crop]?.season === "warm").map(p => CROP_BY_ID[p.crop].name))] : [];
  const hit = days.find(d => d.tmin !== null && d.tmin <= 32);
  const near = days.find(d => d.tmin !== null && d.tmin <= 36);
  if (hit && tender.length) {
    return { level: "freeze", day: `${dayName(hit.date)} ${dayShort(hit.date)}`, low: Math.round(hit.tmin),
      text: `Freeze forecast ${dayName(hit.date)} (low ${Math.round(hit.tmin)}°F). Pick or cover tender crops: ${tender.slice(0, 4).join(", ")}${tender.length > 4 ? " and more" : ""}.` };
  }
  if (near && tender.length) {
    return { level: "chilly", day: `${dayName(near.date)} ${dayShort(near.date)}`, low: Math.round(near.tmin),
      text: `Cold night ${dayName(near.date)} (low ${Math.round(near.tmin)}°F). Frost is possible in low spots; cover tender crops to be safe.` };
  }
  return null;
}
