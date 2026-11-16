// Sharing, reminders and backup, with no accounts and no server.
//
//  * Share a plan as a link: the plan is packed into the part of the URL after
//    "#", which browsers never send to any server. Whoever opens it sees your
//    beds worked out for *their* own soil and weather.
//  * Reminders: the planting calendar as an .ics file that any phone or
//    computer calendar (Apple, Google, Outlook) imports, with an alert the
//    day before each window opens.
//  * Backup: everything the app keeps in this browser in one small file you
//    can restore on another phone or after clearing the browser.

import { CROP_BY_ID } from "./economics.js";

const VERSION = 1;

const b64url = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = s => decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4))));

/** Compact, URL-safe text for a plan [{crop, sqft, sun?}]. */
export function encodePlan(plan) {
  const rows = plan.filter(p => CROP_BY_ID[p.crop] && p.sqft > 0)
    .map(p => Number.isFinite(p.sun) ? [p.crop, Math.round(p.sqft), Math.round(p.sun * 10) / 10] : [p.crop, Math.round(p.sqft)]);
  return b64url(JSON.stringify({ v: VERSION, p: rows }));
}

/** Plan from shared text, or null if it isn't a valid plan. Anything unknown is dropped. */
export function decodePlan(text) {
  try {
    const o = JSON.parse(unb64url(String(text)));
    if (!o || o.v !== VERSION || !Array.isArray(o.p)) return null;
    const plan = o.p.filter(r => Array.isArray(r) && CROP_BY_ID[r[0]] && Number.isFinite(+r[1]) && +r[1] > 0 && +r[1] <= 10000)
      .slice(0, 50).map(r => ({ crop: r[0], sqft: Math.round(+r[1]), ...(typeof r[2] === "number" && Number.isFinite(r[2]) ? { sun: Math.max(0, Math.min(16, +r[2])) } : {}) }));
    return plan.length ? plan : null;
  } catch { return null; }
}

export function planFromHash(hash) {
  const m = /(?:^#|&)plan=([A-Za-z0-9_-]+)/.exec(hash || "");
  return m ? decodePlan(m[1]) : null;
}

// ---- Calendar (.ics) ---------------------------------------------------------------------------
const pad = n => String(n).padStart(2, "0");
function doyToDate(year, doy) { return new Date(Date.UTC(year, 0, 1) + (doy - 1) * 864e5); }
const icsDate = d => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const icsText = s => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

/**
 * .ics text for the plan's planting and harvest windows from a plantingCalendar() result.
 * Windows that have already ended this year are moved to next year. `now` is a Date.
 */
export function buildICS(calendar, now = new Date(), url = "") {
  const year = now.getUTCFullYear(), today = Math.floor((Date.UTC(year, now.getUTCMonth(), now.getUTCDate()) - Date.UTC(year, 0, 1)) / 864e5) + 1;
  const stamp = `${icsDate(now)}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}00Z`;
  const crops = calendar.crops.filter(c => c.inPlan);
  const events = [];
  for (const c of crops) {
    for (const w of c.windows) {
      let y = year + (w.nextYear ? 1 : 0);
      if (!w.nextYear && w.end < today) y += 1;
      const start = doyToDate(y, w.start), end = doyToDate(y, w.end + 1);   // DTEND is exclusive
      const verb = w.kind === "sow" ? "Plant" : "Harvest";
      const what = c.name.replace(/\s*\(.*\)/, "").toLowerCase();
      events.push([
        "BEGIN:VEVENT",
        `UID:eco-${c.id}-${w.kind}-${w.season}-${y}@ecoanalytics`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${icsDate(start)}`,
        `DTEND;VALUE=DATE:${icsDate(end)}`,
        `SUMMARY:${icsText(`${verb} ${what}`)}`,
        `DESCRIPTION:${icsText(`${verb} window for ${c.name}, worked out for your frost dates and soil by EcoAnalytics.${c.notes[0] ? "\n" + c.notes[0] : ""}${url ? "\n" + url : ""}`)}`,
        "TRANSP:TRANSPARENT",
        "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsText(`${verb} ${what} from tomorrow`)}`, "TRIGGER:-PT15H", "END:VALARM",
        "END:VEVENT",
      ].join("\r\n"));
    }
  }
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//EcoAnalytics//Garden calendar//EN", "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:My garden (EcoAnalytics)", ...events, "END:VCALENDAR"].join("\r\n") + "\r\n";
}

// ---- Backup ----------------------------------------------------------------------------------------
/** Keys worth backing up: the user's own data, not cached lookups (those are re-fetched). */
export const isUserKey = k => k.startsWith("eco:") && !/^eco:(research|forecast|history):/.test(k);

export function makeBackup(storage, now = new Date()) {
  const data = {};
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && isUserKey(k)) data[k] = storage.getItem(k);
  }
  return JSON.stringify({ app: "ecoanalytics", version: VERSION, saved: now.toISOString(), data }, null, 1);
}

/** Validates a backup file's text; returns the key/value pairs to restore, or throws a readable error. */
export function readBackup(text) {
  let o;
  try { o = JSON.parse(text); } catch { throw new Error("That file isn't an EcoAnalytics backup."); }
  if (!o || o.app !== "ecoanalytics" || typeof o.data !== "object" || !o.data) throw new Error("That file isn't an EcoAnalytics backup.");
  const out = {};
  for (const [k, v] of Object.entries(o.data)) {
    if (!isUserKey(k) || typeof v !== "string" || v.length > 500000) continue;
    try { JSON.parse(v); } catch { continue; }
    out[k] = v;
  }
  if (!Object.keys(out).length) throw new Error("That backup has nothing to restore.");
  return out;
}
