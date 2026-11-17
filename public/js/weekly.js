// This week in your garden.
//
// Turns the 7-day forecast, the planting calendar and the watering plan into a
// short to-do list for the beds you actually have: cover the peppers before
// Thursday's frost, water early before the heat, skip watering because rain is
// coming, stake the tomatoes before the wind, plant the lettuce this week.
// Most urgent first. Pure function; app.js draws it.

import { CROP_BY_ID } from "./economics.js";
import { dayLabel } from "./planner.js";
import { PAST_DAYS } from "./forecast.js";

const short = name => name.replace(/\s*\(.*\)/, "");
const dayName = iso => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
const list = names => names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
const LEVEL = { urgent: 0, do: 1, plan: 2, tip: 3 };

export const HEAT_F = 90, HOT_FRUIT_F = 95, HEAVY_RAIN_IN = 1, WIND_MPH = 25;
const TALL = ["tomato", "cherry_tomato", "sweet_corn", "snap_pea", "cucumber", "pepper"];
const BOLTERS = ["lettuce", "spinach"];
const RIPENERS = ["tomato", "cherry_tomato"];

/**
 * @param days      parsed forecast (including PAST_DAYS earlier days), or null
 * @param plan      [{crop, sqft}]
 * @param cl        climate summary (monthly active fractions, frost dates)
 * @param calendar  plantingCalendar() result
 * @param advice    wateringAdvice() result, or null
 * @param soil      soil report (texture)
 * @param today     day of year (1-366)
 * @returns [{kind, level, when, title, detail}] most urgent first
 */
export function weekActions({ days = null, plan = [], cl, calendar, advice = null, soil = null, today }) {
  const out = [];
  const beds = plan.filter(p => p.sqft > 0 && CROP_BY_ID[p.crop]);
  const future = days && days.length > PAST_DAYS ? days.slice(PAST_DAYS) : [];
  const month = future.length ? +future[0].date.slice(5, 7) - 1 : null;
  const growing = id => {
    if (month == null) return true;
    const c = CROP_BY_ID[id];
    return ((c.season === "warm" ? cl?.monthly_active_frac_warm : cl?.monthly_active_frac_cool)?.[month] ?? 0) > 0;
  };
  const live = [...new Set(beds.map(b => b.crop))].filter(growing);
  const names = ids => ids.map(id => short(CROP_BY_ID[id].name));
  const tender = live.filter(id => CROP_BY_ID[id].season === "warm");

  if (future.length) {
    // Frost
    const freeze = future.find(d => d.tmin != null && d.tmin <= 32);
    const hard = future.find(d => d.tmin != null && d.tmin <= 26);
    const chilly = future.find(d => d.tmin != null && d.tmin <= 36);
    if (freeze && tender.length) {
      out.push({ kind: "frost", level: "urgent", when: freeze.date, title: `Frost ${dayName(freeze.date)} night (low ${Math.round(freeze.tmin)}°F)`,
        detail: `Pick anything ripe and cover ${list(names(tender))} before dark with sheets, buckets or row cover. Take covers off in the morning.` });
    } else if (chilly && tender.length) {
      out.push({ kind: "frost", level: "do", when: chilly.date, title: `Cold night ${dayName(chilly.date)} (low ${Math.round(chilly.tmin)}°F)`,
        detail: `Frost can form in low spots. Covering ${list(names(tender))} overnight is cheap insurance.` });
    }
    const cool = live.filter(id => CROP_BY_ID[id].season === "cool" && !["kale", "garlic", "spinach"].includes(id));
    if (hard && cool.length) {
      out.push({ kind: "frost", level: "urgent", when: hard.date, title: `Hard freeze ${dayName(hard.date)} (low ${Math.round(hard.tmin)}°F)`,
        detail: `Even cool crops get hurt this cold. Cover ${list(names(cool))}; kale, spinach and garlic will be fine.` });
    }

    // Heat
    const hot = future.filter(d => d.tmax != null && d.tmax >= HEAT_F);
    if (hot.length && live.length) {
      const peak = hot.reduce((a, b) => (b.tmax > a.tmax ? b : a));
      const bolt = live.filter(id => BOLTERS.includes(id)), fruit = live.filter(id => ["tomato", "cherry_tomato", "pepper"].includes(id));
      const parts = ["Water deeply early in the morning, not in the heat of the day, and top up mulch."];
      if (bolt.length) parts.push(`Shade ${list(names(bolt))} in the afternoon (an old sheet works) or pick it now before it bolts.`);
      if (fruit.length && peak.tmax >= HOT_FRUIT_F) parts.push(`${list(names(fruit))} may drop flowers above ${HOT_FRUIT_F}°F. That's normal; fruit sets again when it cools.`);
      out.push({ kind: "heat", level: "do", when: peak.date,
        title: hot.length > 1 ? `Hot spell: ${hot.length} days at ${HEAT_F}°F or more (peak ${Math.round(peak.tmax)}°F ${dayName(peak.date)})` : `Hot day ${dayName(peak.date)} (${Math.round(peak.tmax)}°F)`,
        detail: parts.join(" ") });
    }

    // Heavy rain
    const storm = future.find(d => d.rain_in >= HEAVY_RAIN_IN);
    if (storm && live.length) {
      const ripe = live.filter(id => RIPENERS.includes(id));
      const parts = ["Skip watering before it."];
      if (ripe.length) parts.push(`Pick nearly ripe ${list(names(ripe)).toLowerCase()} first: a soaking after dry weather splits them.`);
      if (soil && ["clay", "silty clay", "sandy clay", "clay loam", "silty clay loam"].includes(soil.texture_class)) parts.push("Your clay soil drains slowly: stay off wet beds so you don't pack the soil.");
      out.push({ kind: "rain", level: "do", when: storm.date, title: `Heavy rain ${dayName(storm.date)} (${storm.rain_in.toFixed(1)} in)`, detail: parts.join(" ") });
    }

    // Wind
    const windy = future.find(d => d.wind_mph != null && d.wind_mph >= WIND_MPH);
    const tall = live.filter(id => TALL.includes(id));
    if (windy && tall.length) {
      out.push({ kind: "wind", level: "do", when: windy.date, title: `Strong wind ${dayName(windy.date)} (up to ${Math.round(windy.wind_mph)} mph)`,
        detail: `Check stakes, cages and trellises on ${list(names(tall))}, and tie in loose stems.` });
    }
  }

  // Watering
  if (advice?.available && advice.active) {
    const water = advice.days.filter(d => d.action === "water");
    if (water.length) {
      out.push({ kind: "water", level: "do", when: water[0].date, title: `Water on ${list(water.map(d => d.label))}`,
        detail: `About ${Math.round(advice.week_gallons)} gal this week for your beds. ${advice.skip_days} day${advice.skip_days === 1 ? "" : "s"} need nothing, which saves ${Math.round(advice.saved_gallons)} gal over watering daily.` });
    } else {
      out.push({ kind: "water", level: "tip", when: null, title: "No watering needed this week",
        detail: "Rain and the moisture already in your soil cover what your beds use. Check again if it turns hot." });
    }
  }

  // Calendar: windows that open or close this week, for crops in the plan.
  if (calendar && Number.isFinite(today)) {
    const inWeek = d => d >= today && d <= today + 7;
    for (const c of calendar.crops.filter(x => x.inPlan)) {
      for (const w of c.windows.filter(w => !w.nextYear)) {
        const n = short(c.name);
        if (w.kind === "sow" && inWeek(w.start)) out.push({ kind: "plant", level: "plan", when: null, title: `Planting time for ${n} starts ${dayLabel(w.start)}`, detail: `The window runs to ${dayLabel(w.end)}. ${c.notes[0] || ""}`.trim() });
        else if (w.kind === "sow" && today >= w.start && w.end >= today && w.end <= today + 7) out.push({ kind: "plant", level: "do", when: null, title: `Last week to plant ${n}`, detail: `The window closes ${dayLabel(w.end)}. After that it's unlikely to finish before frost.` });
        else if (w.kind === "harvest" && inWeek(w.start)) out.push({ kind: "harvest", level: "plan", when: null, title: `${n} ready to pick from ${dayLabel(w.start)}`, detail: "Log what you pick in Garden ROI so the app learns your yard." });
      }
    }
    // First fall frost is coming and tender crops are still in.
    const fall = calendar.frost?.fall;
    const until = fall && fall < 730 ? ((((Math.round(fall) - 1) % 365) + 1 - today) + 365) % 365 : null;
    if (until != null && until <= 14 && tender.length && !out.some(a => a.kind === "frost")) {
      out.push({ kind: "frost", level: "plan", when: null, title: `First frost usually comes around ${dayLabel(fall)}`,
        detail: `Plan to harvest or cover ${list(names(tender))}. Green tomatoes ripen indoors in a paper bag.` });
    }
  }

  if (!beds.length) out.push({ kind: "start", level: "tip", when: null, title: "Add your beds to get a weekly to-do list", detail: "Use Garden ROI, or let “Plan it for me” pick crops for your space." });
  else if (!out.length) out.push({ kind: "calm", level: "tip", when: null, title: "Nothing urgent this week", detail: "No frost, heat, storms or planting dates in the next 7 days. A good week to weed and mulch." });

  return out.sort((a, b) => LEVEL[a.level] - LEVEL[b.level] || String(a.when || "9").localeCompare(String(b.when || "9")));
}
