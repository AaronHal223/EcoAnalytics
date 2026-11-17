// Spanish (and the plumbing for more languages).
//
// The page is drawn in English. When Spanish is chosen, every piece of text
// the page draws is looked up in a phrase book after it's drawn. Numbers,
// prices, units, crop names, weekdays and dates are lifted out first and put
// back after, so one entry such as "Frost {w0} night (low {n0})" covers every
// frost warning. Crop, weekday and month names have their own small tables.
// Anything without an entry stays in English, so nothing ever breaks.

import { ES, ES_CROPS } from "./lang-es.js";

let current = "en";
export const lang = () => current;
export function setLang(l) { current = l === "es" ? "es" : "en"; }
export function defaultLang(nav = (typeof navigator !== "undefined" && navigator.language) || "en") {
  return /^es\b/i.test(nav) ? "es" : "en";
}

const WEEK = { Monday: "lunes", Tuesday: "martes", Wednesday: "miércoles", Thursday: "jueves", Friday: "viernes", Saturday: "sábado", Sunday: "domingo",
  Mon: "lunes", Tue: "martes", Wed: "miércoles", Thu: "jueves", Fri: "viernes", Sat: "sábado", Sun: "domingo" };
const MON = { Jan: "ene", Feb: "feb", Mar: "mar", Apr: "abr", May: "may", Jun: "jun", Jul: "jul", Aug: "ago", Sep: "sep", Oct: "oct", Nov: "nov", Dec: "dic" };

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
let CROP_RE = null;
function cropRe() {
  if (!CROP_RE) {
    const names = Object.keys(ES_CROPS).sort((a, b) => b.length - a.length).map(esc);
    CROP_RE = new RegExp(`(?<![\\w])(${names.join("|")})(?![\\w])`, "g");
  }
  return CROP_RE;
}
const DATE_RE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})\b/g;
const MONTH_RE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g;
const WEEK_RE = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/g;
const UNIT = String.raw`(?:\s?(?:sq ft|m²|m³|kg\/m²|lb\/sq ft|L\/m²|gal\/sq ft|lbs?|kg|gal|L|°F|°C|in|cm|mm|ft|m|km\/h|mph|oz|g|%|h|°))?`;
const CUR = String.raw`(?:[−-]?(?:[$€£¥₹₱₦]|R\$|[A-Z]{1,3}\$|R |CHF |kr |zł |KSh )?)`;
const NUM_RE = new RegExp(String.raw`(?<!\{[dwcmn]\d*)${CUR}\d(?:,?\d)*(?:\.\d+)?(?:\s?[-–]\s?\d(?:,?\d)*(?:\.\d+)?)?${UNIT}(?![\w])|${CUR}\.\d+${UNIT}`, "g");

/** Lifts out dates, weekdays, crop names and numbers; returns the phrase-book key and what was lifted. */
export function normalize(text) {
  const t = { d: [], w: [], c: [], n: [], m: [] };
  let k = text.replace(DATE_RE, (m) => `{d${t.d.push(m) - 1}}`);
  k = k.replace(MONTH_RE, m => `{m${t.m.push(m) - 1}}`);
  k = k.replace(WEEK_RE, m => `{w${t.w.push(m) - 1}}`);
  k = k.replace(cropRe(), m => `{c${t.c.push(m) - 1}}`);
  k = k.replace(NUM_RE, m => `{n${t.n.push(m) - 1}}`);
  return { key: k, t };
}

function fill(tpl, t) {
  return tpl.replace(/\{([dwcnm])(\d+)\}/g, (_, kind, i) => {
    const v = t[kind][+i];
    if (v == null) return "";
    if (kind === "w") return WEEK[v] || v;
    if (kind === "m") return MON[v] || v;
    if (kind === "d") { const [m, d] = v.split(" "); return `${d} ${MON[m] || m}`; }
    if (kind === "c") return ES_CROPS[v] || v;
    return v.replace(/sq ft/, "pie²").replace(/\blbs?\b/, "lb").replace(/\bgal\b/, "gal");
  });
}

/** Spanish for one piece of text, or the text unchanged if the phrase book doesn't have it. */
export function translateText(text) {
  if (current !== "es" || !text || !/[A-Za-z]/.test(text)) return text;
  const lead = text.match(/^\s*/)[0], trail = text.match(/\s*$/)[0], core = text.trim();
  if (!core) return text;
  if (ES[core]) return lead + ES[core] + trail;
  const { key, t } = normalize(core);
  const tpl = ES[key];
  if (tpl != null) return lead + fill(tpl, t) + trail;
  // A bare crop name or list of them.
  if (ES_CROPS[core]) return lead + ES_CROPS[core] + trail;
  return text;
}

const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "CODE"]);
const done = new WeakMap();   // text node -> the Spanish we wrote (so we don't translate twice)

export function translateTree(root) {
  if (current !== "es" || !root) return;
  const doc = root.ownerDocument || root;
  const w = doc.createTreeWalker(root, 4);
  const nodes = [];
  for (let n = w.nextNode(); n; n = w.nextNode()) nodes.push(n);
  for (const n of nodes) {
    if (done.get(n) === n.nodeValue) continue;
    let skip = false;
    for (let el = n.parentElement; el; el = el.parentElement) { if (SKIP.has(el.tagName) || el.getAttribute?.("translate") === "no") { skip = true; break; } }
    if (skip) continue;
    const out = translateText(n.nodeValue);
    if (out !== n.nodeValue) n.nodeValue = out;
    done.set(n, n.nodeValue);
  }
  for (const el of root.querySelectorAll?.("[placeholder],[aria-label],[title]") || []) {
    for (const a of ["placeholder", "aria-label", "title"]) {
      const v = el.getAttribute(a);
      if (v) { const o = translateText(v); if (o !== v) el.setAttribute(a, o); }
    }
  }
  for (const o of root.querySelectorAll?.("option") || []) { const v = o.textContent, t = translateText(v); if (t !== v) o.textContent = t; }
}

let obs = null;
export function watch(root) {
  if (current !== "es" || obs || typeof MutationObserver === "undefined") return;
  translateTree(root);
  let queued = false;
  const opts = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["placeholder", "aria-label", "title"] };
  obs = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    // After the units converter (also a microtask), so phrases are matched once units are final.
    setTimeout(() => { queued = false; obs.disconnect(); translateTree(root); obs.observe(root, opts); }, 0);
  });
  obs.observe(root, opts);
}
