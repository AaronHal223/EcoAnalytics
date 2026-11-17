// Soil-aware planting calendar.
//
// Most planting calendars use frost dates alone. This one starts from the same
// frost dates (median of three years of real weather, see climate.js) and then
// shifts them by what your soil does:
//   * heavy clay stays cold and wet in spring, so sowing waits about a week,
//   * sandy soil drains and warms early, so tender crops can go in a few days sooner,
//   * a pH far outside a crop's range gets flagged, because liming comes first.
// The shifts are rules of thumb (extension-office style guidance), not measured
// soil temperatures. Every window says why it moved.
//
// All dates are day-of-year numbers (1-365). Pure functions, no network.

import { CROPS } from "./data.js";
import { MONTHS } from "./climate.js";
import { seasonFit, phFactor } from "./economics.js";

const MONTH_STARTS = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335, 366];

/** "Apr 15" -> 105 (non-leap year), or null. */
export function labelToDoy(label) {
  const m = /^([A-Za-z]{3})\s+(\d{1,2})$/.exec(label || "");
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1]);
  return mi < 0 ? null : MONTH_STARTS[mi] + (+m[2]) - 1;
}

/** Day-of-year for a Date, using its UTC calendar day. */
export function doyOfDate(d) {
  return Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1;
}

/** Day-of-year for the person's own calendar day (local time), so "today" matches their wall calendar. */
export function localDoy(d = new Date()) {
  return doyOfDate(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())));
}

export function dayLabel(doy) {
  const d = new Date(Date.UTC(2023, 0, 1) + (Math.round(doy) - 1 + 365) % 365 * 86400000);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function frostDoys(cl) {
  const spring = cl.last_spring_frost_doy ?? labelToDoy(cl.last_spring_frost);
  const fall = cl.first_fall_frost_doy ?? labelToDoy(cl.first_fall_frost);
  return { spring: spring ?? 0, fall: fall ?? 366, frostFree: spring == null && fall == null };
}

// ---- Soil shifts ---------------------------------------------------------------------------
const HEAVY = ["clay", "silty clay", "sandy clay"];
const CLAYEY_LOAM = ["clay loam", "silty clay loam", "sandy clay loam"];
const SANDY = ["sand", "loamy sand", "sandy loam"];

/** Days to add to spring planting dates because of soil texture (negative = sooner). */
export function soilShift(texture) {
  if (HEAVY.includes(texture)) return { days: 7, why: "Heavy clay stays cold and wet in spring, so sowing waits about a week." };
  if (CLAYEY_LOAM.includes(texture)) return { days: 4, why: "Clay-rich loam warms a little slower than average, so sowing waits a few days." };
  if (SANDY.includes(texture)) return { days: -4, why: "Sandy soil drains and warms early, so tender crops can go in a few days sooner. Water more often." };
  return { days: 0, why: "Loamy soil warms at an average pace, so dates follow your frost dates." };
}

// ---- Crop timing rules ----------------------------------------------------------------------
const SPRING_ONLY = new Set(["onion", "potato"]);                    // can't be finished from a fall sowing
const HARVEST_SPAN = {                                                 // days a planting keeps giving
  tomato: 45, cherry_tomato: 55, pepper: 45, zucchini: 40, cucumber: 35, bush_bean: 21, sweet_corn: 10, basil: 60,
  lettuce: 21, spinach: 21, kale: 60, chard: 60, snap_pea: 21, carrot: 28, radish: 10, beet: 21, onion: 14, garlic: 14, potato: 14,
  eggplant: 45, winter_squash: 14, pole_bean: 45, sweet_potato: 14, cantaloupe: 21, broccoli: 21, cabbage: 21, arugula: 21, cilantro: 21, parsley: 90,
};
const TENDER_BUFFER = 14;       // warm crops wait this long after the last frost
const COOL_HEAD_START = 28;     // cool crops can start this long before the last frost
const clampDoy = d => Math.max(1, Math.min(365, Math.round(d)));
/**
 * A window as day-of-year ranges. Seasons south of the equator run past Dec 31, so a window
 * can start after day 365 (fold it back) or cross the year end (split it in two).
 */
function win(kind, season, start, end, extra = {}) {
  let s = Math.round(start), e = Math.round(Math.max(start, end));
  if (s > 365 && !extra.nextYear) { s -= 365; e -= 365; }
  if (s < 1 && e >= 1 && !extra.nextYear) s = 1;
  if (e <= 365 || extra.nextYear) return [{ kind, season, start: clampDoy(s), end: clampDoy(e), ...extra }];
  return [{ kind, season, start: clampDoy(s), end: 365, ...extra }, { kind, season, start: 1, end: clampDoy(e - 365), ...extra }];
}

/** Sowing and harvest windows for one crop. */
export function cropWindows(crop, soil, cl) {
  const { spring, fall } = frostDoys(cl);
  const sh = soilShift(soil.texture_class);
  const span = HARVEST_SPAN[crop.id] ?? 21;
  const windows = [], notes = [];

  if (crop.season === "warm") {
    const start = spring + TENDER_BUFFER + sh.days;
    const latest = fall - crop.days;                        // last day that still ripens before frost
    const end = Math.min(start + 28, latest);
    if (latest < start) notes.push("Your season is short for this crop: start it indoors early or choose a faster variety.");
    windows.push(...win("sow", "spring", start, end));
    if (start + crop.days <= fall) windows.push(...win("harvest", "spring", start + crop.days, Math.min(fall, start + crop.days + span)));
  } else if (crop.overwinter) {
    const start = fall - 7 + Math.max(0, sh.days), end = start + 28;
    windows.push(...win("sow", "fall", start, end));
    const s0 = start > 365 ? start - 365 : start;           // southern hemisphere: fall is in the next calendar year
    const h = s0 + crop.days, next = h > 365;
    windows.push(...win("harvest", next ? "next" : "spring", next ? h - 365 : h, (next ? h - 365 : h) + span, next ? { nextYear: true } : {}));
    notes.push("Plant in fall; it overwinters and is harvested next summer.");
  } else {
    const start = spring - COOL_HEAD_START + Math.max(0, sh.days);
    windows.push(...win("sow", "spring", start, start + 21));
    windows.push(...win("harvest", "spring", start + crop.days, start + crop.days + span));
    if (!SPRING_ONLY.has(crop.id)) {
      const fs = fall - crop.days - 21;
      windows.push(...win("sow", "fall", fs, fs + 14));
      windows.push(...win("harvest", "fall", fs + crop.days, fall > 365 ? fall + 21 : Math.min(365, fall + 21)));
    }
  }
  const ph = soil.values.ph.value, pf = phFactor(crop, ph);
  if (pf < 1) notes.push(`Soil pH ${ph.toFixed(1)} is outside its ${crop.ph[0]}-${crop.ph[1]} range, so adjust pH first (see Fertilizer plan). Expect about ${Math.round(pf * 100)}% of a normal harvest until then.`);
  return { windows, notes, shift: sh };
}

/** What a crop is doing today: sow now, harvesting, coming up, or out of season. */
export function nowStatus(windows, today) {
  const sow = windows.filter(w => w.kind === "sow"), harv = windows.filter(w => w.kind === "harvest" && !w.nextYear);
  if (sow.some(w => today >= w.start && today <= w.end)) return { action: "sow", text: "Plant now" };
  if (harv.some(w => today >= w.start && today <= w.end)) return { action: "harvest", text: "Harvest now" };
  const next = sow.filter(w => w.start > today).sort((a, b) => a.start - b.start)[0];
  if (next && next.start - today <= 21) return { action: "soon", text: `Plant from ${dayLabel(next.start)}`, start: next.start };
  if (next) return { action: "later", text: `Next planting ${dayLabel(next.start)}`, start: next.start };
  const wrap = sow[0];
  return { action: "later", text: wrap ? `Next planting ${dayLabel(wrap.start)}` : "Out of season", start: wrap ? wrap.start + 365 : null };
}

/**
 * Calendar for every crop. `plan` ([{crop, sqft}]) marks which crops are in the garden.
 * `today` is a day-of-year number (use localDoy()).
 */
export function plantingCalendar({ plan = [], soil, cl, today }) {
  const inPlan = new Set(plan.filter(p => p.sqft > 0).map(p => p.crop));
  const fr = frostDoys(cl), sh = soilShift(soil.texture_class);
  const crops = CROPS.map(c => {
    const { windows, notes } = cropWindows(c, soil, cl);
    const fit = seasonFit(c, cl);
    if (c.season === "warm" && fit.fraction < 1) notes.push(fit.note);
    return { id: c.id, name: c.name, season: c.season, inPlan: inPlan.has(c.id), windows, notes, now: nowStatus(windows, today) };
  });
  const order = { sow: 0, harvest: 1, soon: 2, later: 3 };
  crops.sort((a, b) => (b.inPlan - a.inPlan) || (order[a.now.action] - order[b.now.action]) || a.name.localeCompare(b.name));
  return {
    today, frost: { spring: fr.spring, fall: fr.fall, frostFree: fr.frostFree,
      springLabel: cl.last_spring_frost, fallLabel: cl.first_fall_frost }, shift: sh, texture: soil.texture_class, crops,
  };
}

/** Plain-language one-liner for a crop's windows (used for screen readers and tooltips). */
export function describeWindows(c) {
  return `${c.name}: ` + c.windows.map(w => `${w.kind === "sow" ? "plant" : "harvest"} ${dayLabel(w.start)} to ${dayLabel(w.end)}${w.nextYear ? " next year" : ""}`).join(", ");
}
