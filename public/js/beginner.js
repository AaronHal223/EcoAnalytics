// Beginner mode: the same engine as the full app, said simply.
//
// A beginner answers three picture questions (where, how much space, how much sun)
// and gets a small starter garden of hard-to-kill plants. Each plant then shows one
// plain status ("Plant now", "Ready in about 12 days", "Ready to pick!"), and Today
// turns the weekly list and the planting calendar into a short checklist.
// Pure functions over plain data; app.js draws the screens.

import { CROP_BY_ID } from "./economics.js";
import { SUN_NEED, sunFactor } from "./sun.js";

/** Plants that forgive mistakes, most forgiving first. */
export const EASY = ["lettuce", "radish", "bush_bean", "cherry_tomato", "zucchini", "kale", "chard", "snap_pea", "basil", "arugula", "spinach", "parsley", "garlic", "potato"];

export const EMOJI = {
  tomato: "🍅", cherry_tomato: "🍅", pepper: "🫑", zucchini: "🥒", cucumber: "🥒", bush_bean: "🫛", pole_bean: "🫛", snap_pea: "🫛",
  sweet_corn: "🌽", basil: "🌿", parsley: "🌿", cilantro: "🌿", lettuce: "🥬", spinach: "🍃", kale: "🥬", chard: "🥬", arugula: "🥗", cabbage: "🥬",
  carrot: "🥕", radish: "🌱", beet: "🌱", onion: "🧅", garlic: "🧄", potato: "🥔", eggplant: "🍆", winter_squash: "🎃", sweet_potato: "🍠",
  cantaloupe: "🍈", broccoli: "🥦",
};
export const emoji = id => EMOJI[id] || "🌱";

/** Short everyday name: "Cherry tomatoes", "Green beans", "Lettuce". */
export function plainName(id) {
  const n = CROP_BY_ID[id]?.name || id;
  return n.replace(/\s*\((bush|pole)\)/, "").replace(/\s*\(.*\)/, "");
}

export const SPACES = {
  pots: { sqft: 8, plants: 3, label: "A few pots", hint: "Balcony, patio or steps" },
  bed: { sqft: 32, plants: 4, label: "One garden bed", hint: "About 4 by 8 feet" },
  yard: { sqft: 100, plants: 6, label: "A big patch", hint: "Part of a yard" },
};
export const SUNS = {
  full: { hours: 8, label: "Sunny all day", hint: "8 hours or more" },
  half: { hours: 5, label: "Sunny half the day", hint: "Morning or afternoon" },
  little: { hours: 3, label: "Not much sun", hint: "Under trees or buildings" },
};

export const isEasy = id => EASY.includes(id);
/** Does this plant do well with this much sun? (gives at least 80% of a full harvest) */
export const sunOk = (id, hours) => sunFactor(id, hours) >= 0.8;

/**
 * The starter garden: easy plants that suit the sun, favouring ones that can go in now
 * or soon, then the ones worth most here. Space is shared out evenly in whole square feet.
 * @param calendar  plantingCalendar() result
 * @param ranking   rankCrops() result (net $/sq ft for each crop here)
 */
export function starterPicks({ space = "bed", sun = "full", calendar, ranking = [] }) {
  const S = SPACES[space] || SPACES.bed, hours = (SUNS[sun] || SUNS.full).hours;
  const now = Object.fromEntries((calendar?.crops || []).map(c => [c.id, c.now]));
  const value = Object.fromEntries(ranking.map(r => [r.id, r.net_per_sqft ?? r.net ?? 0]));
  const timing = id => {
    const a = now[id]?.action;
    return a === "sow" ? 3 : a === "soon" ? 2 : a === "harvest" ? 1 : 0;
  };
  let pool = EASY.filter(id => CROP_BY_ID[id] && sunOk(id, hours));
  if (pool.length < S.plants) pool = EASY.filter(id => CROP_BY_ID[id] && sunFactor(id, hours) >= 0.6);   // shady spots: leafy greens still do fine
  if (pool.length < S.plants) pool = EASY.filter(id => CROP_BY_ID[id]).sort((a, b) => (SUN_NEED[a] ?? 6) - (SUN_NEED[b] ?? 6));
  if (space === "pots") pool = pool.filter(id => !["zucchini", "potato", "garlic"].includes(id));
  const ranked = pool.map((id, i) => ({ id, score: timing(id) * 10 + Math.min(5, Math.max(0, value[id] || 0)) - i * 0.15 }))
    .sort((a, b) => b.score - a.score).slice(0, S.plants);
  return share(ranked.map(x => x.id), S.sqft, hours);
}

/** Splits `sqft` across crops in whole square feet (at least 1 each). */
export function share(ids, sqft, sunHours = null) {
  if (!ids.length) return [];
  const each = Math.max(1, Math.floor(sqft / ids.length));
  let left = sqft - each * ids.length;
  return ids.map(id => {
    const extra = left > 0 ? 1 : 0; left -= extra;
    return { crop: id, sqft: each + extra, ...(Number.isFinite(sunHours) ? { sun: sunHours } : {}) };
  });
}

const DAY = 864e5;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

/**
 * One plain status for a plant.
 * @param item     plan entry {crop, sqft, planted?: "YYYY-MM-DD"}
 * @param calCrop  this crop's entry in plantingCalendar().crops
 * @param today    "YYYY-MM-DD"
 * Returns {kind, text, days?}; kind is plant | soon | wait | growing | ready | done.
 */
export function plantStatus(item, calCrop, today) {
  const c = CROP_BY_ID[item.crop];
  if (item.planted && c) {
    const age = daysBetween(item.planted, today), left = c.days - age;
    if (age < 0) return { kind: "growing", text: "Planted", days: c.days };
    if (left > 7) return { kind: "growing", text: `Ready in about ${left} days`, days: left };
    if (left > 0) return { kind: "growing", text: "Almost ready: check it every day", days: left };
    if (age <= c.days + 60) return { kind: "ready", text: "Ready to pick!" };
    return { kind: "done", text: "Finished? Pull it out or plant again" };
  }
  const now = calCrop?.now;
  if (!now) return { kind: "wait", text: "Plant when the season comes" };
  if (now.action === "sow") return { kind: "plant", text: "Plant now" };
  if (now.action === "harvest") return { kind: "plant", text: "Plant now for a later crop" };
  if (now.action === "soon") return { kind: "soon", text: now.text.replace("Plant from", "Plant from") };
  return { kind: "wait", text: now.text.replace("Next planting", "Plant from") };
}

/**
 * Today's checklist: this week's jobs, then planting and picking jobs for the plants
 * in the garden. Each item has a stable key so a tick survives a reload.
 */
export const CARE_KINDS = new Set(["water", "rain", "frost", "heat", "wind"]);
export function todayJobs({ actions = [], plan = [], calendar, today }) {
  const out = [], seen = new Set();
  const add = (key, title, detail, kind, info = false) => { if (seen.has(key)) return; seen.add(key); out.push({ key, title, detail, kind, ...(info ? { info } : {}) }); };
  const live = (plan || []).filter(p => p && p.sqft > 0);
  const growing = live.some(p => p.planted);
  // Watering and weather jobs only matter once something is in the ground.
  for (const a of actions || []) if (a && a.kind !== "calm" && (growing || !CARE_KINDS.has(a.kind))) add("w:" + a.title, a.title, a.detail || "", a.kind);
  const cal = Object.fromEntries((calendar?.crops || []).map(c => [c.id, c]));
  let next = null;
  for (const p of live) {
    const st = plantStatus(p, cal[p.crop], today), n = plainName(p.crop).toLowerCase();
    if (st.kind === "plant") add("p:" + p.crop, `Plant your ${n}`, "Then tap the plant in My Garden and press \"I planted it\".", "plant");
    else if (st.kind === "ready") add("h:" + p.crop, `Pick your ${n}`, "Picking often keeps most plants making more.", "harvest");
    const start = cal[p.crop]?.now?.start;
    if (!p.planted && (st.kind === "soon" || st.kind === "wait") && Number.isFinite(start) && (!next || start < next.start)) next = { start, crop: p.crop, text: st.text };
  }
  if (!out.length && next) add("n:" + next.crop, `Next up: your ${plainName(next.crop).toLowerCase()}`, next.text, "next", true);
  return out;
}

/** How a beginner logs a harvest without a scale. Pounds per scoop. */
export const SCOOPS = { handful: 0.25, bowl: 1, basket: 4 };

/** "This week" key for remembering ticked jobs (Monday-based). */
export function weekKey(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}

/** Morning / afternoon / evening greeting. */
export const greeting = (h = new Date().getHours()) => (h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening");

/** "Sunny and warm today, 78°F" style line from a forecast day. */
export function weatherWords(day, lang = "en") {
  if (!day || !Number.isFinite(day.tmax)) return null;
  const t = day.tmax, i = t >= 88 ? 0 : t >= 75 ? 1 : t >= 60 ? 2 : t >= 45 ? 3 : 4;
  const w = day.rain_in >= 0.25 ? 0 : day.rain_in >= 0.05 ? 1 : 2, frost = Number.isFinite(day.tmin) && day.tmin <= 32;
  if (lang === "es") {
    return `Hoy ${["hace calor", "hace calorcito", "está templado", "está fresco", "hace frío"][i]}${[" y llueve", " con algo de lluvia", " y seco"][w]}, máxima ${Math.round(t)}°F${frost ? ", helada esta noche" : ""}`;
  }
  return `${["Hot", "Warm", "Mild", "Cool", "Cold"][i]} ${["with rain", "with a little rain", "and dry"][w]} today, high ${Math.round(t)}°F${frost ? ", frost tonight" : ""}`;
}
