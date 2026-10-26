// EcoAnalytics page logic. Runs entirely in the browser.
//
// Layout: one page, two modes chosen from the screen size.
//   "web" (wider than 760px): website layout, tabs on top, cards side by side
//   "app" (760px and narrower): phone-app layout, bottom tab bar, card lists
// CSS does the heavy lifting; this file mirrors the mode on <html data-layout>
// and redraws charts sized for it. Installed to a home screen it runs
// full-screen like a native app (see manifest.webmanifest + sw.js).

import { locateByIP, locateByZip, locateByAddress, locateByDevice } from "./geo.js";
import { researchSoilBase, applySoilTest } from "./soil.js";
import { getClimate, MONTHS } from "./climate.js";
import { CROPS } from "./data.js";
import { rankCrops, gardenROI } from "./economics.js";
import { plantingCalendar, localDoy, describeWindows, dayLabel } from "./planner.js";
import { getForecast, wateringAdvice } from "./forecast.js";
import { predictedLb, sqftOf, makeEntry, loggedLb, finishSeason, factorsFromHistory, toCSV } from "./calibration.js";
import { explain } from "./provenance.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const money = (v, d = 2) => v == null ? "—" : (v < 0 ? "−$" : "$") + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const fmt = (v, d = 1) => v == null ? "—" : Number(v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 });
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const store = {
  get(k, d) { try { const v = localStorage.getItem("eco:" + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("eco:" + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const DEFAULT_PLAN = [{ crop: "tomato", sqft: 16 }, { crop: "lettuce", sqft: 8 }, { crop: "basil", sqft: 4 }, { crop: "pepper", sqft: 4 }];

let SOILTEST = store.get("soiltest", null);
let LOCATION = null, BASE = null, LAST = null;
// Saved data is untrusted: anything unexpected is dropped rather than allowed to break the page.
const asArray = v => Array.isArray(v) ? v : [];
const asObject = v => v && typeof v === "object" && !Array.isArray(v) ? v : {};
// A saved plan that is not a list is corrupt: start from the default. A saved empty list is a choice: keep it.
const savedPlan = store.get("plan", DEFAULT_PLAN);
let PLAN = (Array.isArray(savedPlan) ? savedPlan : DEFAULT_PLAN).filter(p => p && CROPS.some(c => c.id === p.crop))
  .map(p => ({ crop: p.crop, sqft: Math.max(0, +p.sqft || 0) }));
let LOG = asArray(store.get("harvests", [])).filter(e => e && typeof e === "object" && CROPS.some(c => c.id === e.crop) && typeof e.id === "string"
  && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && Number.isFinite(+e.lb) && +e.lb > 0).map(e => ({ ...e, lb: +e.lb }));
let CALIB = asObject(store.get("calib", {}));
let FORECAST = null, FSTATE = "idle", FKEY = "";   // FSTATE: idle | loading | ok | failed
let CAL_SCOPE = store.get("calscope", "plan") === "all" ? "all" : "plan";

// ---- Layout: web vs app ------------------------------------------------------------
const appQuery = matchMedia("(max-width: 760px)");
const isApp = () => appQuery.matches;
function applyLayout() {
  document.documentElement.dataset.layout = isApp() ? "app" : "web";
  if (LAST) renderAll(LAST);
}
appQuery.addEventListener("change", applyLayout);
applyLayout();

// ---- Toast ------------------------------------------------------------------------------
let toastTimer;
const LEAF = `<svg class="spin" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19C5 10 10 5 20 4c-1 10-6 15-15 15zm0 0 7-7"/></svg>`;
function toast(msg, { error = false, sticky = false } = {}) {
  const t = $("#toast");
  t.innerHTML = (sticky && !error ? LEAF : "") + `<span>${esc(msg)}</span>`;
  t.className = "toast" + (error ? " err" : "");
  t.style.display = msg ? "flex" : "none";
  clearTimeout(toastTimer);
  if (msg && !sticky) toastTimer = setTimeout(() => (t.style.display = "none"), 4500);
}

// While the user drags a slider or types, re-render without entrance animations.
let liveT;
function markLive() {
  document.body.classList.add("live");
  clearTimeout(liveT);
  liveT = setTimeout(() => document.body.classList.remove("live"), 600);
}
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Counts numbers up from zero on fresh renders ("$1,234", "56 gal", "3.5 oz"…). */
function countUp(root) {
  if (reducedMotion() || document.body.classList.contains("live")) return;
  for (const el of root.querySelectorAll(".big.num")) {
    const text = el.textContent, m = text.match(/-?[\d,]*\.?\d+/);
    if (!m) continue;
    const target = parseFloat(m[0].replace(/,/g, ""));
    if (!Number.isFinite(target) || target === 0) continue;
    const dec = (m[0].split(".")[1] || "").length, pre = text.slice(0, m.index), post = text.slice(m.index + m[0].length);
    const t0 = performance.now(), dur = 700;
    const step = now => {
      const p = Math.min(1, (now - t0) / dur), e = 1 - (1 - p) ** 3;
      el.textContent = pre + (target * e).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec }) + post;
      if (p < 1) requestAnimationFrame(step); else el.textContent = text;
    };
    requestAnimationFrame(step);
  }
}

function setFill(range) {
  const min = +range.min || 0, max = +range.max || 100;
  range.style.setProperty("--fill", `${(+range.value - min) / (max - min) * 100}%`);
}
function busy(on, msg) {
  toast(on ? (msg || "Researching your soil…") : "", { sticky: on });
  $$("button.btn").forEach(b => (b.disabled = on));
}

// ---- Theme -------------------------------------------------------------------------------
{
  const t = store.get("theme", null);
  if (t) document.documentElement.dataset.theme = t;
  $("#themeBtn").onclick = () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = dark ? "light" : "dark";
    store.set("theme", document.documentElement.dataset.theme);
    if (LAST) renderAll(LAST);
  };
}

// ---- Install as an app (PWA) ---------------------------------------------------------------
let deferredInstall = null;
addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferredInstall = e; $("#installBtn").classList.add("show"); });
addEventListener("appinstalled", () => $("#installBtn").classList.remove("show"));
$("#installBtn").onclick = async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  $("#installBtn").classList.remove("show");
};
if ("serviceWorker" in navigator && location.protocol === "https:") {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

// ---- Tabs ------------------------------------------------------------------------------------
function showTab(name) {
  $$("nav.tabs button").forEach(x => x.classList.toggle("on", x.dataset.tab === name));
  $$("section.tab").forEach(s => s.classList.toggle("on", s.id === "tab-" + name));
  if (isApp()) scrollTo({ top: 0, behavior: "smooth" });
  if (LAST) requestAnimationFrame(() => { renderCharts(LAST); countUp($("#tab-" + name)); });  // charts size to their now-visible card
  store.set("tab", name);
}
$$("nav.tabs button").forEach(b => (b.onclick = () => showTab(b.dataset.tab)));

// ---- Location --------------------------------------------------------------------------------
$("#locToggle").onclick = () => {
  const open = $("#locBox").classList.toggle("open");
  $("#locToggle").setAttribute("aria-expanded", open);
  $("#locToggle").textContent = open ? "Close" : "Change";
  if (open) $("#addrInput").focus();
};
function openLocation(open) {
  $("#locBox").classList.toggle("open", open);
  $("#locToggle").textContent = open ? "Close" : "Change";
}

function showLocation(loc) {
  LOCATION = loc;
  store.set("location", loc);
  $("#locLabel").textContent = loc.label || `${loc.lat.toFixed(3)}, ${loc.lon.toFixed(3)}`;
  const chip = $("#locChip");
  chip.hidden = false;
  const names = { device: "Device GPS", address: "Street address", zip: "ZIP code", ip: "Internet connection", fallback: "Rough estimate" };
  chip.className = "chip " + (loc.precision_km <= 0.6 ? "hi" : loc.precision_km <= 5 ? "med" : "lo");
  const p = loc.precision_km;
  chip.textContent = `${names[loc.source] || loc.source} · ±${p < 1 ? Math.round(p * 1000) + " m" : Math.round(p) + " km"}`;
  const v = $("#vpnBox");
  if (loc.vpn_suspected) {
    v.hidden = false;
    v.innerHTML = `<strong>Looks like you're on a VPN.</strong> Your connection points somewhere else, so soil from that spot would be wrong. Enter your address or ZIP, or use device location.<ul>${loc.vpn_reasons.map(r => `<li>${esc(r)}</li>`).join("")}</ul>`;
    openLocation(true);
  } else {
    v.hidden = true;
    openLocation(false);
  }
}

async function locate(fn, msg) {
  busy(true, msg || "Finding your garden…");
  try {
    const loc = await fn();
    showLocation(loc);
    if (loc.vpn_suspected) { busy(false); $("#addrInput").focus(); return; }
    await research();
  } catch (e) {
    busy(false);
    toast(e.message || "Something went wrong.", { error: true });
  }
}

$("#addrBtn").onclick = () => {
  const v = $("#addrInput").value.trim();
  if (!v) return $("#addrInput").focus();
  locate(/^\d{5}(-\d{4})?$/.test(v) ? () => locateByZip(v.slice(0, 5)) : () => locateByAddress(v), "Looking up that address…");
};
$("#addrInput").onkeydown = e => { if (e.key === "Enter") $("#addrBtn").click(); };
$("#gpsBtn").onclick = () => {
  if (!navigator.geolocation) return toast("This browser can't share its location.", { error: true });
  busy(true, "Waiting for device location…");
  navigator.geolocation.getCurrentPosition(
    p => locate(async () => locateByDevice(p.coords.latitude, p.coords.longitude)),
    () => { busy(false); toast("Location permission was denied. Enter an address or ZIP instead.", { error: true }); },
    { enableHighAccuracy: true, timeout: 15000 });
};

// ---- Research (network, cached 30 days) + economics (instant) -----------------------------------
const CACHE_DAYS = 30;
function cacheKey(loc) { return `research:v1:${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}:${loc.precision_km}:${loc.state || ""}`; }

async function research() {
  if (!LOCATION) return;
  const key = cacheKey(LOCATION);
  const hit = store.get(key, null);
  if (hit && Date.now() - hit.t < CACHE_DAYS * 864e5) {
    BASE = hit;
  } else {
    busy(true, "Researching your soil and weather…");
    const [soil, climate] = await Promise.all([researchSoilBase(LOCATION), getClimate(LOCATION.lat, LOCATION.lon)]);
    BASE = { soil, climate, t: Date.now() };
    // Only cache results that came from the real services.
    if (!soil.sources.some(s => s.startsWith("Regional")) && !climate.source.startsWith("Latitude")) store.set(key, BASE);
  }
  busy(false);
  recompute();
  loadForecast();   // not awaited: the rest of the page never waits on the forecast
}

// 7-day forecast: cached two hours, and any failure just hides the day-by-day card.
async function loadForecast() {
  const loc = LOCATION;
  if (!loc) return;
  const key = `${loc.lat.toFixed(2)},${loc.lon.toFixed(2)}`;
  FKEY = key;
  const hit = store.get("forecast:" + key, null);
  if (hit && Array.isArray(hit.days) && Date.now() - hit.t < 2 * 36e5) { FORECAST = hit.days; FSTATE = "ok"; recompute(); return; }
  FORECAST = null; FSTATE = "loading";
  if (LAST) renderForecast(LAST);
  try {
    const days = await getForecast(loc.lat, loc.lon);
    if (FKEY !== key) return;   // location changed while waiting
    FORECAST = days; FSTATE = "ok";
    store.set("forecast:" + key, { t: Date.now(), days });
  } catch {
    if (FKEY !== key) return;
    FORECAST = null; FSTATE = "failed";
  }
  recompute();
}

function settings() {
  return {
    waterRate: Math.max(0, +$("#waterRate").value || 0),
    method: $("#irrigation").value,
    setupCost: Math.max(0, +$("#setupCost").value || 0),
    setupYears: Math.max(1, Math.round(+$("#setupYears").value || 1)),
    organicOnly: $("#organicOnly").checked,
    laborHrPer100Week: Math.max(0, parseFloat($("#laborHrs").value) || 0),
    hourlyWage: Math.max(0, parseFloat($("#hourlyWage").value) || 0),
  };
}

function recompute() {
  if (!BASE) return;
  const soil = applySoilTest(BASE.soil, SOILTEST);
  const plan = PLAN.filter(p => p.sqft > 0);
  const s = { ...settings(), yieldAdjust: factorsFromHistory(CALIB) };
  let advice = null;
  if (FORECAST) {
    try { advice = wateringAdvice({ days: FORECAST, plan, soil, cl: BASE.climate, method: s.method, waterRate: s.waterRate }); }
    catch { advice = null; }
  }
  LAST = {
    soil, climate: BASE.climate, settings: s,
    ranking: rankCrops(soil, BASE.climate, s),
    roi: gardenROI(plan.length ? plan : [{ crop: "lettuce", sqft: 1 }], soil, BASE.climate, s),
    emptyPlan: !plan.length,
    calendar: plantingCalendar({ plan, soil, cl: BASE.climate, today: localDoy() }),
    advice,
  };
  renderAll(LAST);
}

let rt;
const recomputeSoon = () => { markLive(); clearTimeout(rt); rt = setTimeout(recompute, 60); };
function saveSettings() {
  store.set("settings", { water: $("#waterRate").value, irr: $("#irrigation").value, setup: $("#setupCost").value, years: $("#setupYears").value, org: $("#organicOnly").checked, labor: $("#laborHrs").value, wage: $("#hourlyWage").value });
}
["#waterRate", "#irrigation", "#setupCost", "#setupYears", "#organicOnly", "#laborHrs", "#hourlyWage"].forEach(id =>
  $(id).addEventListener("input", () => { saveSettings(); syncWhatIf(); recomputeSoon(); }));

// Water tab what-if controls mirror the plan settings (one source of truth).
function syncWhatIf() {
  const rate = +$("#waterRate").value || 0, s = $("#rateSlider");
  s.value = Math.min(+s.max, Math.max(+s.min, rate)); setFill(s);
  $("#rateOut").textContent = `${money(rate)} / 1,000 gal`;
  $$("#methodSeg button").forEach(b => { const on = b.dataset.m === $("#irrigation").value; b.classList.toggle("on", on); b.setAttribute("aria-checked", on); });
}
$("#rateSlider").addEventListener("input", e => {
  $("#waterRate").value = e.target.value; saveSettings(); syncWhatIf(); recomputeSoon();
});
$$("#methodSeg button").forEach(b => (b.onclick = () => {
  $("#irrigation").value = b.dataset.m; saveSettings(); syncWhatIf(); markLive(); recompute();
}));

// ---- Soil test ------------------------------------------------------------------------------------
const TEST_KEYS = ["ph", "organic_matter_pct", "p_ppm", "k_ppm", "cec"];
function fillTest() { TEST_KEYS.forEach(k => ($("#t_" + k).value = SOILTEST?.[k] ?? "")); }
$("#testApply").onclick = () => {
  const t = {};
  TEST_KEYS.forEach(k => { const v = $("#t_" + k).value; if (v !== "") t[k] = +v; });
  SOILTEST = Object.keys(t).length ? t : null;
  store.set("soiltest", SOILTEST);
  recompute();
  toast(SOILTEST ? "Soil test applied everywhere." : "No values entered.");
};
$("#testClear").onclick = () => { SOILTEST = null; store.set("soiltest", null); fillTest(); recompute(); };

// ---- Plan editor ------------------------------------------------------------------------------------
function renderPlan() {
  const opts = CROPS.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  $("#planRows").innerHTML = PLAN.map((p, i) => `
    <div class="plan-row">
      <select data-i="${i}" data-f="crop" aria-label="Crop">${opts}</select>
      <input type="number" min="1" step="1" inputmode="numeric" data-i="${i}" data-f="sqft" value="${p.sqft}" aria-label="Square feet">
      <button data-del="${i}" aria-label="Remove bed">×</button>
    </div>
    <div class="plan-slider"><input type="range" min="1" max="100" step="1" data-i="${i}" data-f="sqft" value="${Math.min(100, p.sqft)}" aria-label="Bed size in square feet"></div>`).join("")
    || `<p class="dim small">No beds yet. Add one, or tap "+ plan" on a crop in Crop value.</p>`;
  $$("#planRows select").forEach(s => (s.value = PLAN[s.dataset.i].crop));
  $$("#planRows input[type=range]").forEach(setFill);
  $$("#planRows [data-f]").forEach(el => el.addEventListener("input", () => {
    const i = el.dataset.i;
    if (el.dataset.f === "sqft") {
      const v = Math.max(0, +el.value || 0);
      PLAN[i].sqft = v;
      // keep the number box and slider for this bed in step
      $$(`#planRows [data-i="${i}"][data-f="sqft"]`).forEach(o => { if (o !== el) o.value = o.type === "range" ? Math.min(100, v) : v; if (o.type === "range") setFill(o); });
      if (el.type === "range") setFill(el);
    } else PLAN[i].crop = el.value;
    store.set("plan", PLAN); updateArea(); recomputeSoon();
  }));
  $$("#planRows [data-del]").forEach(b => (b.onclick = () => { PLAN.splice(+b.dataset.del, 1); store.set("plan", PLAN); renderPlan(); recompute(); }));
  updateArea();
}
function updateArea() { $("#planArea").textContent = `${fmt(PLAN.reduce((a, p) => a + (+p.sqft || 0), 0), 0)} sq ft planted`; }
$("#addRow").onclick = () => { PLAN.push({ crop: "lettuce", sqft: 8 }); store.set("plan", PLAN); renderPlan(); recompute(); };
function addToPlan(id) {
  PLAN.push({ crop: id, sqft: 8 }); store.set("plan", PLAN); renderPlan(); recompute();
  toast(`${CROPS.find(c => c.id === id).name} added to your plan (8 sq ft).`);
}

// ---- Rendering ------------------------------------------------------------------------------------------
function renderAll(d) {
  renderSeason(d.climate); renderSoil(d.soil); renderRanking(d.ranking);
  renderROI(d.roi, d.emptyPlan); renderWaterKpis(d.roi.water); renderFertText(d.roi.fertilizer, d.soil);
  renderCalendar(d); renderForecast(d); renderLog(d);
  renderCharts(d);
  countUp($("section.tab.on") || document);
}
function renderCharts(d) {
  renderWaterCharts(d.roi.water);
  const f = d.roi.fertilizer, keys = ["N", "P2O5", "K2O"];
  bars($("#nutrientChart"), keys, [
    { name: "Needed", values: keys.map(k => f.need_lb[k]), color: css("--ink-dim") },
    { name: "Supplied", values: keys.map(k => f.supplied_lb[k]), color: css("--moss") }],
    { h: 200, fmt: v => fmt(v, 2), label: "Nutrients needed vs supplied" });
}

const whyBtn = (key, extra = "") => key ? `<button class="why ${extra}" data-why="${esc(key)}" aria-label="Where this number comes from">i</button>` : "";
const tile = (label, value, sub, cls = "", why = "") =>
  `<div class="card kpi"><div class="eyebrow-row"><span class="eyebrow">${label}</span>${whyBtn(why)}</div><div class="big num ${cls}">${value}</div><div class="small dim">${sub || ""}</div></div>`;

function renderSeason(c) {
  $("#seasonTiles").innerHTML =
    tile("Frost-free season", `${c.frost_free_days} days`, c.last_spring_frost ? `${c.last_spring_frost} → ${c.first_fall_frost}` : "No hard frost most years", "", "season:frost") +
    tile("Growing degree days", fmt(c.season_gdd50, 0), "Heat for warm crops (base 50°F)", "", "season:gdd") +
    tile("Cool-crop days", `${c.cool_growing_days}`, "Days averaging 40–75°F", "", "season:cool") +
    tile("Yearly rainfall", `${fmt(c.annual_precip_in)} in`, esc(c.source), "", "season:rain");
}

const PRETTY = { ph: "Soil pH", organic_matter_pct: "Organic matter", cec: "Nutrient holding (CEC)", p_ppm: "Phosphorus", k_ppm: "Potassium" };
const AXIS = { ph: [4.5, 8.5], organic_matter_pct: [0, 10], cec: [0, 40], p_ppm: [0, 100], k_ppm: [0, 300] };
const WHAT = {
  ph: { low: "Acidic: nutrients lock up. Lime fixes it (see Fertilizer plan).", high: "Alkaline: iron and phosphorus get harder for roots to reach.", ok: "In the sweet spot for most vegetables." },
  organic_matter_pct: { low: "Below garden level. Compost raises it, holds water and feeds soil life.", ok: "Healthy garden-level organic matter.", high: "Very rich." },
  cec: { low: "Sandy, low-holding soil: feed little and often.", ok: "Holds nutrients well.", high: "High-holding soil: nutrients stick around." },
  p_ppm: { low: "Likely low: needs phosphorus.", ok: "Probably adequate.", high: "Probably plenty; skip extra phosphorus." },
  k_ppm: { low: "Likely low: needs potassium.", ok: "Probably adequate.", high: "Probably plenty." },
};
const CONF = { high: ["hi", "High confidence"], medium: ["med", "Medium confidence"], low: ["lo", "Low confidence"] };
const SRC = { ssurgo: "USDA soil survey", soilgrids: "SoilGrids map", regional: "Regional average", derived: "Estimated", soil_test: "Your soil test" };

function soilCard(v) {
  const [lo, hi] = AXIS[v.key];
  const pct = x => Math.max(0, Math.min(100, (x - lo) / (hi - lo) * 100));
  const ideal = v.ideal ? `<div class="ok" style="left:${pct(v.ideal[0])}%;width:${pct(v.ideal[1]) - pct(v.ideal[0])}%"></div>` : "";
  const rng = v.low != null && v.high != null && v.high > v.low ? `<div class="rng" style="left:${pct(v.low)}%;width:${pct(v.high) - pct(v.low)}%"></div>` : "";
  const col = v.status === "low" ? css("--bad") : v.status === "high" ? css("--warn") : css("--good");
  const [cc, cl] = CONF[v.confidence];
  const dec = v.key === "ph" ? 1 : v.key.endsWith("ppm") ? 0 : 1;
  return `<div class="card">
    <div class="row"><div class="eyebrow">${PRETTY[v.key]}</div><span style="display:flex;gap:6px;align-items:center"><span class="chip ${cc}" title="Score ${v.confidence_score}">${cl}</span>${whyBtn("soil:" + v.key)}</span></div>
    <div class="big num">${fmt(v.value, dec)} <span class="small dim">${v.unit === "pH" ? "" : esc(v.unit)}</span></div>
    <div class="band">${ideal}${rng}<div class="dot" style="left:${pct(v.value)}%;background:${col}"></div></div>
    <div class="row small dim num"><span>${lo}</span><span>ideal ${v.ideal[0]}–${v.ideal[1]}</span><span>${hi}</span></div>
    <p class="small" style="margin:8px 0 0"><span class="status-${v.status || "ok"}">${WHAT[v.key][v.status] || ""}</span></p>
    <div class="small dim" style="margin-top:6px">${SRC[v.source] || v.source}${v.low != null && v.high != null ? ` · nearby range ${fmt(v.low, dec)}–${fmt(v.high, dec)}` : ""}</div>
  </div>`;
}

function renderSoil(s) {
  $("#soilCards").innerHTML = ["ph", "organic_matter_pct", "cec", "p_ppm", "k_ppm"].map(k => soilCard(s.values[k])).join("");
  const tex = [["Sand", s.values.sand_pct.value, css("--wheat")], ["Silt", s.values.silt_pct.value, css("--clay")], ["Clay", s.values.clay_pct.value, css("--ink-dim")]];
  const t = tex.reduce((a, x) => a + x[1], 0) || 1;
  $("#textureCard").innerHTML = `<h3>Texture: ${esc(s.texture_class)}</h3>
    <div class="texture">${tex.map(x => `<div style="width:${x[1] / t * 100}%;background:${x[2]}" title="${x[0]} ${Math.round(x[1])}%"></div>`).join("")}</div>
    <div class="legend">${tex.map(x => `<span><i style="background:${x[2]}"></i>${x[0]} <span class="num">${Math.round(x[1])}%</span></span>`).join("")}</div>
    <p class="small dim">Organic matter releases about <span class="num">${fmt(s.n_mineralized_lb_per_100sqft * 16, 2)}</span> oz of free nitrogen per 100 sq ft each season, already credited in your fertilizer plan.</p>
    <p class="small dim">Averaged from ${s.points_with_data} of ${s.points_sampled} survey points within ${s.radius_km} km.</p>`;
  $("#soilNotes").innerHTML = s.notes.map(n => `<li>${esc(n)}</li>`).join("");
  $("#soilSources").textContent = "Sources: " + s.sources.join(", ");
}

const calChip = r => r.calibration ? ` <span class="cal-chip" title="Yield scaled by your own harvest log">yours ×${r.calibration}</span>` : "";

function renderRanking(rows) {
  const max = Math.max(...rows.map(r => Math.abs(r.net_per_sqft)), 0.01);
  const inPlan = new Set(PLAN.map(p => p.crop));
  const action = r => inPlan.has(r.id) ? `<span class="small dim">in plan</span>` : `<button class="addbtn" data-add="${r.id}">+ plan</button>`;
  const bar = r => `<div class="hbar ${r.net_per_sqft < 0 ? "neg" : ""}" style="width:${Math.abs(r.net_per_sqft) / max * 100}%"></div>`;
  const pl = r => `${r.plantings}${r.season_fraction < 1 ? ` (${Math.round(r.season_fraction * 100)}%)` : ""}`;

  // Website: full table
  $("#rankTable").innerHTML = `<thead><tr><th>#</th><th>Crop</th><th class="r">Net $/sq ft</th><th class="barcell"></th>
    <th class="r">Harvest value</th><th class="r">lb/sq ft</th><th class="r">Plantings</th><th class="r">Water gal/sq ft</th><th>Fit</th><th></th></tr></thead><tbody>` +
    rows.map((r, i) => `<tr>
      <td class="dim num">${i < 3 ? `<span class="medal">${i + 1}</span>` : i + 1}</td>
      <td><strong>${esc(r.name)}</strong> <span class="season-tag ${r.season}">${r.season}</span>${calChip(r)}${whyBtn("crop:" + r.id, "why-inline")}</td>
      <td class="r num"><strong>${money(r.net_per_sqft)}</strong></td>
      <td class="barcell">${bar(r)}</td>
      <td class="r num">${money(r.value_per_sqft)}</td><td class="r num">${fmt(r.yield_lb_per_sqft, 2)}</td>
      <td class="r num">${pl(r)}</td><td class="r num">${fmt(r.water_gal_per_sqft)}</td>
      <td class="small"><span class="dim">${esc(r.note)}</span>${r.soil_fit < 1 ? `<br><span class="status-low">${esc(r.soil_note)}</span>` : ""}</td>
      <td>${action(r)}</td></tr>`).join("") + "</tbody>";

  // App: compact list
  $("#rankList").innerHTML = rows.map((r, i) => `<li>
      <span class="pos num">${i < 3 ? `<span class="medal">${i + 1}</span>` : i + 1}</span>
      <span><strong>${esc(r.name)}</strong> <span class="season-tag ${r.season}">${r.season}</span>${calChip(r)}${whyBtn("crop:" + r.id, "why-inline")}</span>
      <span class="num"><strong>${money(r.net_per_sqft)}</strong><span class="dim small">/sq ft</span></span>
      ${bar(r)}
      <span class="meta">${money(r.value_per_sqft)} harvest · ${pl(r)} planting${r.plantings > 1 ? "s" : ""} · ${fmt(r.water_gal_per_sqft)} gal/sq ft${r.soil_fit < 1 ? ` · <span class="status-low">${esc(r.soil_note)}</span>` : ""}</span>
      <span class="meta" style="text-align:right">${action(r)}</span>
    </li>`).join("");
  $$("[data-add]").forEach(b => (b.onclick = () => addToPlan(b.dataset.add)));
}

function renderROI(r, empty) {
  if (empty) {
    $("#roiKpis").innerHTML = `<div class="card" style="grid-column:1/-1"><p class="dim" style="margin:0">Add a bed to see your garden's numbers.</p></div>`;
    $("#costStack").innerHTML = ""; $("#roiTable").innerHTML = "";
    return;
  }
  $("#roiKpis").innerHTML =
    tile("Harvest value", money(r.harvest_value, 0), `${fmt(r.harvest_lb)} lb at store prices`, "", "roi:value") +
    tile("Yearly cost", money(r.total_cost, 0), `${money(r.cost_per_lb)} per lb grown`, "", "roi:cost") +
    tile("Net savings", money(r.net, 0), r.roi_pct != null ? `${fmt(r.roi_pct, 0)}% return` : "", r.net >= 0 ? "pos" : "neg", "roi:net") +
    tile("Your time", r.labor.per_hour != null ? `${money(r.labor.per_hour)}/hr` : "—", r.labor.hours > 0 ? `${fmt(r.labor.hours)} hrs of work this season` : "Set hours per week to see this", r.labor.per_hour != null && r.labor.per_hour < 0 ? "neg" : "pos", "roi:time") +
    tile("Payback", r.payback_seasons != null ? `${fmt(r.payback_seasons)} seasons` : "—", r.payback_seasons != null ? "to earn back setup" : "Add a setup cost to see payback");
  const parts = [["Seeds & plants", r.costs.seeds_and_plants, css("--moss")], ["Soil & fertilizer", r.costs.soil_and_fertilizer, css("--clay")],
    ["Water", r.costs.water, css("--water")], ["Setup (per year)", r.costs.setup_per_year, css("--wheat")]];
  if (r.costs.labor > 0) parts.push(["Your time", r.costs.labor, css("--ink-dim")]);
  const tot = parts.reduce((a, p) => a + p[1], 0) || 1;
  $("#costStack").innerHTML = `<div class="stack">${parts.map(p => `<div style="width:${p[1] / tot * 100}%;background:${p[2]}" title="${p[0]}"></div>`).join("")}</div>
    <div class="legend">${parts.map(p => `<span><i style="background:${p[2]}"></i>${p[0]} <span class="num">${money(p[1])}</span></span>`).join("")}</div>
    <p class="small dim" style="margin-bottom:0">First trip to the store (plants, bags, setup): <strong class="num">${money(r.upfront_store_cost)}</strong>. Bags last more than one season, so the yearly cost counts only what you use.</p>`;
  $("#roiTable").innerHTML = `<thead><tr><th>Bed</th><th class="r">Sq ft</th><th class="r">Harvest</th><th class="r">Value</th><th class="r">Plants</th></tr></thead><tbody>` +
    r.rows.map(x => `<tr><td>${esc(x.crop)}</td><td class="r num">${fmt(x.sqft, 0)}</td><td class="r num">${fmt(x.harvest_lb)} lb</td><td class="r num">${money(x.value)}</td><td class="r num">${money(x.seed_cost)}</td></tr>`).join("") + "</tbody>";
}

function renderWaterKpis(w) {
  const peak = w.monthly_gallons.indexOf(Math.max(...w.monthly_gallons));
  $("#waterKpis").innerHTML =
    tile("Irrigation per year", `${fmt(w.total_gallons, 0)} gal`, "on top of rain", "", "water:total") +
    tile("Water cost per year", money(w.total_cost), `at ${money(w.water_rate)} / 1,000 gal`, "", "water:cost") +
    tile("Rain does the rest", `${fmt(w.rain_supplied_gallons, 0)} gal`, "free water your beds keep", "", "water:rain") +
    tile("Peak month", w.monthly_gallons[peak] ? w.months[peak] : "—", w.monthly_gallons[peak] ? `${fmt(w.monthly_gallons[peak], 0)} gal · ${money(w.monthly_cost[peak])}` : "") +
    (w.drip_savings > 0.005 ? tile("Switch to drip", `save ${money(w.drip_savings)}`, "per year, less water wasted") : "");
}
function renderWaterCharts(w) {
  const labels = isApp() ? w.months.map(m => m[0]) : w.months;  // J F M … on phones
  bars($("#waterChart"), labels, [{ name: "Irrigation", values: w.monthly_gallons, color: css("--water") }],
    { label: "Monthly irrigation gallons", h: isApp() ? 190 : 240, full: w.months, fmt: v => `${fmt(v, 0)} gal` });
  bars($("#rainChart"), labels, [{ name: "Rainfall", values: w.monthly_rain_in, color: css("--water") }, { name: "Crop water use (ET₀)", values: w.monthly_et0_in, color: css("--wheat") }],
    { h: isApp() ? 180 : 220, fmt: v => `${fmt(v, 1)} in`, label: "Rain vs evapotranspiration", full: w.months });
}

function renderFertText(f, soil) {
  const extras = (f.ph_action ? 1 : 0) + (f.compost_action ? 1 : 0);
  const freeN = (f.credits_lb.N_from_organic_matter + f.credits_lb.N_from_compost) * 16;
  $("#fertKpis").innerHTML =
    tile("At the store", money(f.upfront_cost), "whole bags, first season", "", "fert:store") +
    tile("Used this season", money(f.season_cost), "value of what you apply", "", "fert:season") +
    tile("Nitrogen to add", `${fmt(f.need_lb.N * 16, 1)} oz`, `after ${fmt(freeN, 1)} oz free from soil & compost`, "", "fert:nitrogen") +
    tile("Soil fixes", extras ? `${extras}` : "None", extras ? "pH and/or organic matter" : "pH and organic matter look fine");
  $("#fertTable").innerHTML = f.purchases.length
    ? `<thead><tr><th>Product</th><th class="r">Buy</th><th class="r">Cost</th></tr></thead><tbody>` +
      f.purchases.map(p => `<tr><td><strong>${esc(p.name)}</strong><div class="small dim">Apply ${fmt(p.lbs_to_apply, 1)} lb (${fmt(p.per_100_sqft_lb, 1)} lb per 100 sq ft) · ${fmt(p.leftover_lb)} lb left for next year</div></td><td class="r num" style="white-space:nowrap">${p.bags} × ${p.bag_lb} lb</td><td class="r num">${money(p.upfront_cost)}</td></tr>`).join("") + "</tbody>"
    : `<tbody><tr><td class="dim">Nothing to buy: your soil and compost already cover this plan.</td></tr></tbody>`;
  const fix = [];
  if (f.ph_action) fix.push(`<div style="margin-bottom:12px"><strong>${esc(f.ph_action.product)}</strong> to ${esc(f.ph_action.action)}<div class="num small">${fmt(f.ph_action.lbs)} lb (${fmt(f.ph_action.lb_per_100_sqft)} lb / 100 sq ft) · ${f.ph_action.bags} bag · ${money(f.ph_action.upfront_cost)}</div><div class="small dim">${esc(f.ph_action.note)}</div></div>`);
  if (f.compost_action) fix.push(`<div><strong>${esc(f.compost_action.product)}</strong>: add ${f.compost_action.inches} in.<div class="num small">${fmt(f.compost_action.cubic_feet)} cu ft · ${f.compost_action.bags} bags · ${money(f.compost_action.upfront_cost)}</div><div class="small dim">${esc(f.compost_action.note)}</div></div>`);
  $("#soilFixes").innerHTML = fix.join("") || `<p class="dim">pH ${fmt(soil.values.ph.value, 1)} and organic matter ${fmt(soil.values.organic_matter_pct.value, 1)}% are in range. Nothing to fix.</p>`;
  $("#fertNotes").innerHTML = f.notes.map(n => `<li>${esc(n)}</li>`).join("");
}

// ---- Planting calendar ---------------------------------------------------------------------------------
function renderCalendar(d) {
  const c = d.calendar;
  if (!c) return;
  $$("#calScope button").forEach(b => { const on = b.dataset.scope === CAL_SCOPE; b.classList.toggle("on", on); b.setAttribute("aria-checked", on); });
  const fr = [c.frost.springLabel && `last spring frost ${c.frost.springLabel}`, c.frost.fallLabel && `first fall frost ${c.frost.fallLabel}`].filter(Boolean).join(", ");
  $("#calIntro").textContent = c.frost.frostFree
    ? `Your area rarely freezes, so planting windows run most of the year. Dates also adjust for your ${c.texture} soil.`
    : `Built from your frost dates (${fr}) and adjusted for your ${c.texture} soil.`;

  const pool = c.crops.some(x => x.inPlan) ? c.crops.filter(x => x.inPlan) : c.crops;
  const due = pool.filter(x => ["sow", "harvest", "soon"].includes(x.now.action)).slice(0, 10);
  const next = due.length ? null : pool.filter(x => x.now.start != null).sort((a, b) => a.now.start - b.now.start)[0];
  $("#calNow").innerHTML =
    `<div class="eyebrow" style="margin-top:6px">${c.crops.some(x => x.inPlan) ? "Your plan, right now" : "In season right now"}</div><div class="cal-now">` +
    (due.map(x => `<span class="now-chip ${x.now.action}">${esc(x.name)}: ${esc(x.now.text)}</span>`).join("") ||
      `<span class="small dim">Nothing is due right now.${next ? ` Next up: ${esc(next.name)} (${esc(next.now.text.toLowerCase())}).` : ""}</span>`) +
    `</div><div class="cal-soil"><strong>Your soil:</strong> ${esc(c.shift.why)}</div>`;

  const rows = CAL_SCOPE === "plan" ? c.crops.filter(x => x.inPlan) : c.crops;
  const pct = n => n / 365 * 100;
  const lines = [
    c.frost.spring > 0 && c.frost.spring <= 365 ? `<i class="cal-line frost" style="left:${pct(c.frost.spring)}%" title="Last spring frost"></i>` : "",
    c.frost.fall > 0 && c.frost.fall <= 365 ? `<i class="cal-line frost" style="left:${pct(c.frost.fall)}%" title="First fall frost"></i>` : "",
    `<i class="cal-line today" style="left:${pct(c.today - 1)}%" title="Today"></i>`].join("");
  const bar = w => {
    const left = pct(w.start - 1), width = Math.min(100 - left, Math.max(1.4, pct(w.end - w.start + 1)));
    const label = `${w.kind === "sow" ? "Plant" : "Harvest"} ${dayLabel(w.start)} to ${dayLabel(w.end)}${w.nextYear ? " (next year)" : ""}`;
    return `<div class="cal-bar ${w.kind}${w.nextYear ? " next" : ""}" style="left:${left}%;width:${width}%" title="${esc(label)}"></div>`;
  };
  $("#calendar").innerHTML = rows.length
    ? `<div class="cal-months"><span></span><span class="m">${MONTHS.map(m => `<span>${m[0]}</span>`).join("")}</span></div>` +
      rows.map(x => `<div class="cal-row" role="group" aria-label="${esc(describeWindows(x))}">
        <div class="cal-name"><strong>${esc(x.name)}</strong> <span class="season-tag ${x.season}">${x.season}</span>
          <span class="nowtxt ${x.now.action}">${esc(x.now.text)}</span>${x.notes[0] ? `<span class="cal-notes">${esc(x.notes[0])}</span>` : ""}</div>
        <div class="cal-track">${x.windows.map(bar).join("")}${lines}</div></div>`).join("") +
      `<div class="legend cal-key"><span><i style="background:var(--leaf)"></i>Plant</span><span><i style="background:var(--wheat)"></i>Harvest</span>
        <span><i style="background:var(--water)"></i>Frost dates</span><span><i style="background:var(--bad)"></i>Today</span></div>`
    : `<p class="dim" style="margin:0">Your plan is empty. Add a bed on the Garden ROI tab, or switch to All crops.</p>`;
}
$$("#calScope button").forEach(b => (b.onclick = () => { CAL_SCOPE = b.dataset.scope; store.set("calscope", CAL_SCOPE); if (LAST) renderCalendar(LAST); }));

// ---- Watering forecast ------------------------------------------------------------------------------------------
function renderForecast(d) {
  const el = $("#forecastCard"), a = d.advice;
  if (!a) {
    el.innerHTML = FSTATE === "loading" || FSTATE === "idle"
      ? `<div class="skeleton" style="height:90px"></div>`
      : `<h3>Next 7 days</h3><p class="dim small" style="margin:0">The forecast couldn't be loaded right now, so day-by-day watering advice is unavailable. The monthly estimates below still apply.</p>`;
    return;
  }
  const frost = a.frost ? `<div class="banner ${a.frost.level}" role="alert">${esc(a.frost.text)}</div>` : "";
  const cell = day => {
    const cold = day.tmin !== null && day.tmin <= 32 ? " cold" : "";
    const wx = `<div class="num">${Math.round(day.tmax)}°/${Math.round(day.tmin)}°</div><div class="t">${day.rain_in >= 0.01 ? `${fmt(day.rain_in, 2)} in rain` : "dry"}</div>`;
    const act = day.action
      ? `<div class="act">${day.action === "water" ? `Water ${fmt(day.inches, 2)} in<br><span class="num">${fmt(day.gallons, 0)} gal · ${money(day.cost)}</span>` : "Skip"}</div>` : "";
    return `<div class="fc-day ${day.action || ""}${cold}" title="${esc(day.reason || "")}"><div class="d">${day.label}</div><div class="t">${day.short}</div>${wx}${act}</div>`;
  };
  if (!a.active) {
    el.innerHTML = `<h3>Next 7 days</h3>${frost}<p class="dim small" style="margin:0 0 4px">${esc(a.reason)}</p><div class="fc-days">${a.days.map(cell).join("")}</div>`;
    return;
  }
  const save = a.saved_gallons > 0
    ? `Skipping what rain covers saves <strong class="num">${money(a.saved_cost)}</strong> <span class="small dim">(${fmt(a.saved_gallons, 0)} gal vs. a daily timer)</span>`
    : "Little rain is coming, so plan to water as shown";
  el.innerHTML = `<div class="fc-head"><h3>Water plan: next 7 days</h3><span class="fc-save">${save} ${whyBtn("water:week")}</span></div>${frost}
    <div class="fc-days">${a.days.map(cell).join("")}</div>
    <p class="small dim" style="margin:10px 0 0">${a.water_days} watering day${a.water_days === 1 ? "" : "s"}, about ${fmt(a.week_gallons, 0)} gal (${money(a.week_cost)}) for ${fmt(a.area_sqft, 0)} sq ft. It's a forecast, so push a finger two inches into the soil before you skip.</p>`;
}

// ---- Harvest log and calibration ------------------------------------------------------------------------------------
function saveLog() { store.set("harvests", LOG); }
function renderLog(d) {
  const plan = PLAN.filter(p => p.sqft > 0), year = new Date().getFullYear();
  const planIds = [...new Set(plan.map(p => p.crop))];
  const order = [...planIds, ...CROPS.map(c => c.id).filter(id => !planIds.includes(id))];
  const sel = $("#logCrop"), sig = order.join(",") + "|" + planIds.length;
  if (sel.dataset.sig !== sig) {
    const keep = sel.value;
    sel.innerHTML = order.map((id, i) => `${i === planIds.length && planIds.length ? `<option disabled>── not in your plan ──</option>` : ""}<option value="${id}">${esc(CROPS.find(c => c.id === id).name)}</option>`).join("");
    sel.dataset.sig = sig;
    if (order.includes(keep)) sel.value = keep;
  }
  const factors = factorsFromHistory(CALIB);
  const ids = [...new Set([...LOG.filter(e => +e.date.slice(0, 4) === year).map(e => e.crop), ...Object.keys(factors)])];
  $("#logProgress").innerHTML = ids.map(id => {
    const c = CROPS.find(x => x.id === id), lb = loggedLb(LOG, id, year), pred = predictedLb(plan, id, d.soil, d.climate);
    const chip = factors[id] ? `<span class="cal-chip" title="${(CALIB[id] || []).length} season(s) averaged">yours ×${factors[id]}</span>` : "";
    const detail = pred > 0 ? `${fmt(lb)} lb logged of about ${fmt(pred)} lb predicted` : `${fmt(lb)} lb logged. Add it to your plan to compare`;
    return `<div class="prog"><div><strong>${esc(c.name)}</strong>${chip}<div class="small dim">${detail}</div></div>
      <button class="btn small-btn ghost" data-finish="${id}" ${lb > 0 && pred > 0 ? "" : "disabled"}>Finish season</button>
      ${pred > 0 ? `<div class="meter" aria-hidden="true"><i style="width:${Math.min(100, lb / pred * 100)}%"></i></div>` : ""}</div>`;
  }).join("");
  const recent = [...LOG].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
  $("#logEntries").innerHTML = recent.map(e => `<div class="entry"><span>${esc(e.date)} · ${esc(CROPS.find(c => c.id === e.crop).name)} · <span class="num">${fmt(e.lb, 2)} lb</span></span>
    <button data-del-log="${esc(e.id)}" aria-label="Delete this entry">×</button></div>`).join("");
  $("#logCsv").disabled = !LOG.length;
  $("#calReset").disabled = !Object.keys(factors).length;
}
function addLog() {
  const entry = makeEntry({ crop: $("#logCrop").value, lb: $("#logLb").value });
  if (!entry) return toast("Enter the pounds you picked (more than 0).", { error: true });
  LOG.push(entry); saveLog(); $("#logLb").value = "";
  recompute();
  toast(`Logged ${fmt(entry.lb, 2)} lb of ${CROPS.find(c => c.id === entry.crop).name.toLowerCase()}.`);
}
$("#logAdd").onclick = addLog;
$("#logLb").onkeydown = e => { if (e.key === "Enter") addLog(); };
$("#logProgress").addEventListener("click", e => {
  const b = e.target.closest("[data-finish]");
  if (!b || !LAST) return;
  const id = b.dataset.finish, year = new Date().getFullYear(), plan = PLAN.filter(p => p.sqft > 0);
  const lb = loggedLb(LOG, id, year), predicted = predictedLb(plan, id, LAST.soil, LAST.climate);
  const res = finishSeason(CALIB, { crop: id, year, lb, predicted, sqft: sqftOf(plan, id) });
  if (res.error) return toast(res.error, { error: true });
  CALIB = res.history; store.set("calib", CALIB);
  recompute();
  toast(`${CROPS.find(c => c.id === id).name}: you picked ${Math.round(lb / predicted * 100)}% of the prediction. Future numbers for it are adjusted.`);
});
$("#logEntries").addEventListener("click", e => {
  const b = e.target.closest("[data-del-log]");
  if (!b) return;
  LOG = LOG.filter(x => x.id !== b.dataset.delLog); saveLog(); recompute();
});
$("#logCsv").onclick = () => {
  if (!LOG.length) return toast("Nothing logged yet.");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([toCSV(LOG)], { type: "text/csv" }));
  a.download = "ecoanalytics-harvest-log.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$("#calReset").onclick = () => {
  if (!Object.keys(CALIB).length) return;
  if (!confirm("Forget what your harvests taught the app? Rankings and ROI go back to typical yields. Your harvest log is kept.")) return;
  CALIB = {}; store.set("calib", CALIB); recompute(); toast("Calibration reset.");
};

// ---- "Where this number comes from" -------------------------------------------------------------------------------------------
const sheet = $("#whySheet");
function openWhy(key) {
  if (!LAST) return;
  let info = null;
  try { info = explain(key, LAST); } catch { info = null; }
  if (!info) return toast("No details are available for that number yet.");
  $("#whyTitle").textContent = info.title;
  $("#whySum").textContent = info.summary;
  $("#whySteps").innerHTML = info.steps.filter(Boolean).map(t => `<li>${esc(t)}</li>`).join("");
  const cv = $("#whyCaveat");
  cv.hidden = !info.caveat; cv.textContent = info.caveat || "";
  $("#whySources").textContent = info.sources.length ? "Sources: " + info.sources.join("; ") : "";
  if (typeof sheet.showModal === "function") { if (!sheet.open) sheet.showModal(); } else sheet.setAttribute("open", "");
}
const closeWhy = () => { if (typeof sheet.close === "function") sheet.close(); else sheet.removeAttribute("open"); };
document.addEventListener("click", e => {
  const b = e.target.closest("[data-why]");
  if (b) { e.preventDefault(); openWhy(b.dataset.why); }
});
$("#whyClose").onclick = closeWhy;
sheet.addEventListener("click", e => {   // a click on the dimmed backdrop closes it
  const r = sheet.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeWhy();
});

// Simple SVG bar chart, sized to its container ------------------------------------------------------
function bars(el, labels, series, opts = {}) {
  if (!el.offsetParent) return;  // hidden tab: drawn when shown
  const W = Math.max(280, el.clientWidth || 640), H = opts.h || 240, pl = 40, pr = 6, pt = 14, pb = 26;
  const max = Math.max(...series.flatMap(s => s.values), 0.0001) * 1.1;
  const n = labels.length, gw = (W - pl - pr) / n, bw = Math.min(28, (gw - 4) / series.length);
  const y = v => pt + (H - pt - pb) * (1 - v / max);
  let g = "";
  for (let i = 0; i <= 4; i++) {
    const v = max / 4 * i;
    g += `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" stroke="${css("--line")}"/><text x="${pl - 6}" y="${y(v) + 4}" text-anchor="end">${opts.fmt ? opts.fmt(v) : fmt(v, 0)}</text>`;
  }
  const full = opts.full || labels;
  labels.forEach((lab, i) => {
    const x0 = pl + i * gw + (gw - bw * series.length) / 2;
    series.forEach((s, j) => {
      const v = s.values[i], h = (H - pt - pb) - (y(v) - pt);
      const tip = `${full[i]} · ${s.name}: ${opts.fmt ? opts.fmt(v) : fmt(v)}`;
      g += `<rect class="bar" data-tip="${esc(tip)}" x="${x0 + j * bw}" y="${y(v)}" width="${Math.max(1, bw - 2)}" height="${Math.max(0, h)}" rx="3" fill="${s.color}" style="animation-delay:${i * 30}ms"><title>${esc(tip)}</title></rect>`;
    });
    g += `<text x="${pl + i * gw + gw / 2}" y="${H - 8}" text-anchor="middle">${lab}</text>`;
  });
  el.style.position = "relative";
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(opts.label || "chart")}">${g}</svg><div class="tip"></div>` +
    (series.length > 1 ? `<div class="legend">${series.map(s => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join("")}</div>` : "");

  // Hover (mouse) or tap (touch) a bar to see its value.
  const tipEl = $(".tip", el), svg = $("svg", el);
  const show = rect => {
    $$("rect.hl", svg).forEach(r => r.classList.remove("hl"));
    rect.classList.add("hl");
    const box = rect.getBoundingClientRect(), host = el.getBoundingClientRect();
    tipEl.textContent = rect.dataset.tip;
    tipEl.style.left = `${box.left - host.left + box.width / 2}px`;
    tipEl.style.top = `${box.top - host.top}px`;
    tipEl.classList.add("show");
  };
  const hide = () => { tipEl.classList.remove("show"); $$("rect.hl", svg).forEach(r => r.classList.remove("hl")); };
  $$("rect.bar", svg).forEach(r => {
    r.addEventListener("pointerenter", () => show(r));
    r.addEventListener("pointerdown", () => show(r));
  });
  svg.addEventListener("pointerleave", hide);
}

// ---- Boot ---------------------------------------------------------------------------------------------------
(async function boot() {
  const s = store.get("settings", null);
  if (s) {
    $("#waterRate").value = s.water; $("#irrigation").value = s.irr; $("#setupCost").value = s.setup; $("#setupYears").value = s.years; $("#organicOnly").checked = s.org;
    if (s.labor != null) $("#laborHrs").value = s.labor;
    if (s.wage != null) $("#hourlyWage").value = s.wage;
  }
  fillTest();
  renderPlan();
  syncWhatIf();
  const tab = store.get("tab", "soil");
  if ($(`nav.tabs button[data-tab="${tab}"]`)) showTab(tab);
  const saved = store.get("location", null);
  if (saved && ["device", "address", "zip"].includes(saved.source)) {
    showLocation(saved);
    try { await research(); } catch (e) { busy(false); toast(e.message, { error: true }); }
    return;
  }
  locate(() => locateByIP(Intl.DateTimeFormat().resolvedOptions().timeZone));
})();
// Redraw charts only when the width really changes (phones fire "resize" while
// scrolling as the address bar hides), and without replaying entrance animations.
let resizeT, lastW = innerWidth;
addEventListener("resize", () => {
  if (innerWidth === lastW) return;
  lastW = innerWidth;
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { if (LAST) { markLive(); renderCharts(LAST); } }, 200);
});
