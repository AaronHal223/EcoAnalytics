// Metric units.
//
// The models all work in US units (that's what the soil surveys, seed packets
// and price data use). For the rest of the world we convert at display time:
// once the page has drawn a number with a unit ("16 sq ft", "41.2 lb",
// "low 31°F", "$2.14/sq ft"), the text is rewritten in metric. Inputs that take
// a size or a weight are converted both ways by the app.
//
// convertText() is a pure function so every pattern is tested. The DOM watcher
// re-applies it whenever the page redraws, and skips anything already metric.

export const SQFT_PER_M2 = 10.7639;
export const KG_PER_LB = 0.453592;
export const L_PER_GAL = 3.78541;
export const CM_PER_IN = 2.54;
export const M_PER_FT = 0.3048;
export const KMH_PER_MPH = 1.60934;

let metric = false;
export const isMetric = () => metric;
export function setMetric(on) { metric = !!on; }

/** Countries that use US customary units day to day. Everyone else defaults to metric. */
export function defaultMetric(lang = (typeof navigator !== "undefined" && navigator.language) || "en-US") {
  const region = (String(lang).split(/[-_]/)[1] || "").toUpperCase();
  if (!region) return !/^en$/i.test(lang);
  return !["US", "LR", "MM", "PR", "GU", "VI", "AS", "MP", "UM"].includes(region);
}

const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+`;
const RANGE = String.raw`(-?(?:${NUM}))(?:(\s?[-–]\s?|\s(?:to)\s)(${NUM}))?`;
const toNum = s => parseFloat(String(s).replace(/,/g, ""));

/** Rounds sensibly for display: big numbers to whole, small ones to 1-2 decimals. */
export function nice(v, { money = false, whole = false } = {}) {
  if (!Number.isFinite(v)) return String(v);
  if (whole) { const w = Math.round(v); return String(w === 0 ? 0 : w); }
  if (money) return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const a = Math.abs(v);
  const d = a >= 100 ? 0 : a >= 10 ? (Number.isInteger(Math.round(v * 10) / 10) ? 0 : 1) : a >= 1 ? 1 : 2;
  const s = v.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: 0 });
  return s === "-0" ? "0" : s;
}

function range(m, f, opts) {
  const a = nice(f(toNum(m[1])), opts);
  return m[3] !== undefined ? `${a}${m[2]}${nice(f(toNum(m[3])), opts)}` : a;
}

const F2C = f => (f - 32) * 5 / 9;
const inches = v => v * CM_PER_IN;

// Order matters: compound units before simple ones.
const RULES = [
  // $ per square foot
  [new RegExp(String.raw`(-?)\$(${NUM})(\s*(?:/|per ))\s*sq\.? ?ft\b`, "g"),
    (m) => `${m[1]}$${nice(toNum(m[2]) * SQFT_PER_M2, { money: true })}${m[3].trim() === "/" ? "/" : " per "}m²`],
  [new RegExp(String.raw`${RANGE}\s*lb/sq ?ft\b`, "g"), m => `${range(m, v => v * KG_PER_LB * SQFT_PER_M2)} kg/m²`],
  [new RegExp(String.raw`${RANGE}\s*gal/sq ?ft\b`, "g"), m => `${range(m, v => v * L_PER_GAL * SQFT_PER_M2)} L/m²`],
  [new RegExp(String.raw`${RANGE}\s*(?:plants? )?per (\d+ )?sq ?ft\b`, "g"), m => m[0]],   // handled below (counts per area)
  [new RegExp(String.raw`\$(${NUM})\s*(?:per|/)\s*1,?000 gal(?:lons)?\b`, "g"), m => `$${nice(toNum(m[1]) / L_PER_GAL, { money: true })} per m³`],
  [new RegExp(String.raw`(?:per|/)\s*1,?000 gal(?:lons)?\b`, "g"), () => "per m³"],
  [new RegExp(String.raw`${RANGE}\s*(?:sq\.? ?ft|square feet|square foot)\b`, "g"), m => `${range(m, v => v / SQFT_PER_M2)} m²`],
  [new RegExp(String.raw`${RANGE}\s*(?:lbs?|pounds?)\b`, "g"), m => `${range(m, v => v * KG_PER_LB)} kg`],
  [new RegExp(String.raw`${RANGE}\s*gal(?:lons?)?\b`, "g"), m => `${range(m, v => v * L_PER_GAL)} L`],
  [new RegExp(String.raw`${RANGE}\s?°F\b`, "g"), m => `${range(m, F2C, { whole: true })}°C`],
  [new RegExp(String.raw`${RANGE}\s*mph\b`, "g"), m => `${range(m, v => v * KMH_PER_MPH)} km/h`],
  [new RegExp(String.raw`${RANGE}\s*oz\b`, "g"), m => `${range(m, v => v * 28.3495)} g`],
  [new RegExp(String.raw`(\d+)/(\d+) in(?:ch(?:es)?)?(?=\s+(?:across|apart|deep|tall|long|wide|thick|high|of|a week|per|above|below|down|layer|rain|water|more|less|or|and)\b|\s*[.,;:)]|\s*$)`, "g"),
    m => `${nice(inches(+m[1] / +m[2]))} cm`],
  [new RegExp(String.raw`${RANGE}\s*(?:in|inch|inches)(?=\s+(?:across|apart|deep|tall|long|wide|thick|high|of|a week|per|above|below|down|layer|rain|water|more|less|or|and)\b|\s*[.,;:)]|\s*$)`, "g"),
    m => { const v = toNum(m[1]); return v < 0.8 && m[3] === undefined ? `${nice(v * 25.4)} mm` : `${range(m, inches)} cm`; }],
  [new RegExp(String.raw`${RANGE}\s*(?:ft|feet|foot)\b`, "g"), m => `${range(m, v => v * M_PER_FT)} m`],
  // Bare unit labels (headers like "Water gal/sq ft", "lb/sq ft", "sq ft planted").
  [/\blb\/sq ?ft\b/g, () => "kg/m²"],
  [/\bgal\/sq ?ft\b/g, () => "L/m²"],
  [/\$\/sq ?ft\b/g, () => "$/m²"],
  [/(\s|^|\/)sq\.? ?ft\b/g, m => `${m[1]}m²`],
  [/\bper square foot\b/g, () => "per square metre"],
  [/\bsquare foot\b/g, () => "square metre"],
  [/°F\b/g, () => "°C"],
];

// "1 plant per 4 sq ft", "9 per sq ft": counts per area become per m².
const PER_AREA = new RegExp(String.raw`(?<![$\d.,])(\d+(?:\.\d+)?)( plants?| cloves?)? per (?:(\d+)(?:-(\d+))? )?sq ?ft\b`, "g");

/** Rewrites US units in `text` as metric. Text already in metric passes through unchanged. */
export function convertText(text) {
  if (!text || !/(sq\.? ?ft|square f|lb|pound|gal|°F|mph|\bin\b|inch|\bft\b|feet|foot|\boz\b)/.test(text)) return text;
  let s = text.replace(PER_AREA, (_, n, what = "", a1, a2) => {
    const at = area => toNum(n) / area * SQFT_PER_M2;
    const lo = a2 ? at(toNum(a2)) : null, hi = at(a1 ? toNum(a1) : 1);
    const plural = what && (lo ?? hi) !== 1 && !/s$/.test(what) ? what + "s" : (what || "");
    return `${lo != null ? nice(lo) + "-" : ""}${nice(hi)}${plural} per m²`;
  });
  for (const [re, f] of RULES) s = s.replace(re, (...a) => {
    const m = a.slice(0, -2);   // drop offset and input
    if (typeof m[m.length - 1] === "object") m.pop();
    return f(m);
  });
  return s;
}

// Split values: "<strong>$5.79</strong>/sq ft" puts the number and the unit in different nodes.
const SPLIT_UNIT = /^(\s*)(\/sq ?ft|sq ?ft|lb\/sq ?ft|gal\/sq ?ft|lbs?|gal|°F)\b/;
const SPLIT_FN = {
  "/sq ft": v => v * SQFT_PER_M2, "sq ft": v => v / SQFT_PER_M2, "lb/sq ft": v => v * KG_PER_LB * SQFT_PER_M2,
  "gal/sq ft": v => v * L_PER_GAL * SQFT_PER_M2, lb: v => v * KG_PER_LB, lbs: v => v * KG_PER_LB, gal: v => v * L_PER_GAL, "°F": F2C,
};
const SPLIT_LABEL = { "/sq ft": "/m²", "sq ft": "m²", "lb/sq ft": "kg/m²", "gal/sq ft": "L/m²", lb: "kg", lbs: "kg", gal: "L", "°F": "°C" };

/** Converts a number that sits in its own element just before a unit. Returns the new text or null. */
export function convertSplit(numberText, unitText) {
  const u = SPLIT_UNIT.exec(unitText);
  if (!u) return null;
  const key = u[2].replace(/sq ?ft/, "sq ft");
  const m = /(-?)(\$?)(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*$/.exec(numberText);
  if (!m) return null;
  const v = SPLIT_FN[key](toNum(m[3])) * (m[1] ? -1 : 1);
  const money = !!m[2];
  const shown = money ? `${v < 0 ? "-" : ""}$${nice(Math.abs(v), { money: true })}` : nice(v);
  return { number: numberText.slice(0, m.index) + shown, unit: unitText.replace(SPLIT_UNIT, `$1${SPLIT_LABEL[key]}`) };
}

// ---- DOM ----------------------------------------------------------------------------------------------
const SKIP = new Set(["SCRIPT", "STYLE", "INPUT", "TEXTAREA", "SELECT", "OPTION", "CODE"]);
function skip(node) {
  for (let el = node.parentElement; el; el = el.parentElement) {
    if (SKIP.has(el.tagName) || el.dataset?.units === "us") return true;
  }
  return false;
}

export function convertTree(root) {
  if (!metric || !root) return;
  const doc = root.ownerDocument || root;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  for (const n of nodes) {
    if (skip(n)) continue;
    const t = n.nodeValue;
    // A unit that starts this node with its number in the element just before it.
    const prev = n.previousSibling || (n.parentNode && n.parentNode.firstChild === n ? n.parentNode.previousSibling : null);
    if (prev && prev.nodeType === 1 && SPLIT_UNIT.test(t) && prev.childNodes.length === 1 && prev.firstChild.nodeType === 3) {
      const c = convertSplit(prev.textContent, t);
      if (c) { prev.firstChild.nodeValue = c.number; n.nodeValue = convertText(c.unit); continue; }
    }
    const out = convertText(t);
    if (out !== t) n.nodeValue = out;
  }
  // Labels in a few attributes people see.
  for (const el of root.querySelectorAll?.("[placeholder],[aria-label],[title]") || []) {
    for (const a of ["placeholder", "aria-label", "title"]) {
      const v = el.getAttribute(a);
      if (v) { const o = convertText(v); if (o !== v) el.setAttribute(a, o); }
    }
  }
}

let observer = null;
/** Keeps the page metric as it redraws. */
export function watch(root) {
  if (!metric || observer || typeof MutationObserver === "undefined") return;
  convertTree(root);
  let queued = false;
  observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; observer.disconnect(); convertTree(root); observer.observe(root, OPTS); });
  });
  observer.observe(root, OPTS);
}
const OPTS = { childList: true, subtree: true, characterData: true };

// ---- Inputs ----------------------------------------------------------------------------------------------
export const area = { toShown: sqft => metric ? Math.round(sqft / SQFT_PER_M2 * 10) / 10 : sqft, fromShown: v => metric ? +v * SQFT_PER_M2 : +v, label: () => metric ? "m²" : "sq ft" };
export const weight = { toShown: lb => metric ? Math.round(lb * KG_PER_LB * 100) / 100 : lb, fromShown: v => metric ? +v / KG_PER_LB : +v, label: () => metric ? "kg" : "lb" };
/** Water price: $ per 1,000 gal internally, $ per m³ shown in metric. */
export const waterPrice = { toShown: p => metric ? Math.round(p / (1000 * L_PER_GAL / 1000) * 100) / 100 : p, fromShown: v => metric ? +v * L_PER_GAL : +v };
