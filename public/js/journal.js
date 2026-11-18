// Garden journal: a daily log the app writes for you, that you can edit.
//
// Once a day the app writes one entry from what it already knows: today's
// weather, the most urgent jobs this week, what you picked since the last entry
// and what changed in your beds. Until you edit it, today's entry keeps itself
// up to date (the forecast may arrive after the page opens). Once you edit it,
// it's yours and the app leaves it alone. You can add your own notes, and
// summaries of chats with the garden assistant land here too.
//
// Entries: {id, date: "YYYY-MM-DD", kind: "auto"|"note"|"chat", title, lines: [..], edited, t}
// A deleted entry is kept as {id, deleted: true, t} so syncing doesn't bring it back.
// Pure functions over plain data; app.js keeps the journal in localStorage.

import { CROP_BY_ID } from "./economics.js";

export const KEEP = 400;                 // newest entries kept (about a year of daily logs plus notes)
export const MAX_LINE = 2000;

const short = id => (CROP_BY_ID[id]?.name || id).replace(/\s*\(.*\)/, "");
const r1 = v => Math.round(v * 10) / 10;

/** Local calendar date as YYYY-MM-DD. */
export function isoDay(d = new Date()) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const visible = journal => (Array.isArray(journal) ? journal : []).filter(e => e && !e.deleted && typeof e.id === "string");

/** Beds as {crop: sqft} for comparing one day's plan with the next. */
export function bedSnapshot(plan) {
  const out = {};
  for (const p of plan || []) if (p && p.crop && +p.sqft > 0) out[p.crop] = (out[p.crop] || 0) + Math.round(+p.sqft);
  return out;
}

/** Plain-English list of what changed between two bed snapshots. */
export function planChanges(before, after) {
  if (!before) return [];
  const out = [];
  for (const [c, s] of Object.entries(after)) {
    if (!(c in before)) out.push(`Added ${short(c)} (${s} sq ft)`);
    else if (before[c] !== s) out.push(`${short(c)}: ${before[c]} sq ft → ${s} sq ft`);
  }
  for (const c of Object.keys(before)) if (!(c in after)) out.push(`Removed ${short(c)}`);
  return out;
}

/** Weather line for one forecast day ({date, tmax, tmin, rain_in, pop}), or null. */
export function weatherLine(day) {
  if (!day || !Number.isFinite(day.tmax) || !Number.isFinite(day.tmin)) return null;
  const rain = day.rain_in >= 0.01 ? `${day.rain_in} in rain` : "dry";
  const chance = Number.isFinite(day.pop) && day.rain_in >= 0.01 ? ` (${Math.round(day.pop)}% chance)` : "";
  return `Weather: high ${Math.round(day.tmax)}°F, low ${Math.round(day.tmin)}°F, ${rain}${chance}`;
}

/**
 * Today's automatic entry.
 * @param date     YYYY-MM-DD (local)
 * @param days     parsed forecast days or null
 * @param actions  weekActions() result
 * @param log      harvest log [{id, crop, lb, date}]
 * @param since    YYYY-MM-DD of the previous automatic entry (harvests after it are listed), or null
 * @param before   bed snapshot from the previous automatic entry, or null
 * @param plan     current beds
 */
export function dailyEntry({ date, days = null, actions = [], log = [], since = null, before = null, plan = [] }, now = Date.now()) {
  const lines = [];
  const w = weatherLine((days || []).find(d => d.date === date));
  if (w) lines.push(w);
  const jobs = (actions || []).filter(a => a.kind !== "calm").slice(0, 3);
  for (const a of jobs) lines.push(`To do: ${a.title}`);
  if (!jobs.length) lines.push("Nothing urgent in the garden this week");
  const picked = {};
  for (const e of log || []) {
    if (!e || typeof e.date !== "string") continue;
    const d = e.date.slice(0, 10);
    if (d <= date && (since ? d > since : d === date)) picked[e.crop] = (picked[e.crop] || 0) + (+e.lb || 0);
  }
  for (const [c, lb] of Object.entries(picked)) lines.push(`Picked ${r1(lb)} lb of ${short(c).toLowerCase()}`);
  const snap = bedSnapshot(plan);
  for (const ch of planChanges(before, snap)) lines.push(`Beds: ${ch}`);
  return { id: "auto-" + date, date, kind: "auto", title: "Daily update", lines, edited: false, t: now, beds: snap };
}

/**
 * Adds or refreshes today's automatic entry. Returns the new journal, or the same
 * array if nothing changed. An entry the user edited or deleted is never touched.
 * `localize` turns each English line into the user's language and units.
 */
export function upsertDaily(journal, inputs, { now = Date.now(), localize = s => s } = {}) {
  const list = Array.isArray(journal) ? journal : [];
  const id = "auto-" + inputs.date;
  const existing = list.find(e => e && e.id === id);
  if (existing && (existing.edited || existing.deleted)) return list;
  const prev = list.filter(e => e && e.kind === "auto" && !e.deleted && e.date < inputs.date).sort((a, b) => b.date.localeCompare(a.date))[0];
  const entry = dailyEntry({ ...inputs, since: prev?.date ?? null, before: prev?.beds ?? null }, now);
  entry.title = localize(entry.title);
  entry.lines = entry.lines.map(localize);
  if (existing && JSON.stringify(existing.lines) === JSON.stringify(entry.lines) && existing.title === entry.title) return list;
  return trim([entry, ...list.filter(e => e && e.id !== id)]);
}

const newId = (kind, now) => `${kind}-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const cleanLines = text => String(text || "").replace(/\r/g, "").split("\n").map(s => s.trimEnd().slice(0, MAX_LINE)).filter((s, i, a) => s || (i > 0 && i < a.length - 1)).slice(0, 60);

export const MOODS = { great: "😄", good: "🙂", okay: "😐", worried: "😟", sad: "😢" };

export function addNote(journal, { title = "Note", text, date = isoDay(), kind = "note", mood = null, shared = null }, now = Date.now()) {
  const lines = cleanLines(text);
  const m = mood in MOODS ? mood : null;
  if (!lines.some(s => s.trim()) && !m) return null;
  const entry = { id: newId(kind, now), date, kind, title: String(title || "Note").slice(0, 120), lines, edited: false, t: now, ...(m ? { mood: m } : {}), ...(shared ? { shared } : {}) };
  return trim([entry, ...(Array.isArray(journal) ? journal : [])]);
}

export function editEntry(journal, id, { title, text }, now = Date.now()) {
  return (journal || []).map(e => e && e.id === id && !e.deleted
    ? { ...e, ...(title != null ? { title: String(title).slice(0, 120) || e.title } : {}), ...(text != null ? { lines: cleanLines(text) } : {}), edited: true, t: now }
    : e);
}

export function deleteEntry(journal, id, now = Date.now()) {
  return (journal || []).map(e => e && e.id === id ? { id, deleted: true, t: now, date: e.date } : e);
}

/** Keeps the newest KEEP entries (tombstones count too, so the journal can't grow forever). */
export function trim(journal) {
  return [...journal].sort((a, b) => String(b.date).localeCompare(String(a.date)) || (+b.t || 0) - (+a.t || 0)).slice(0, KEEP);
}

/** Journal as plain text, newest first, for copying or downloading. */
export function toText(journal) {
  return visible(journal).map(e => `${e.date} · ${e.title}\n${e.lines.map(l => "  " + l).join("\n")}`).join("\n\n") + "\n";
}

/**
 * What the garden assistant is told about this garden: rounded location, soil,
 * beds, this week's jobs, this year's harvest and recent journal lines. No
 * address, email or exact position. Capped at `max` characters.
 */
export function assistantContext({ place, lat, climate, soil, plan, actions, log, journal, year = new Date().getFullYear(), units = "us", language = "en" }, max = 5800) {
  const parts = [];
  if (place || Number.isFinite(lat)) parts.push(`Garden: ${place || ""}${Number.isFinite(lat) ? ` (latitude about ${Math.round(lat)}°, ${lat < 0 ? "southern" : "northern"} hemisphere)` : ""}`);
  if (climate) {
    const c = [];
    if (climate.last_spring_frost) c.push(`last spring frost about ${climate.last_spring_frost}`);
    if (climate.first_fall_frost) c.push(`first fall frost about ${climate.first_fall_frost}`);
    if (Number.isFinite(climate.frost_free_days)) c.push(`${climate.frost_free_days} frost-free days`);
    if (c.length) parts.push("Climate: " + c.join(", "));
  }
  if (soil) {
    const v = k => soil.values?.[k]?.value;
    const s = [];
    if (Number.isFinite(v("ph"))) s.push(`pH ${r1(v("ph"))}`);
    if (Number.isFinite(v("organic_matter_pct"))) s.push(`organic matter ${r1(v("organic_matter_pct"))}%`);
    if (Number.isFinite(v("p_ppm"))) s.push(`phosphorus ${Math.round(v("p_ppm"))} ppm`);
    if (Number.isFinite(v("k_ppm"))) s.push(`potassium ${Math.round(v("k_ppm"))} ppm`);
    if (soil.texture_class) s.push(`texture ${soil.texture_class}`);
    if (s.length) parts.push("Soil: " + s.join(", "));
  }
  const beds = Object.entries(bedSnapshot(plan)).map(([c, s]) => `${short(c)} ${s} sq ft`);
  parts.push("Beds: " + (beds.length ? beds.join(", ") : "none yet"));
  const jobs = (actions || []).filter(a => a.kind !== "calm").slice(0, 5).map(a => `- ${a.title}: ${a.detail}`);
  if (jobs.length) parts.push("This week:\n" + jobs.join("\n"));
  const picked = {};
  for (const e of log || []) if (e && String(e.date).startsWith(String(year))) picked[e.crop] = (picked[e.crop] || 0) + (+e.lb || 0);
  const p = Object.entries(picked).map(([c, lb]) => `${short(c)} ${r1(lb)} lb`);
  if (p.length) parts.push(`Picked this year: ${p.join(", ")}`);
  parts.push(`Show measurements in ${units === "metric" ? "metric units" : "US units"}; reply in ${language === "es" ? "Spanish" : "English"}.`);
  let text = parts.join("\n");
  const recent = visible(journal).slice(0, 8);
  if (recent.length) {
    let j = "\nRecent journal:";
    for (const e of recent) {
      const add = `\n${e.date} ${e.title}: ${e.lines.join("; ")}`.slice(0, 400);
      if (text.length + j.length + add.length > max) break;
      j += add;
    }
    text += j;
  }
  return text.slice(0, max);
}
