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
import { getClimate, MONTHS, wrapDoy } from "./climate.js";
import { CROPS } from "./data.js";
import { rankCrops, gardenROI } from "./economics.js";
import { plantingCalendar, localDoy, describeWindows, dayLabel } from "./planner.js";
import { getForecast, wateringAdvice } from "./forecast.js";
import { predictedLb, sqftOf, makeEntry, loggedLb, finishSeason, factorsFromHistory, toCSV } from "./calibration.js";
import { explain } from "./provenance.js";
import { sunNow, compassOffset } from "./sun.js";
import { seasonReport } from "./calibration.js";
import { sunHours, skylineFromEstimate, skylineFromSamples, cameraDirection, coverage, compassName, sunLabel, whatGrows,
  HEIGHTS, DIRECTIONS, BINS, BIN_DEG, SUN_NEED, sunFactor, FULL_SUN } from "./sun.js";
import { getHistory, cropRisk, planRisk, autoPlan } from "./risk.js";
import { GUIDE, companionCheck, problemsFor } from "./guide.js";
import { encodePlan, planFromHash, buildICS, makeBackup, readBackup } from "./share.js";
import { weekActions } from "./weekly.js";
import { climateShift } from "./trend.js";
import { DEFAULT_YARD, layout, placeBed, resizeToArea, yardNotes, plantCount, plantDots, spacingText, PER_SQFT } from "./yard.js";
import { sampleColor, readStrip, parseValues, STRIP_TYPES, toSoilTest } from "./strip.js";
import { setLang, lang, defaultLang, watch as watchLang, translateText } from "./i18n.js";
import { money as fmtMoney, setCurrency, currency, defaultCurrency, fetchRate, toLocal, toUSD, CURRENCIES } from "./currency.js";
import { setMetric, isMetric, defaultMetric, watch as watchUnits, area as areaU, weight as weightU, waterPrice, SQFT_PER_M2, KG_PER_LB, L_PER_GAL } from "./units.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const money = (v, d = 2) => fmtMoney(v, d);
const fmt = (v, d = 1) => v == null ? "—" : Number(v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 });
// Money per square foot shown on its own (no unit next to it): per m² in metric.
const perSq = (v, d = 2) => money(v == null ? v : isMetric() ? v * 10.7639 : v, d);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const store = {
  get(k, d) { try { const v = localStorage.getItem("eco:" + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("eco:" + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

// Water rate box: shown in the user's units and currency, kept in US$ per 1,000 gal for the models.
const wrToShown = usd => Math.round(toLocal(waterPrice.toShown(usd)) * 100) / 100;
const wrFromShown = v => waterPrice.fromShown(toUSD(v));
/** When today's exchange rate arrives, re-show the water rate (stored in dollars) at that rate. */
function syncInputsToCurrency(oldRate) {
  const usd = waterPrice.fromShown((+$("#waterRate").value || 0) / oldRate);
  $("#waterRate").value = wrToShown(usd);
  syncWhatIf?.();
}

// Currency: the user's choice, else their region's; today's rate is cached for a day.
{
  const cur = store.get("currency", null) || defaultCurrency();
  const fx = store.get("fx:" + cur, null);
  setCurrency(cur, fx && Date.now() - fx.t < 864e5 * 7 ? fx.rate : null);
  if (cur !== "USD" && !(fx && Date.now() - fx.t < 864e5)) {
    fetchRate(cur).then(rate => {
      if (!rate) return;
      store.set("fx:" + cur, { rate, t: Date.now() });
      const before = currency().rate;
      setCurrency(cur, rate);
      if (Math.abs(before - rate) / rate > 0.002) { syncInputsToCurrency(before); renderPrices(); if (LAST) recompute(); }
    }).catch(() => {});
  }
}

// Language: the user's choice, else their phone's.
setLang(store.get("lang", null) || defaultLang());
document.documentElement.lang = lang();

// Units: the user's choice, else what their phone's region uses. Must be set before anything draws.
{
  const u = store.get("units", null);
  setMetric(u === "metric" ? true : u === "us" ? false : defaultMetric());
  document.documentElement.dataset.unitsys = isMetric() ? "metric" : "us";
  watchUnits(document.body);
  watchLang(document.body);
}

const DEFAULT_PLAN = [{ crop: "tomato", sqft: 16 }, { crop: "lettuce", sqft: 8 }, { crop: "basil", sqft: 4 }, { crop: "pepper", sqft: 4 }];

let SOILTEST = store.get("soiltest", null);
let LOCATION = null, BASE = null, LAST = null;
// Saved data is untrusted: anything unexpected is dropped rather than allowed to break the page.
const asArray = v => Array.isArray(v) ? v : [];
const asObject = v => v && typeof v === "object" && !Array.isArray(v) ? v : {};
// A saved plan that is not a list is corrupt: start from the default. A saved empty list is a choice: keep it.
const savedPlan = store.get("plan", DEFAULT_PLAN);
const cleanBed = p => {
  const pos = ["x", "y", "w", "h"].every(k => typeof p[k] === "number" && Number.isFinite(p[k]) && p[k] >= 0 && p[k] <= 300) && p.w >= 1 && p.h >= 1
    ? { x: p.x, y: p.y, w: p.w, h: p.h } : {};
  return { crop: p.crop, sqft: Math.max(0, +p.sqft || 0), ...pos,
    ...(typeof p.sun === "number" && Number.isFinite(p.sun) ? { sun: Math.max(0, Math.min(16, p.sun)) } : {}) };
};
let PLAN = (Array.isArray(savedPlan) ? savedPlan : DEFAULT_PLAN).filter(p => p && CROPS.some(c => c.id === p.crop)).map(cleanBed);
let LOG = asArray(store.get("harvests", [])).filter(e => e && typeof e === "object" && CROPS.some(c => c.id === e.crop) && typeof e.id === "string"
  && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && Number.isFinite(+e.lb) && +e.lb > 0).map(e => ({ ...e, lb: +e.lb }));
let CALIB = asObject(store.get("calib", {}));
let FORECAST = null, FSTATE = "idle", FKEY = "";   // FSTATE: idle | loading | ok | failed
let CAL_SCOPE = store.get("calscope", "plan") === "all" ? "all" : "plan";
let HIST = null, HSTATE = "idle", HKEY = "";        // 15 past seasons for "good year, bad year"
let RISK = null, PLANRISK = null;
const savedSun = store.get("ranksun", null);
let RANK_SUN = [8, 6, 4, 2].includes(savedSun) ? savedSun : null;   // null = follow the plan's beds
let RANK_BY = store.get("rankby", "typical") === "safe" ? "safe" : "typical";

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
  if (document.documentElement.dataset.view === "simple" && $(`nav.tabs button[data-tab="${name}"]`)?.classList.contains("adv")) name = "soil";
  $$("nav.tabs button").forEach(x => { const on = x.dataset.tab === name; x.classList.toggle("on", on); if (on) x.setAttribute("aria-current", "page"); else x.removeAttribute("aria-current"); });
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
  // Five digits is a US ZIP for people in US time zones; elsewhere (France, Germany…) it's a local postcode.
  const usZone = /^(America|Pacific\/Honolulu|US)\b/.test(Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York");
  locate(usZone && /^\d{5}(-\d{4})?$/.test(v) ? () => locateByZip(v.slice(0, 5)) : () => locateByAddress(v), "Looking up that address…");
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
  loadHistory();    // nor on the 15-year history
}

// 15 past seasons of weather, summarised per year and cached 30 days.
async function loadHistory() {
  const loc = LOCATION;
  if (!loc) return;
  const key = `${loc.lat.toFixed(2)},${loc.lon.toFixed(2)}`;
  HKEY = key;
  const hit = store.get("history:" + key, null);
  if (hit && Array.isArray(hit.climates) && hit.climates.length >= 5 && Date.now() - hit.t < CACHE_DAYS * 864e5) {
    HIST = hit; HSTATE = "ok"; computeRisk(); return;
  }
  HIST = null; HSTATE = "loading"; renderRiskParts();
  try {
    const h = await getHistory(loc.lat, loc.lon);
    if (HKEY !== key) return;
    HIST = { ...h, t: Date.now() }; HSTATE = "ok";
    store.set("history:" + key, HIST);
  } catch {
    if (HKEY !== key) return;
    HIST = null; HSTATE = "failed";
  }
  computeRisk();
}

// Risk replays the plan 15 times, so it runs a moment after the main numbers settle.
let riskT;
function computeRisk() {
  clearTimeout(riskT);
  riskT = setTimeout(() => {
    if (!LAST || !HIST) { RISK = PLANRISK = null; renderRiskParts(); return; }
    try {
      RISK = cropRisk(LAST.soil, HIST.climates, LAST.settings);
      const plan = PLAN.filter(p => p.sqft > 0);
      PLANRISK = plan.length ? planRisk(plan, LAST.soil, HIST.climates, LAST.settings) : null;
    } catch { RISK = PLANRISK = null; }
    LAST.risk = RISK; LAST.planRisk = PLANRISK; LAST.historySource = HIST.source;
    renderRiskParts();
  }, 250);
}
function renderRiskParts() {
  if (!LAST) return;
  renderRanking(LAST.ranking); renderRisk(); renderGuideGrid(); renderShift();
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
    waterRate: Math.max(0, wrFromShown(+$("#waterRate").value || 0)),
    method: $("#irrigation").value,
    setupCost: Math.max(0, toUSD(+$("#setupCost").value || 0)),
    setupYears: Math.max(1, Math.round(+$("#setupYears").value || 1)),
    organicOnly: $("#organicOnly").checked,
    laborHrPer100Week: Math.max(0, parseFloat($("#laborHrs").value) || 0),
    hourlyWage: Math.max(0, toUSD(parseFloat($("#hourlyWage").value) || 0)),
    prices: { ...PRICES },
  };
}

function recompute() {
  if (!BASE) return;
  const soil = applySoilTest(BASE.soil, SOILTEST);
  const plan = PLAN.filter(p => p.sqft > 0);
  const s = { ...settings(), yieldAdjust: factorsFromHistory(CALIB), sunHours: rankSun() };
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
    advice, risk: RISK, planRisk: PLANRISK, historySource: HIST?.source,
  };
  renderAll(LAST);
  if (HIST) computeRisk();
}

/** Sun used for the crop ranking: the user's pick, else the plan's typical bed, else full sun. */
function rankSun() {
  if (RANK_SUN != null) return RANK_SUN;
  const s = PLAN.filter(p => p.sqft > 0 && Number.isFinite(p.sun)).map(p => p.sun).sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : null;
}

let rt;
const recomputeSoon = () => { markLive(); clearTimeout(rt); rt = setTimeout(recompute, 60); };
function saveSettings() {
  store.set("settings", { water: String(wrFromShown(+$("#waterRate").value || 0)), irr: $("#irrigation").value, setup: $("#setupCost").value, years: $("#setupYears").value, org: $("#organicOnly").checked, labor: $("#laborHrs").value, wage: $("#hourlyWage").value });
}
["#waterRate", "#irrigation", "#setupCost", "#setupYears", "#organicOnly", "#laborHrs", "#hourlyWage"].forEach(id =>
  $(id).addEventListener("input", () => { saveSettings(); syncWhatIf(); recomputeSoon(); }));

// Water tab what-if controls mirror the plan settings (one source of truth).
function syncWhatIf() {
  const rate = wrFromShown(+$("#waterRate").value || 0), s = $("#rateSlider");
  s.value = Math.min(+s.max, Math.max(+s.min, rate)); setFill(s);
  $("#rateOut").textContent = isMetric() ? `${money(waterPrice.toShown(rate))} per m³` : `${money(rate)} / 1,000 gal`;
  $$("#methodSeg button").forEach(b => { const on = b.dataset.m === $("#irrigation").value; b.classList.toggle("on", on); b.setAttribute("aria-checked", on); });
}
$("#rateSlider").addEventListener("input", e => {
  $("#waterRate").value = wrToShown(+e.target.value); saveSettings(); syncWhatIf(); recomputeSoon();
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
      <input type="number" min="${isMetric() ? 0.1 : 1}" step="${isMetric() ? 0.1 : 1}" inputmode="decimal" data-i="${i}" data-f="sqft" value="${areaU.toShown(p.sqft)}" aria-label="Bed size in ${areaU.label()}">
      <button data-del="${i}" aria-label="Remove bed">×</button>
    </div>
    <div class="plan-slider"><input type="range" min="1" max="100" step="1" data-i="${i}" data-f="sqft" value="${Math.min(100, p.sqft)}" aria-label="Bed size in square feet">
      <button class="sunbtn ${Number.isFinite(p.sun) && sunFactor(p.crop, p.sun) < 1 ? "short" : ""}" data-sun-i="${i}" title="${esc(sunLabel(p.sun))}" aria-label="Sun at this bed: ${esc(sunLabel(p.sun))}. Tap to measure.">${SUN_ICON}<span class="num">${Number.isFinite(p.sun) ? fmt(p.sun) + "h" : "sun?"}</span></button></div>`).join("")
    || `<p class="dim small">No beds yet. Add one, or tap "+ plan" on a crop in Crop value.</p>`;
  $$("#planRows select").forEach(s => (s.value = PLAN[s.dataset.i].crop));
  $$("#planRows input[type=range]").forEach(setFill);
  $$("#planRows [data-f]").forEach(el => el.addEventListener("input", () => {
    const i = el.dataset.i;
    if (el.dataset.f === "sqft") {
      // The number box shows the user's units; the slider and the plan work in square feet.
      const v = Math.max(0, el.type === "range" ? +el.value || 0 : Math.round(areaU.fromShown(+el.value || 0) * 10) / 10);
      PLAN[i] = resizeToArea({ ...PLAN[i], sqft: v });
      // keep the number box and slider for this bed in step
      $$(`#planRows [data-i="${i}"][data-f="sqft"]`).forEach(o => { if (o !== el) o.value = o.type === "range" ? Math.min(100, v) : areaU.toShown(v); if (o.type === "range") setFill(o); });
      if (el.type === "range") setFill(el);
    } else PLAN[i].crop = el.value;
    store.set("plan", PLAN); updateArea(); renderYard(); recomputeSoon();
  }));
  $$("#planRows [data-del]").forEach(b => (b.onclick = () => { PLAN.splice(+b.dataset.del, 1); store.set("plan", PLAN); renderPlan(); recompute(); }));
  $$("#planRows [data-sun-i]").forEach(b => (b.onclick = () => openSun(+b.dataset.sunI)));
  updateArea(); renderCompanions(); renderYard();
}
const SUN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;
function renderCompanions() {
  const c = companionCheck(PLAN);
  $("#companionNotes").innerHTML = [...c.bad.map(x => `<li class="status-low">${esc(x.text)}</li>`), ...c.good.slice(0, 3).map(x => `<li>${esc(x.text)}</li>`)].join("");
}
function updateArea() { $("#planArea").textContent = `${fmt(PLAN.reduce((a, p) => a + (+p.sqft || 0), 0), 0)} sq ft planted`; }
$("#addRow").onclick = () => { PLAN.push({ crop: "lettuce", sqft: 8 }); YARD_SEL = PLAN.length - 1; store.set("plan", PLAN); renderPlan(); recompute(); };

// "Plan it for me" ------------------------------------------------------------------------------
$("#autoBtn").onclick = () => {
  const box = $("#autoBox"), open = box.hidden;
  box.hidden = !open;
  if (open) {
    const area = PLAN.reduce((a, p) => a + (+p.sqft || 0), 0);
    $("#autoArea").value = areaU.toShown(area > 0 ? Math.round(area) : 32);
    const sun = rankSun();
    $("#autoSun").value = String(sun == null ? 8 : [8, 6, 4, 2].reduce((a, b) => Math.abs(b - sun) < Math.abs(a - sun) ? b : a));
  }
};
$("#autoCancel").onclick = () => ($("#autoBox").hidden = true);
$("#autoGo").onclick = () => {
  if (!LAST) return toast("Your soil is still being researched. Try again in a moment.");
  const area = Math.max(4, Math.round(areaU.fromShown(+$("#autoArea").value || 0))), sun = +$("#autoSun").value;
  const s = { ...LAST.settings, sunHours: sun };
  const ranking = rankCrops(LAST.soil, LAST.climate, s);
  const risk = HIST ? cropRisk(LAST.soil, HIST.climates, s) : null;
  const plan = autoPlan({ area, ranking, risk, sunHours: sun });
  if (!plan.length) return toast("No crop pays its way with that little sun. Try a sunnier spot.", { error: true });
  if (PLAN.length && !confirm("Replace your current beds with this plan?")) return;
  PLAN = plan; store.set("plan", PLAN);
  $("#autoBox").hidden = true;
  renderPlan(); recompute();
  toast(`Planned ${area} sq ft: ${plan.map(p => CROPS.find(c => c.id === p.crop).name.replace(/\s*\(.*\)/, "")).join(", ")}.`);
};

// Share a plan as a link (the plan travels after "#", which is never sent to any server) ---------------
$("#shareBtn").onclick = async () => {
  const beds = PLAN.filter(p => p.sqft > 0);
  if (!beds.length) return toast("Add a bed first.");
  const url = `${location.origin}${location.pathname}#plan=${encodePlan(beds)}`;
  const text = "My garden plan on EcoAnalytics. It works out the numbers for your own soil and weather.";
  try {
    if (navigator.share) { await navigator.share({ title: "My garden plan", text, url }); return; }
  } catch (e) { if (e?.name === "AbortError") return; }
  try { await navigator.clipboard.writeText(url); toast("Link copied. Anyone who opens it sees the plan worked out for their own yard."); }
  catch { prompt("Copy this link:", url); }
};
function checkSharedPlan() {
  const shared = planFromHash(location.hash);
  if (!shared) return;
  history.replaceState(null, "", location.pathname + location.search);
  const desc = shared.map(p => `${CROPS.find(c => c.id === p.crop).name} ${p.sqft} sq ft`).join(", ");
  if (!confirm(`Open this shared garden plan?\n\n${desc}\n\nIt replaces your current beds (your harvest log is kept).`)) return;
  PLAN = shared; store.set("plan", PLAN); renderPlan();
  showTab("roi");
  toast("Shared plan loaded and worked out for your soil.");
}
function addToPlan(id) {
  PLAN.push({ crop: id, sqft: 8 }); store.set("plan", PLAN); renderPlan(); recompute();
  toast(`${CROPS.find(c => c.id === id).name} added to your plan (8 sq ft).`);
}

// ---- Rendering ------------------------------------------------------------------------------------------
function renderAll(d) {
  renderSeason(d.climate); renderSoil(d.soil); renderRanking(d.ranking); renderRisk(); renderGuideTab(d);
  renderROI(d.roi, d.emptyPlan); renderWaterKpis(d.roi.water); renderFertText(d.roi.fertilizer, d.soil);
  renderCalendar(d); renderForecast(d); renderLog(d);
  renderWeek(d); renderShift(); renderYard();
  if (store.get("alerts", false)) writeAlertConfig(true);
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
    tile("Growing degree days", fmt(c.season_gdd50 * (isMetric() ? 5 / 9 : 1), 0), "Heat for warm crops (base 50°F)", "", "season:gdd") +
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
  $("#textureCard").innerHTML = `<h2>Texture: ${esc(s.texture_class)}</h2>
    <div class="texture">${tex.map(x => `<div style="width:${x[1] / t * 100}%;background:${x[2]}" title="${x[0]} ${Math.round(x[1])}%"></div>`).join("")}</div>
    <div class="legend">${tex.map(x => `<span><i style="background:${x[2]}"></i>${x[0]} <span class="num">${Math.round(x[1])}%</span></span>`).join("")}</div>
    <p class="small dim">Organic matter releases about <span class="num">${fmt(s.n_mineralized_lb_per_100sqft * 16, 2)}</span> oz of free nitrogen per 100 sq ft each season, already credited in your fertilizer plan.</p>
    <p class="small dim">Averaged from ${s.points_with_data} of ${s.points_sampled} survey points within ${s.radius_km} km.</p>`;
  $("#soilNotes").innerHTML = s.notes.map(n => `<li>${esc(n)}</li>`).join("");
  $("#soilSources").textContent = "Sources: " + s.sources.join(", ");
}

const calChip = r => r.calibration ? ` <span class="cal-chip" title="Yield scaled by your own harvest log">yours ×${r.calibration}</span>` : "";

function renderRanking(input) {
  const risk = LAST?.risk;
  const rows = RANK_BY === "safe" && risk ? [...input].sort((a, b) => (risk[b.id]?.bad ?? -1e9) - (risk[a.id]?.bad ?? -1e9)) : input;
  syncRankControls();
  const max = Math.max(...rows.map(r => Math.abs(r.net_per_sqft)), 0.01);
  const range = r => { const k = risk?.[r.id]; return k ? `${perSq(k.bad)} to ${perSq(k.good)}` : (HSTATE === "loading" ? "…" : "—"); };
  const odds = r => { const k = risk?.[r.id]; return k ? `${k.positive}/${k.n} yrs` : ""; };
  const sunNote = r => r.sun_fit < 1 ? `<br><span class="status-low">${Math.round(r.sun_fit * 100)}% of a full crop in ${fmt(LAST.settings.sunHours)}h sun (needs ${SUN_NEED[r.id]}h)</span>` : "";
  const nameBtn = r => `<button class="link" data-guide="${r.id}">${esc(r.name)}</button>`;
  const inPlan = new Set(PLAN.map(p => p.crop));
  const action = r => inPlan.has(r.id) ? `<span class="small dim">in plan</span>` : `<button class="addbtn" data-add="${r.id}">+ plan</button>`;
  const bar = r => `<div class="hbar ${r.net_per_sqft < 0 ? "neg" : ""}" style="width:${Math.abs(r.net_per_sqft) / max * 100}%"></div>`;
  const pl = r => `${r.plantings}${r.season_fraction < 1 ? ` (${Math.round(r.season_fraction * 100)}%)` : ""}`;

  // Website: full table
  $("#rankTable").innerHTML = `<thead><tr><th>#</th><th>Crop</th><th class="r">Net $/sq ft</th><th class="barcell"><span class="sr-only">Net compared</span></th>
    <th class="r">Bad → good year</th><th class="r">Harvest value ${isMetric() ? "$/m²" : "$/sq ft"}</th><th class="r">lb/sq ft</th><th class="r">Plantings</th><th class="r">Water gal/sq ft</th><th>Fit</th><th><span class="sr-only">Add to plan</span></th></tr></thead><tbody>` +
    rows.map((r, i) => `<tr>
      <td class="dim num">${i < 3 ? `<span class="medal">${i + 1}</span>` : i + 1}</td>
      <td><strong>${nameBtn(r)}</strong> <span class="season-tag ${r.season}">${r.season}</span>${calChip(r)}${whyBtn("crop:" + r.id, "why-inline")}</td>
      <td class="r num"><strong>${perSq(r.net_per_sqft)}</strong></td>
      <td class="barcell">${bar(r)}</td>
      <td class="r num small">${range(r)}<div class="dim">${odds(r)}</div></td>
      <td class="r num">${perSq(r.value_per_sqft)}</td><td class="r num">${fmt(r.yield_lb_per_sqft * (isMetric() ? KG_PER_LB * SQFT_PER_M2 : 1), 2)}</td>
      <td class="r num">${pl(r)}</td><td class="r num">${fmt(r.water_gal_per_sqft * (isMetric() ? L_PER_GAL * SQFT_PER_M2 : 1), isMetric() ? 0 : 1)}</td>
      <td class="small"><span class="dim">${esc(r.note)}</span>${r.soil_fit < 1 ? `<br><span class="status-low">${esc(r.soil_note)}</span>` : ""}${sunNote(r)}</td>
      <td>${action(r)}</td></tr>`).join("") + "</tbody>";

  // App: compact list
  $("#rankList").innerHTML = rows.map((r, i) => `<li>
      <span class="pos num">${i < 3 ? `<span class="medal">${i + 1}</span>` : i + 1}</span>
      <span><strong>${nameBtn(r)}</strong> <span class="season-tag ${r.season}">${r.season}</span>${calChip(r)}${whyBtn("crop:" + r.id, "why-inline")}</span>
      <span class="num"><strong>${money(r.net_per_sqft)}</strong><span class="dim small">/sq ft</span></span>
      ${bar(r)}
      <span class="meta">${risk?.[r.id] ? `Bad year ${perSq(risk[r.id].bad)} · good ${perSq(risk[r.id].good)} · ` : ""}${perSq(r.value_per_sqft)} harvest · ${pl(r)} planting${r.plantings > 1 ? "s" : ""} · ${fmt(r.water_gal_per_sqft)} gal/sq ft${r.soil_fit < 1 ? ` · <span class="status-low">${esc(r.soil_note)}</span>` : ""}${r.sun_fit < 1 ? ` · <span class="status-low">${Math.round(r.sun_fit * 100)}% in this sun</span>` : ""}</span>
      <span class="meta" style="text-align:right">${action(r)}</span>
    </li>`).join("");
  $$("[data-add]").forEach(b => (b.onclick = () => addToPlan(b.dataset.add)));
}
function syncRankControls() {
  const sun = LAST?.settings.sunHours;
  $$("#sunSeg button").forEach(b => { const on = RANK_SUN != null ? +b.dataset.sun === RANK_SUN : sun == null ? b.dataset.sun === "8" : Math.abs(+b.dataset.sun - sun) < 1; b.classList.toggle("on", on); b.setAttribute("aria-checked", on); });
  $$("#rankBy button").forEach(b => { const on = b.dataset.by === RANK_BY; b.classList.toggle("on", on); b.setAttribute("aria-checked", on); b.disabled = b.dataset.by === "safe" && !LAST?.risk; });
  $("#riskStatus").textContent = HSTATE === "ok" && HIST ? `Ranges replay each crop through ${HIST.climates.length} past seasons here (${HIST.climates[0].year}-${HIST.climates[HIST.climates.length - 1].year}). "Bad year" means 1 season in 10.`
    : HSTATE === "loading" ? "Loading 15 years of local weather for good-year / bad-year ranges…"
    : HSTATE === "failed" ? "Past-season weather couldn't be loaded, so ranges are unavailable right now. Everything else is unaffected." : "";
}
$$("#sunSeg button").forEach(b => (b.onclick = () => { RANK_SUN = +b.dataset.sun; store.set("ranksun", RANK_SUN); markLive(); recompute(); }));
$$("#rankBy button").forEach(b => (b.onclick = () => { if (b.disabled) return; RANK_BY = b.dataset.by; store.set("rankby", RANK_BY); if (LAST) renderRanking(LAST.ranking); }));

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
  $("#roiTable").innerHTML = `<thead><tr><th>Bed</th><th class="r">${isMetric() ? "m²" : "Sq ft"}</th><th class="r">Harvest</th><th class="r">Value</th><th class="r">Plants</th></tr></thead><tbody>` +
    r.rows.map(x => `<tr><td>${esc(x.crop)}</td><td class="r num">${fmt(areaU.toShown(x.sqft), isMetric() ? 1 : 0)}</td><td class="r num">${fmt(x.harvest_lb)} lb</td><td class="r num">${money(x.value)}</td><td class="r num">${money(x.seed_cost)}</td></tr>`).join("") + "</tbody>";
}

function renderRisk() {
  const el = $("#riskBody"), pr = LAST?.planRisk;
  if (!el) return;
  if (!pr) {
    el.innerHTML = `<p class="small dim" style="margin:0">${LAST?.emptyPlan ? "Add a bed to see how your plan would have done in past seasons."
      : HSTATE === "failed" ? "Past-season weather couldn't be loaded right now, so this check is unavailable. The rest of the page is unaffected."
      : "Replaying your plan through 15 past seasons of local weather…"}</p>`;
    return;
  }
  const W = 320, H = 84, n = pr.years.length, bw = W / n, nets = pr.years.map(y => y.net);
  const hi = Math.max(0, ...nets), lo = Math.min(0, ...nets), span = (hi - lo) || 1;
  const yOf = v => 4 + (H - 8) * (hi - v) / span, mid = yOf(0);
  const barsSvg = pr.years.map((y, i) => {
    const up = y.net >= 0, h = Math.max(1, Math.abs(yOf(y.net) - mid));
    return `<rect x="${i * bw + 2}" y="${up ? mid - h : mid}" width="${Math.max(2, bw - 4)}" height="${h}" rx="2" fill="${up ? css("--moss") : css("--bad")}"><title>${y.year}: ${money(y.net, 0)}</title></rect>`;
  }).join("");
  el.innerHTML = `<div class="row" style="align-items:baseline;flex-wrap:wrap;gap:6px"><div class="big num ${pr.positive >= pr.n * 0.7 ? "pos" : "neg"}">${pr.positive} of ${pr.n}</div>
      <div class="small">past seasons this plan would have paid off ${whyBtn("risk:plan")}</div></div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Net savings in each past season">${barsSvg}<line x1="0" x2="${W}" y1="${mid}" y2="${mid}" stroke="${css("--line")}"/></svg>
    <div class="row small num dim"><span>${pr.years[0].year}</span><span>${pr.years[n - 1].year}</span></div>
    <div class="risk-tiles"><div><span class="eyebrow">Bad year</span><strong class="num">${money(pr.bad, 0)}</strong><span class="small dim">1 in 10 seasons</span></div>
      <div><span class="eyebrow">Typical</span><strong class="num">${money(pr.typical, 0)}</strong><span class="small dim">median season</span></div>
      <div><span class="eyebrow">Best</span><strong class="num">${money(pr.best, 0)}</strong><span class="small dim">${pr.best_year}</span></div></div>
    <p class="small dim" style="margin:8px 0 0">Worst was ${pr.worst_year} at ${money(pr.worst, 0)}. ${pr.positive < pr.n ? `To steady it, rank crops by "Bad year (safest)" on Crop value, or let "Plan it for me" pick.` : "A steady plan."}</p>`;
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
    c.frost.spring > 0 && !c.frost.frostFree ? `<i class="cal-line frost" style="left:${pct(wrapDoy(c.frost.spring))}%" title="Last spring frost"></i>` : "",
    c.frost.fall > 0 && c.frost.fall < 730 && (c.frost.fall <= 365 || c.frost.fall > 366) ? `<i class="cal-line frost" style="left:${pct(wrapDoy(c.frost.fall))}%" title="First fall frost"></i>` : "",
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
      : `<h2>Next 7 days</h2><p class="dim small" style="margin:0">The forecast couldn't be loaded right now, so day-by-day watering advice is unavailable. The monthly estimates below still apply.</p>`;
    return;
  }
  const frost = a.frost ? `<div class="banner ${a.frost.level}" role="alert">${esc(a.frost.text)}</div>` : "";
  const cell = day => {
    const cold = day.tmin !== null && day.tmin <= 32 ? " cold" : "";
    const deg = f => Math.round(isMetric() ? (f - 32) * 5 / 9 : f);
    const wx = `<div class="num">${deg(day.tmax)}°/${deg(day.tmin)}°</div><div class="t">${day.rain_in >= 0.01 ? `${fmt(day.rain_in, 2)} in rain` : "dry"}</div>`;
    const act = day.action
      ? `<div class="act">${day.action === "water" ? `Water ${fmt(day.inches, 2)} in<br><span class="num">${fmt(day.gallons, 0)} gal · ${money(day.cost)}</span>` : "Skip"}</div>` : "";
    return `<div class="fc-day ${day.action || ""}${cold}" title="${esc(day.reason || "")}"><div class="d">${day.label}</div><div class="t">${day.short}</div>${wx}${act}</div>`;
  };
  if (!a.active) {
    el.innerHTML = `<h2>Next 7 days</h2>${frost}<p class="dim small" style="margin:0 0 4px">${esc(a.reason)}</p><div class="fc-days" tabindex="0" role="region" aria-label="7-day forecast">${a.days.map(cell).join("")}</div>`;
    return;
  }
  const save = a.saved_gallons > 0
    ? `Skipping what rain covers saves <strong class="num">${money(a.saved_cost)}</strong> <span class="small dim">(${fmt(a.saved_gallons, 0)} gal vs. a daily timer)</span>`
    : "Little rain is coming, so plan to water as shown";
  el.innerHTML = `<div class="fc-head"><h2>Water plan: next 7 days</h2><span class="fc-save">${save} ${whyBtn("water:week")}</span></div>${frost}
    <div class="fc-days" tabindex="0" role="region" aria-label="7-day forecast">${a.days.map(cell).join("")}</div>
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
  const raw = $("#logLb").value;
  const entry = makeEntry({ crop: $("#logCrop").value, lb: raw === "" ? raw : weightU.fromShown(+raw) });
  if (!entry) return toast(`Enter the ${isMetric() ? "kilograms" : "pounds"} you picked (more than 0).`, { error: true });
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
$("#seasonCsv").onclick = () => {
  if (!LAST || !PLAN.some(p => p.sqft > 0)) return toast("Add beds and log some harvests first.");
  const year = new Date().getFullYear();
  const csv = seasonReport({ plan: PLAN, log: LOG, soil: LAST.soil, cl: LAST.climate, location: LOCATION, year, factors: factorsFromHistory(CALIB) });
  download(`ecoanalytics-season-${year}.csv`, csv, "text/csv");
  toast("Season report saved: predicted vs. actual for each crop, with your location rounded to about 50 km. Send it to help tune the yields.");
};
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

// ---- Calendar reminders (.ics) --------------------------------------------------------------------------------
function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}
$("#icsBtn").onclick = () => {
  if (!LAST?.calendar) return toast("Your calendar is still being worked out.");
  if (!LAST.calendar.crops.some(c => c.inPlan)) return toast("Add beds to your plan first; the calendar file holds your plan's dates.");
  download("my-garden-calendar.ics", buildICS(LAST.calendar, new Date(), location.origin + location.pathname), "text/calendar");
  toast("Calendar file saved. Open it to add the dates to your phone's calendar.");
};

// ---- Backup / restore ------------------------------------------------------------------------------------------
$("#backupBtn").onclick = () => {
  download(`ecoanalytics-backup-${new Date().toISOString().slice(0, 10)}.json`, makeBackup(localStorage), "application/json");
  toast("Backup saved. Restore it on any phone or computer from this same card.");
};
$("#restoreInput").addEventListener("change", async e => {
  const f = e.target.files?.[0];
  e.target.value = "";
  if (!f) return;
  try {
    const pairs = readBackup(await f.text());
    if (!confirm(`Restore this backup? It replaces your plan, settings, soil test and harvest log on this device.`)) return;
    for (const [k, v] of Object.entries(pairs)) localStorage.setItem(k, v);
    toast("Backup restored. Reloading…", { sticky: true });
    setTimeout(() => location.reload(), 600);
  } catch (err) { toast(err.message, { error: true }); }
});

// ---- Guide tab ---------------------------------------------------------------------------------------------------
const cropName = id => CROPS.find(c => c.id === id)?.name || id;
function renderGuideTab(d) {
  const probs = problemsFor(d.soil);
  const open = new Set($$("#problemList details[open]").map(x => x.dataset.id));
  $("#problemList").innerHTML = probs.map(p => `<details data-id="${p.id}" ${open.has(p.id) ? "open" : ""}><summary>${esc(p.title)} <span class="small dim">· ${esc(p.crops)}</span></summary>
    <div class="prob-body"><div class="eyebrow">Likely causes</div><ul class="notes">${p.causes.map(c => `<li>${esc(c)}</li>`).join("")}</ul>
    <div class="eyebrow" style="margin-top:8px">Cheapest fixes first</div><ol class="fixes">${p.fixes.map(c => `<li>${esc(c)}</li>`).join("")}</ol>
    ${p.soil_note ? `<div class="banner info small"><strong>Your soil:</strong> ${esc(p.soil_note)}</div>` : ""}</div></details>`).join("");
  renderGuideGrid();
}
function renderGuideGrid() {
  if (!LAST) return;
  const q = ($("#guideSearch").value || "").trim().toLowerCase();
  const byId = Object.fromEntries(LAST.ranking.map((r, i) => [r.id, { ...r, rank: i + 1 }]));
  $("#guideGrid").innerHTML = CROPS.filter(c => !q || c.name.toLowerCase().includes(q)).map(c => {
    const r = byId[c.id], g = GUIDE[c.id];
    return `<button class="guide-card" data-guide="${c.id}"><strong>${esc(c.name)}</strong>
      <span class="small dim">${esc(g.spacing.split("(")[0].trim())} · ${SUN_NEED[c.id]}h sun · ${c.days} days</span>
      <span class="small"><span class="season-tag ${c.season}">${c.season}</span> #${r.rank} here · <span class="num">${money(r.net_per_sqft)}</span>/sq ft</span></button>`;
  }).join("") || `<p class="dim small">No crop matches “${esc(q)}”.</p>`;
}
$("#guideSearch").addEventListener("input", renderGuideGrid);

const gsheet = $("#guideSheet");
function openGuide(id) {
  const c = CROPS.find(x => x.id === id), g = GUIDE[id];
  if (!c || !g || !LAST) return;
  const r = LAST.ranking.find(x => x.id === id), rank = LAST.ranking.indexOf(r) + 1, k = LAST.risk?.[id];
  const cal = LAST.calendar?.crops.find(x => x.id === id);
  const inPlan = PLAN.some(p => p.crop === id);
  const names = ids => ids.map(cropName).map(n => n.replace(/\s*\(.*\)/, "")).join(", ") || "—";
  $("#guideTitle").textContent = c.name;
  $("#guideSub").textContent = `${c.season === "warm" ? "Warm-season" : "Cool-season"} · ${c.days} days to harvest · needs ${SUN_NEED[id]}h of sun · pH ${c.ph[0]}-${c.ph[1]}`;
  $("#guideBody").innerHTML = `
    <div class="banner info small"><strong>In your yard:</strong> <span>#${rank} of ${LAST.ranking.length}, ${money(r.net_per_sqft)} net per sq ft.</span>${k ? ` <span>Bad year ${perSq(k.bad)}, good year ${perSq(k.good)}; paid off ${k.positive} of ${k.n} seasons.</span>` : ""} <span>${esc(r.note)}.</span>${cal ? ` <span>${esc(cal.now.text)}.</span>` : ""}</div>
    <dl class="guide-dl">
      <dt>Spacing</dt><dd>${esc(g.spacing)}</dd>
      <dt>Watering</dt><dd>${esc(g.water)}</dd>
      <dt>Ready when</dt><dd>${esc(g.ready)}</dd>
      <dt>Storing</dt><dd>${esc(g.store)}</dd>
      <dt>Good neighbours</dt><dd>${esc(names(g.friends))}</dd>
      <dt>Keep apart from</dt><dd>${esc(names(g.avoid))}</dd>
    </dl>
    <div class="eyebrow" style="margin-top:10px">Problems you may meet</div>
    ${g.pests.map(([n, sign, fix]) => `<div class="pest"><strong>${esc(n)}</strong> <span class="small dim">${esc(sign)}</span><div class="small">${esc(fix)}</div></div>`).join("")}
    <p class="small dim">Companion pairings are traditional advice; research support is mixed, so they never change your numbers.</p>
    <div style="display:flex;gap:8px;margin-top:8px">${inPlan ? `<span class="small dim">Already in your plan.</span>` : `<button class="btn" data-guide-add>+ Add 8 sq ft to my plan</button>`}</div>`;
  const add = $("[data-guide-add]", gsheet);
  if (add) add.onclick = () => { addToPlan(id); closeSheet(gsheet); };
  openSheet(gsheet);
}
function openSheet(d) { if (typeof d.showModal === "function") { if (!d.open) d.showModal(); } else d.setAttribute("open", ""); }
function closeSheet(d) { if (typeof d.close === "function") d.close(); else d.removeAttribute("open"); }
function backdropClose(d, onClose) {
  d.addEventListener("click", e => {
    if (e.target !== d) return;   // only the backdrop itself (content may have just resized under the pointer)
    const r = d.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeSheet(d);
  });
  if (onClose) d.addEventListener("close", onClose);
}
$("#guideClose").onclick = () => closeSheet(gsheet);
backdropClose(gsheet);
document.addEventListener("click", e => {
  const b = e.target.closest("[data-guide]");
  if (b) { e.preventDefault(); openGuide(b.dataset.guide); }
});

// ---- Sun at a bed: camera scan or quick estimate ----------------------------------------------------------------------
const ssheet = $("#sunSheet");
let SUN_BED = 0, SUN_RESULT = null;
const SCAN = { on: false, samples: [], stream: null, gotEvent: false, compass: false, timer: null, last: null };
const lat = () => LOCATION?.lat ?? 40;
const isSouth = () => lat() < 0;

function openSun(i) {
  SUN_BED = i; SUN_RESULT = null;
  const bed = PLAN[i];
  $("#sunTitle").textContent = `${cropName(bed.crop)}, ${fmt(bed.sqft, 0)} sq ft`;
  $("#sunFrom").textContent = "east"; $("#sunVia").textContent = isSouth() ? "north" : "south"; $("#sunTo").textContent = "west";
  const labels = isSouth() ? { E: "East", SE: "Northeast", S: "North", SW: "Northwest", W: "West" } : { E: "East", SE: "Southeast", S: "South", SW: "Southwest", W: "West" };
  const saved = store.get("sunquick", {});
  $("#quickGrid").innerHTML = DIRECTIONS.map(d => `<label>${labels[d.id]}<select data-dir="${d.id}">${HEIGHTS.map(h => `<option value="${h.id}" ${saved[d.id] === h.id ? "selected" : ""}>${esc(h.label)}</option>`).join("")}</select></label>`).join("");
  const canScan = typeof DeviceOrientationEvent !== "undefined" && (matchMedia("(pointer: coarse)").matches || "ontouchstart" in window);
  setSunMode(canScan ? "scan" : "quick");
  $("#sunResult").innerHTML = Number.isFinite(bed.sun) ? sunResultHtml(bed.sun, null, true) : "";
  wireResult();
  $("#scanMsg").textContent = canScan ? "" : "Scanning needs a phone's compass and tilt sensors. On a computer, use Quick estimate.";
  renderCover();
  openSheet(ssheet);
}
function setSunMode(m) {
  $$("#sunMode button").forEach(b => { const on = b.dataset.mode === m; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); });
  $("#sunScan").hidden = m !== "scan"; $("#sunQuick").hidden = m !== "quick";
  if (m !== "scan") stopScan();
}
$$("#sunMode button").forEach(b => (b.onclick = () => setSunMode(b.dataset.mode)));
$("#sunClose").onclick = () => closeSheet(ssheet);
backdropClose(ssheet, () => stopScan());

function sunResultHtml(hours, perMonth, current = false) {
  const bed = PLAN[SUN_BED], f = sunFactor(bed.crop, hours), open = sunHours(lat(), null).hours;
  return `<div class="sun-result">
    <div class="row" style="align-items:baseline;flex-wrap:wrap;gap:6px"><div class="big num">${fmt(hours)} h</div><div class="small">${current ? "saved for this bed · " : ""}direct sun a day, growing season (open sky here: ${fmt(open)} h)</div></div>
    <div><strong>${esc(sunLabel(hours))}.</strong> ${esc(whatGrows(hours))}</div>
    <div class="small ${f < 1 ? "status-low" : "status-ok"}">${esc(cropName(bed.crop))} needs about ${SUN_NEED[bed.crop]} h: expect ${Math.round(f * 100)}% of a full harvest here.</div>
    ${current ? `<div class="sun-actions"><button class="btn ghost" data-sun-act="clear">Forget (assume full sun)</button></div>` :
      `<div class="sun-actions"><button class="btn" data-sun-act="one">Use for this bed</button><button class="btn ghost" data-sun-act="all">Use for all beds</button></div>`}</div>`;
}
function wireResult() {
  const use = all => {
    if (SUN_RESULT == null) return;
    PLAN.forEach((p, i) => { if (all || i === SUN_BED) p.sun = SUN_RESULT; });
    store.set("plan", PLAN); renderPlan(); recompute(); closeSheet(ssheet);
    toast(`Saved ${fmt(SUN_RESULT)} hours of sun ${all ? "for every bed" : "for this bed"}. Yields and rankings now use it.`);
  };
  const u = $('[data-sun-act="one"]', ssheet), ua = $('[data-sun-act="all"]', ssheet), c = $('[data-sun-act="clear"]', ssheet);
  if (u) u.onclick = () => use(false);
  if (ua) ua.onclick = () => use(true);
  if (c) c.onclick = () => { delete PLAN[SUN_BED].sun; store.set("plan", PLAN); renderPlan(); recompute(); closeSheet(ssheet); };
}
function showSunResult(hours, perMonth) {
  SUN_RESULT = hours;
  $("#sunResult").innerHTML = sunResultHtml(hours, perMonth);
  wireResult();
  $("#sunResult").scrollIntoView?.({ behavior: "smooth", block: "nearest" });
}

$("#quickGo").onclick = () => {
  const choice = Object.fromEntries($$("#quickGrid select").map(s => [s.dataset.dir, s.value]));
  store.set("sunquick", choice);
  const res = sunHours(lat(), skylineFromEstimate(choice, lat()));
  showSunResult(res.hours, res.perMonth);
};

// Camera scan. Sensors only ever give angles; the video never leaves the phone.
function onOrient(e) {
  if (e.beta == null) return;
  SCAN.gotEvent = true;
  let heading = null;
  const dir = cameraDirection(e.alpha ?? 0, e.beta, e.gamma ?? 0);
  if (typeof e.webkitCompassHeading === "number" && e.webkitCompassHeading >= 0) heading = e.webkitCompassHeading;     // iPhone
  else if ((e.absolute || e.type === "deviceorientationabsolute") && e.alpha != null) heading = dir.heading;               // Android
  // Correction learned by aiming at the sun (phone compasses are often off by 10-20 degrees near metal or cars).
  if (heading != null) heading = ((heading + (+store.get("compassfix", 0) || 0)) % 360 + 360) % 360;
  if (heading == null) { if (!SCAN.compass) $("#sunRead").textContent = "Waiting for the compass…"; return; }
  SCAN.compass = true;
  SCAN.last = { heading, elevation: dir.elevation };
  $("#sunRead").textContent = `${compassName(heading)} ${Math.round(heading)}° · ${Math.max(0, Math.round(dir.elevation))}° up`;
  if (SCAN.on && SCAN.samples.length < 20000) { SCAN.samples.push(SCAN.last); if (SCAN.samples.length % 6 === 0) renderCover(); }
}
const ORIENT_EVT = "ondeviceorientationabsolute" in window ? "deviceorientationabsolute" : "deviceorientation";
async function startScan() {
  try {
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      const p = await DeviceOrientationEvent.requestPermission();
      if (p !== "granted") throw new Error("Motion & orientation access was declined. Use Quick estimate instead.");
    }
  } catch (err) { $("#scanMsg").textContent = err.message || "Sensors aren't available. Use Quick estimate."; return; }
  SCAN.samples = []; SCAN.on = true; SCAN.gotEvent = false;
  addEventListener(ORIENT_EVT, onOrient);
  try {
    SCAN.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    $("#sunVideo").srcObject = SCAN.stream;
  } catch { $("#scanMsg").textContent = "Camera isn't available, but you can still scan: point the top of the phone's back at the skyline."; }
  $("#scanStart").textContent = "Restart"; $("#scanDone").disabled = false;
  $("#viewfinder").classList.add("live");
  clearTimeout(SCAN.timer);
  SCAN.timer = setTimeout(() => {
    if (!SCAN.gotEvent || !SCAN.compass) {
      $("#scanMsg").textContent = "This browser doesn't share a compass with websites, so scanning can't work here. Use Quick estimate; it takes 20 seconds.";
      stopScan(); setSunMode("quick");
    }
  }, 3000);
  renderCover();
}
function stopScan() {
  SCAN.on = false;
  clearTimeout(SCAN.timer);
  removeEventListener(ORIENT_EVT, onOrient);
  if (SCAN.stream) { SCAN.stream.getTracks().forEach(t => t.stop()); SCAN.stream = null; }
  const v = $("#sunVideo"); if (v) v.srcObject = null;
  $("#viewfinder")?.classList.remove("live");
  $("#scanStart").textContent = "Start"; $("#scanDone").disabled = true;
}
$("#scanStart").onclick = () => { SCAN.calibrating = false; $("#sunCal").textContent = "Check compass with the sun"; stopScan(); startScan(); };
// Compass check: the app knows exactly where the sun is, so aiming at it shows how far off the compass reads.
$("#sunCal").onclick = async () => {
  const loc = LOCATION || { lat: 40, lon: -74 };
  const sun = sunNow(loc.lat, loc.lon);
  if (!SCAN.calibrating) {
    if (sun.elevation < 3) { $("#scanMsg").textContent = "The sun is down, so it can't be used to check the compass now. Try again in daylight."; return; }
    if (!SCAN.on) await startScan();
    SCAN.samples = [];
    SCAN.calibrating = true;
    $("#sunCal").textContent = "Lock on the sun";
    $("#scanMsg").textContent = `Without looking straight at it, put the cross on the sun (it's in the ${compassName(sun.azimuth)}, ${Math.round(sun.elevation)}° up), or the bright patch behind cloud, then tap Lock.`;
    return;
  }
  SCAN.calibrating = false;
  $("#sunCal").textContent = "Check compass with the sun";
  if (!SCAN.last) { $("#scanMsg").textContent = "No compass reading yet. Hold the phone up and try again."; return; }
  const raw = ((SCAN.last.heading - (+store.get("compassfix", 0) || 0)) % 360 + 360) % 360;
  const fix = compassOffset(raw, sun.azimuth);
  store.set("compassfix", fix);
  SCAN.samples = [];
  $("#scanMsg").textContent = Math.abs(fix) < 4 ? "Your compass is accurate. Tap Restart and sweep the skyline." : `Your compass was off by ${Math.abs(Math.round(fix))}°. Corrected; tap Restart and sweep the skyline.`;
};
$("#scanDone").onclick = () => {
  const samples = SCAN.samples.slice();
  stopScan();
  const sky = skylineFromSamples(samples);
  if (!sky) { $("#scanMsg").textContent = "That sweep was too narrow. Start again and turn slowly all the way from east to west."; return; }
  const res = sunHours(lat(), sky.skyline);
  $("#scanMsg").textContent = `Swept ${Math.round(sky.covered * 360)}° of the horizon.`;
  showSunResult(res.hours, res.perMonth);
};
function renderCover() {
  const on = coverage(SCAN.samples);
  // Show the half of the sky the sun crosses: east round to west through the equator side.
  const from = isSouth() ? 225 : 45, span = 270, cells = [];
  for (let a = from; a < from + span; a += BIN_DEG) {
    const az = a % 360, i = Math.floor(az / BIN_DEG) % BINS;
    cells.push(`<i class="${on[i] ? "on" : ""}" title="${compassName(az)}"></i>`);
  }
  const marks = [90, isSouth() ? 0 : 180, 270].map(az => [compassName(az), (((az - from) + 360) % 360) / span * 100]);
  $("#sunCover").innerHTML = `<div class="cells">${cells.join("")}</div><div class="cover-marks small dim">${marks.map(([n, p]) => `<span style="left:${p}%">${n}</span>`).join("")}</div>`;
}

// ---- This week in your garden -----------------------------------------------------------------------------------
const WEEK_ICON = {
  frost: `<path d="M12 2v20M4.9 6l14.2 12M19.1 6 4.9 18M9 3l3 3 3-3M9 21l3-3 3 3"/>`,
  heat: `<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>`,
  rain: `<path d="M7 15a5 5 0 1 1 9.6-2H17a3.5 3.5 0 0 1 0 7H8a4 4 0 0 1-1-5z"/><path d="M9 21l1-2m4 2 1-2"/>`,
  wind: `<path d="M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8"/>`,
  water: `<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>`,
  plant: `<path d="M12 21V10"/><path d="M12 13c0-4-3-6-7-6 0 4 3 6 7 6zM12 10c0-4 3-6 7-6 0 4-3 6-7 6z"/>`,
  harvest: `<path d="M5 11h14l-1.5 9h-11z"/><path d="M8 11l2-6m6 6-2-6"/>`,
  start: `<path d="M12 5v14M5 12h14"/>`, calm: `<path d="M5 13l4 4L19 7"/>`,
};
function renderWeek(d) {
  let acts = [];
  try {
    acts = weekActions({ days: FORECAST, plan: PLAN.filter(p => p.sqft > 0), cl: d.climate, calendar: d.calendar, advice: d.advice, soil: d.soil, today: localDoy() });
  } catch { acts = []; }
  $("#weekSub").textContent = FSTATE === "ok" ? "From the 7-day forecast, your calendar and your beds." : FSTATE === "loading" ? "Checking the forecast…"
    : FSTATE === "failed" ? "The forecast couldn't be loaded, so weather alerts are missing. Calendar dates still show." : "";
  $("#weekList").innerHTML = acts.slice(0, 8).map(a => `<li class="week-item ${a.level}">
    <span class="week-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${WEEK_ICON[a.kind] || WEEK_ICON.calm}</svg></span>
    <div><strong>${esc(a.title)}</strong><div class="small dim">${esc(a.detail)}</div></div></li>`).join("");
}

// ---- Simple view -------------------------------------------------------------------------------------------------------
// New visitors start with the essentials; everyone can switch with one tap. People who used the app before keep everything.
let VIEW = store.get("view", null);
if (VIEW !== "simple" && VIEW !== "full") { VIEW = store.get("toured", false) || store.get("plan", null) ? "full" : "simple"; store.set("view", VIEW); }
function applyView() {
  document.documentElement.dataset.view = VIEW;
  $("#viewBtn").textContent = VIEW === "simple" ? "Show everything" : "Simple view";
  const cur = $("nav.tabs button.on");
  if (VIEW === "simple" && cur?.classList.contains("adv")) showTab("soil");
}
function setView(v) { VIEW = v; store.set("view", v); applyView(); if (LAST) renderAll(LAST); toast(v === "simple" ? "Simple view: just the essentials." : "Showing everything."); }
$("#viewBtn").onclick = () => setView(VIEW === "simple" ? "full" : "simple");
document.addEventListener("click", e => { const b = e.target.closest("button[data-view]"); if (b) setView(b.dataset.view); });
applyView();

// ---- Prices where you live -----------------------------------------------------------------------------------------
let PRICES = (() => { const p = asObject(store.get("prices", {})); return Object.fromEntries(Object.entries(p).filter(([k, v]) => CROPS.some(c => c.id === k) && Number.isFinite(+v) && +v > 0).map(([k, v]) => [k, +v])); })();
const perUnitLabel = () => isMetric() ? "kg" : "lb";
const priceShown = usdPerLb => Math.round(toLocal(isMetric() ? usdPerLb / KG_PER_LB : usdPerLb) * 100) / 100;
const priceFromShown = v => toUSD(isMetric() ? +v * KG_PER_LB : +v);
function renderPrices() {
  const c = currency();
  $("#currencySel").innerHTML = Object.entries(CURRENCIES).map(([k, v]) => `<option value="${k}" ${k === c.code ? "selected" : ""}>${k} · ${esc(v.name)}</option>`).join("");
  $("#fxNote").textContent = c.code === "USD" ? "Prices are in US dollars." :
    `Converted at ${c.live ? "today's" : "an approximate"} rate: $1 = ${c.sym.trim()}${c.rate.toLocaleString("en-US", { maximumFractionDigits: 3 })}${c.live ? " (European Central Bank)" : ". Today's rate couldn't be loaded"}.`;
  $$("[data-cur]").forEach(s => (s.textContent = c.sym.trim()));
  $("#priceGrid").innerHTML = CROPS.map(cr => `<label><span>${esc(cr.name)}</span>
    <span class="price-in"><span class="dim">${esc(c.sym.trim())}</span><input type="number" min="0" step="0.05" inputmode="decimal" data-price="${cr.id}"
      value="${PRICES[cr.id] != null ? priceShown(PRICES[cr.id]) : ""}" placeholder="${priceShown(cr.price_per_lb)}" aria-label="${esc(cr.name)} price per ${perUnitLabel()}"><span class="dim small" data-units="us">/${perUnitLabel()}</span></span></label>`).join("");
  $("#priceCount").textContent = Object.keys(PRICES).length ? `(${Object.keys(PRICES).length} set)` : "";
  $$("#priceGrid [data-price]").forEach(inp => inp.addEventListener("change", () => {
    const v = parseFloat(inp.value);
    if (Number.isFinite(v) && v > 0) PRICES[inp.dataset.price] = Math.round(priceFromShown(v) * 1000) / 1000;
    else delete PRICES[inp.dataset.price];
    store.set("prices", PRICES);
    $("#priceCount").textContent = Object.keys(PRICES).length ? `(${Object.keys(PRICES).length} set)` : "";
    markLive(); recompute();
  }));
}
$("#currencySel").addEventListener("change", e => { store.set("currency", e.target.value); location.reload(); });
$("#priceReset").onclick = () => { PRICES = {}; store.set("prices", PRICES); renderPrices(); recompute(); };
renderPrices();

// ---- Frost & heat alerts (phone notifications, no server) ------------------------------------------------
const ALERTS_TAG = "eco-alerts";
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
async function writeAlertConfig(enabled = store.get("alerts", false)) {
  if (!("caches" in window) || !LOCATION) return;
  const ids = [...new Set(PLAN.filter(p => p.sqft > 0).map(p => p.crop))];
  const nm = id => CROPS.find(c => c.id === id).name.replace(/\s*\(.*\)/, "").toLowerCase();
  const cfg = { enabled: !!enabled, lat: LOCATION.lat, lon: LOCATION.lon, metric: isMetric(),
    tender: ids.filter(id => CROPS.find(c => c.id === id).season === "warm").map(nm),
    hardy: ids.filter(id => CROPS.find(c => c.id === id).season !== "warm" && !["kale", "garlic", "spinach"].includes(id)).map(nm) };
  try { await (await caches.open("eco-data")).put("alerts-config", new Response(JSON.stringify(cfg), { headers: { "content-type": "application/json" } })); } catch { /* storage full or blocked */ }
}
function alertStatus(text) { $("#alertMsg").textContent = text; }
function syncAlertButton() {
  const on = store.get("alerts", false);
  $("#alertBtn").textContent = on ? "Turn off phone alerts" : "Get frost & heat alerts on this phone";
  if (on) alertStatus("On: this phone checks the forecast about twice a day and warns you before frost or a heat wave.");
}
$("#alertBtn").onclick = async () => {
  if (store.get("alerts", false)) {
    store.set("alerts", false); await writeAlertConfig(false);
    try { const reg = await navigator.serviceWorker.ready; await reg.periodicSync?.unregister(ALERTS_TAG); } catch { /* not registered */ }
    alertStatus("Alerts are off."); syncAlertButton(); return;
  }
  const calTip = "Use “Add my plan to my phone's calendar” on the Calendar tab for planting reminders.";
  if (!("serviceWorker" in navigator) || !("Notification" in window)) return alertStatus(`This browser can't show alerts for websites. ${calTip}`);
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg || !("periodicSync" in reg)) {
    return alertStatus(isIOS() ? `iPhones don't let web apps check the weather in the background, so alerts can't work there. The weekly list above updates whenever you open the app. ${calTip}`
      : `Background checks need Chrome on Android with EcoAnalytics added to the home screen (menu ⋮ → Add to Home screen). ${calTip}`);
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return alertStatus("Notifications are blocked for this site. Allow them in your browser's site settings to get alerts.");
  try {
    await reg.periodicSync.register(ALERTS_TAG, { minInterval: 12 * 3600 * 1000 });
  } catch {
    return alertStatus("Add EcoAnalytics to your home screen first (menu ⋮ → Add to Home screen), open it from there, then turn alerts on.");
  }
  store.set("alerts", true); await writeAlertConfig(true); syncAlertButton();
  reg.active?.postMessage("eco-check-alerts");
};
syncAlertButton();

// ---- How your season is changing -----------------------------------------------------------------------------------
function sparkTrend(m, { invert = false } = {}) {
  const pts = m.points;
  if (pts.length < 3) return "";
  const W = 300, H = 70, pad = 6, xs = pts.map(p => p.year), ys = pts.map(p => p.value).concat([m.from, m.to].filter(Number.isFinite));
  const x0 = Math.min(...xs), x1 = Math.max(...xs), lo = Math.min(...ys), hi = Math.max(...ys), span = (hi - lo) || 1;
  const X = x => pad + (W - 2 * pad) * (x - x0) / ((x1 - x0) || 1), Y = v => invert ? pad + (H - 2 * pad) * (v - lo) / span : H - pad - (H - 2 * pad) * (v - lo) / span;
  const line = pts.map((p, i) => `${i ? "L" : "M"}${X(p.year).toFixed(1)},${Y(p.value).toFixed(1)}`).join("");
  const col = m.strength === "none" ? css("--ink-dim") : m.favourable ? css("--moss") : css("--bad");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(m.label)} by year">
    <path d="${line}" fill="none" stroke="${css("--line")}" stroke-width="2"/>
    ${pts.map(p => `<circle cx="${X(p.year).toFixed(1)}" cy="${Y(p.value).toFixed(1)}" r="2.6" fill="${css("--ink-dim")}"><title>${p.year}</title></circle>`).join("")}
    ${Number.isFinite(m.from) ? `<line x1="${X(x0)}" y1="${Y(m.from).toFixed(1)}" x2="${X(x1)}" y2="${Y(m.to).toFixed(1)}" stroke="${col}" stroke-width="3" stroke-linecap="round"/>` : ""}</svg>`;
}
function renderShift() {
  const body = $("#shiftBody");
  if (!body) return;
  if (HSTATE !== "ok" || !HIST) {
    $("#shiftSub").textContent = "";
    body.innerHTML = `<p class="small dim" style="margin:0">${HSTATE === "failed" ? "Past-season weather couldn't be loaded right now." : "Loading 15 years of local weather…"}</p>`;
    return;
  }
  const sh = climateShift(HIST.climates, { gddFactor: isMetric() ? 5 / 9 : 1 });
  if (!sh) { body.innerHTML = `<p class="small dim" style="margin:0">Not enough past seasons here to see a trend.</p>`; return; }
  $("#shiftSub").textContent = `${sh.first}-${sh.last}, at your garden`;
  const tag = m => m.strength === "clear" ? `<span class="trend-tag ${m.favourable ? "up" : "down"}">clear trend</span>` : m.strength === "possible" ? `<span class="trend-tag maybe">possible trend</span>` : `<span class="trend-tag none">steady</span>`;
  const show = sh.metrics.filter(m => m.points.length >= 3);
  body.innerHTML = `<p class="shift-head">${esc(sh.headline)}</p>
    <div class="shift-grid">${show.map(m => `<div class="shift-cell"><div class="row"><span class="eyebrow">${esc(m.label)}</span>${tag(m)}</div>
      ${sparkTrend(m, { invert: m.key === "last_spring_frost_doy" })}
      <div class="small dim">${esc(m.text)}${m.from_label && m.strength !== "none" ? ` (trend line: ${m.from_label} → ${m.to_label})` : ""}.</div></div>`).join("")}</div>
    <div class="eyebrow" style="margin-top:12px">What it means for you</div>
    <ul class="notes">${sh.ideas.map(i => `<li>${esc(i)}</li>`).join("")}</ul>
    <p class="small dim" style="margin:6px 0 0">${esc(sh.caveat)}</p>`;
}

// ---- Yard map ------------------------------------------------------------------------------------------------------------
let YARD = (() => { const y = asObject(store.get("yard", null)); return { w: Number.isFinite(+y.w) && +y.w >= 4 ? Math.min(300, +y.w) : DEFAULT_YARD.w, h: Number.isFinite(+y.h) && +y.h >= 4 ? Math.min(300, +y.h) : DEFAULT_YARD.h }; })();
let YARD_SEL = null;
const ftShown = ft => isMetric() ? Math.round(ft * 0.3048 * 10) / 10 : ft;
const ftFromShown = v => isMetric() ? +v / 0.3048 : +v;
function ensureLayout() {
  const needs = PLAN.some(p => p.sqft > 0 && ![p.x, p.y, p.w, p.h].every(Number.isFinite));
  if (!needs) return;
  const res = layout(PLAN, YARD);
  PLAN = res.plan; YARD = res.yard;
  store.set("plan", PLAN); store.set("yard", YARD);
}
const SEASON_FILL = { warm: "--clay-soft", cool: "--moss-soft" };
function renderYard() {
  const svg = $("#yardSvg");
  if (!svg) return;
  ensureLayout();
  if (document.activeElement !== $("#yardW")) $("#yardW").value = ftShown(YARD.w);
  if (document.activeElement !== $("#yardH")) $("#yardH").value = ftShown(YARD.h);
  $$("[data-yard-unit]").forEach(s => (s.textContent = isMetric() ? "m" : "ft"));
  const W = YARD.w, H = YARD.h, step = W * H > 3000 ? 5 : 1;
  svg.setAttribute("viewBox", `-0.5 -0.5 ${W + 1} ${H + 1}`);
  svg.style.aspectRatio = `${W + 1} / ${H + 1}`;
  const lines = [];
  for (let x = step; x < W; x += step) lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}"/>`);
  for (let y = step; y < H; y += step) lines.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}"/>`);
  const notes = yardNotes(PLAN, { southernHemisphere: (LOCATION?.lat ?? 40) < 0 });
  const flagged = new Set([...notes.warn, ...notes.shade].flatMap(n => n.beds));
  const fs = Math.max(0.55, Math.min(1.1, Math.min(W, H) / 22));
  const beds = PLAN.map((p, i) => {
    if (!(p.sqft > 0) || ![p.x, p.y, p.w, p.h].every(Number.isFinite)) return "";
    const c = CROPS.find(x => x.id === p.crop), sel = i === YARD_SEL;
    const label = c.name.replace(/\s*\(.*\)/, "");
    let inner = "";
    if (sel) {
      const sq = [];
      for (let x = 1; x < p.w; x++) sq.push(`<line x1="${p.x + x}" y1="${p.y}" x2="${p.x + x}" y2="${p.y + p.h}"/>`);
      for (let y = 1; y < p.h; y++) sq.push(`<line x1="${p.x}" y1="${p.y + y}" x2="${p.x + p.w}" y2="${p.y + y}"/>`);
      const dots = plantDots(p.crop, p.w, p.h).map(([dx, dy]) => `<circle cx="${p.x + dx}" cy="${p.y + dy}" r="${Math.min(0.32, 0.9 / Math.sqrt(Math.max(1, PER_SQFT[p.crop] || 1)))}"/>`).join("");
      inner = `<g class="sq">${sq.join("")}</g><g class="dots">${dots}</g><circle class="handle" data-handle="${i}" cx="${p.x + p.w}" cy="${p.y + p.h}" r="${Math.max(0.45, fs * 0.5)}"/>`;
    }
    // Shrink the label to fit the bed's width.
    const bfs = Math.max(0.35, Math.min(fs, (p.w - 0.3) / Math.max(4, label.length * 0.58)));
    const sub = `${fmt(p.sqft, 0)} sq ft${Number.isFinite(p.sun) ? ` · ${fmt(p.sun)}h sun` : ""}`;
    const sfs = Math.max(0.3, Math.min(bfs * 0.8, (p.w - 0.3) / Math.max(4, sub.length * 0.55)));
    const showText = p.h >= bfs * 1.2;
    return `<g class="bed ${sel ? "sel" : ""} ${flagged.has(i) ? "flag" : ""}" data-bed="${i}">
      <rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="0.25" fill="${css(SEASON_FILL[c.season])}"/>
      ${inner}
      ${showText ? `<text x="${p.x + 0.15}" y="${p.y + bfs * 1.0}" style="font-size:${bfs}px">${esc(label)}</text>
      ${p.h >= bfs + sfs * 1.6 ? `<text class="sub" x="${p.x + 0.15}" y="${p.y + bfs + sfs * 1.2}" style="font-size:${sfs}px">${sub}</text>` : ""}` : ""}</g>`;
  }).join("");
  const na = Math.max(1, fs * 1.4);
  svg.innerHTML = `<rect class="yard-bg" x="0" y="0" width="${W}" height="${H}" rx="0.4"/><g class="grid">${lines.join("")}</g>${beds}
    <g class="north" transform="translate(${W - na * 0.9},${na * 1.1})"><path d="M0 ${-na * 0.8} L${na * 0.35} ${na * 0.3} L0 ${na * 0.05} L${-na * 0.35} ${na * 0.3}Z"/><text y="${na * 1.2}" style="font-size:${na * 0.6}px" text-anchor="middle">N</text></g>`;
  renderYardDetail();
  $("#yardNotes").innerHTML = [...notes.warn.map(n => `<li class="status-low">${esc(n.text)}</li>`), ...notes.shade.map(n => `<li class="status-low">${esc(n.text)}</li>`), ...notes.good.slice(0, 3).map(n => `<li>${esc(n.text)}</li>`)].join("")
    || (PLAN.some(p => p.sqft > 0) ? `<li>No neighbour or shade problems in this layout.</li>` : "");
}
function renderYardDetail() {
  const el = $("#yardDetail"), p = PLAN[YARD_SEL];
  if (!p || !(p.sqft > 0)) { el.innerHTML = PLAN.some(b => b.sqft > 0) ? `<p class="small dim" style="margin:8px 0 0">Tap a bed to see its square-foot grid.</p>` : `<p class="small dim" style="margin:8px 0 0">Add beds in your garden plan above and they appear here.</p>`; return; }
  const c = CROPS.find(x => x.id === p.crop), n = plantCount(p.crop, p.sqft);
  const live = PLAN.map((b, i) => [b, i]).filter(([b]) => b.sqft > 0);
  const row = LAST?.roi?.rows?.[live.findIndex(([, i]) => i === YARD_SEL)];
  el.innerHTML = `<div class="yard-detail"><strong>${esc(c.name)}</strong>
    <span class="small">${fmt(p.w, 0)} ft × ${fmt(p.h, 0)} ft = ${fmt(p.sqft, 0)} sq ft · <strong>${n} plant${n === 1 ? "" : "s"}</strong> (${esc(spacingText(p.crop))})${Number.isFinite(p.sun) ? ` · ${fmt(p.sun)} h sun` : ""}${row && !LAST.emptyPlan ? ` · ${money(row.value - row.seed_cost, 0)} harvest after seeds` : ""}</span>
    <span class="yard-btns"><button class="btn ghost" data-yard-sun="${YARD_SEL}">Measure sun</button><button class="btn ghost" data-guide="${p.crop}">Growing guide</button></span></div>`;
  const b = $("[data-yard-sun]", el);
  if (b) b.onclick = () => openSun(+b.dataset.yardSun);
}
{
  const svg = $("#yardSvg");
  let drag = null;
  const pt = e => { const m = svg.getScreenCTM(); if (!m) return { x: 0, y: 0 }; const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse()); return { x: p.x, y: p.y }; };
  svg.addEventListener("pointerdown", e => {
    const h = e.target.closest("[data-handle]"), g = e.target.closest("[data-bed]");
    if (!h && !g) { if (YARD_SEL != null) { YARD_SEL = null; renderYard(); } return; }
    const i = +(h ? h.dataset.handle : g.dataset.bed), p = PLAN[i], at = pt(e);
    drag = { i, mode: h ? "size" : "move", start: at, orig: { x: p.x, y: p.y, w: p.w, h: p.h }, moved: false };
    svg.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  svg.addEventListener("pointermove", e => {
    if (!drag) return;
    const at = pt(e), dx = at.x - drag.start.x, dy = at.y - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) < 0.3) return;
    drag.moved = true;
    const o = drag.orig;
    const r = drag.mode === "move" ? { x: o.x + dx, y: o.y + dy, w: o.w, h: o.h } : { x: o.x, y: o.y, w: Math.max(1, o.w + dx), h: Math.max(1, o.h + dy) };
    PLAN = placeBed(PLAN, drag.i, r, YARD);
    YARD_SEL = drag.i;
    renderYard();
  });
  const end = () => {
    if (!drag) return;
    const d = drag; drag = null;
    if (!d.moved) { YARD_SEL = d.i; renderYard(); return; }
    store.set("plan", PLAN);
    if (d.mode === "size") { renderPlan(); recomputeSoon(); } else renderYard();
  };
  // On phones, a finger on a bed drags the bed; anywhere else on the map still scrolls the page.
  svg.addEventListener("touchstart", e => { if (e.target.closest?.("[data-bed],[data-handle]")) e.preventDefault(); }, { passive: false });
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
  const setYard = () => {
    const w = Math.round(ftFromShown($("#yardW").value)), h = Math.round(ftFromShown($("#yardH").value));
    if (!(w >= 4 && h >= 4)) return;
    YARD = { w: Math.min(300, w), h: Math.min(300, h) };
    // Pull beds back inside a smaller yard.
    PLAN = PLAN.map(p => [p.x, p.y, p.w, p.h].every(Number.isFinite) ? { ...p, x: Math.max(0, Math.min(p.x, YARD.w - Math.min(p.w, YARD.w))), y: Math.max(0, Math.min(p.y, YARD.h - Math.min(p.h, YARD.h))) } : p);
    store.set("yard", YARD); store.set("plan", PLAN); renderYard();
  };
  $("#yardW").addEventListener("change", setYard);
  $("#yardH").addEventListener("change", setYard);
  $("#yardTidy").onclick = () => {
    PLAN = PLAN.map(({ x, y, w, h, ...rest }) => rest);
    YARD_SEL = null; ensureLayout(); renderPlan(); recomputeSoon();
  };
}

// ---- Test-strip reader -------------------------------------------------------------------------------------------------
const stripSheet = $("#stripSheet");
const STRIP = { img: null, pad: null, swatches: [], values: [] };
function openStrip() {
  const type = $("#stripType").value || "ph";
  if (!$("#stripValues").value) $("#stripValues").value = STRIP_TYPES[type].values;
  stripReset();
  $("#stripStage").hidden = !STRIP.img;
  openSheet(stripSheet);
}
function stripReset() { STRIP.pad = null; STRIP.swatches = []; $("#stripResult").innerHTML = ""; drawStrip(); }
$("#stripBtn").onclick = openStrip;
$("#stripClose").onclick = () => closeSheet(stripSheet);
backdropClose(stripSheet);
$("#stripType").onchange = () => { $("#stripValues").value = STRIP_TYPES[$("#stripType").value].values; stripReset(); };
$("#stripValues").addEventListener("change", stripReset);
$("#stripRestart").onclick = stripReset;
$("#stripUndo").onclick = () => { if (STRIP.swatches.length) STRIP.swatches.pop(); else STRIP.pad = null; $("#stripResult").innerHTML = ""; drawStrip(); };
$("#stripFile").addEventListener("change", async e => {
  const f = e.target.files?.[0];
  e.target.value = "";
  if (!f) return;
  try {
    const url = URL.createObjectURL(f);
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error("That photo couldn't be opened.")); im.src = url; });
    const c = $("#stripCanvas"), scale = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight));
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    const off = document.createElement("canvas"); off.width = c.width; off.height = c.height;
    const ox = off.getContext("2d", { willReadFrequently: true }); ox.drawImage(img, 0, 0, c.width, c.height);
    STRIP.img = { canvas: off, data: ox.getImageData(0, 0, c.width, c.height) };
    URL.revokeObjectURL(url);
    $("#stripStage").hidden = false;
    stripReset();
  } catch (err) { toast(err.message || "That photo couldn't be opened.", { error: true }); }
});
function drawStrip() {
  const c = $("#stripCanvas"), vals = parseValues($("#stripValues").value).sort((a, b) => a - b);
  STRIP.values = vals;
  const step = $("#stripStep");
  if (!STRIP.img) { step.textContent = ""; return; }
  const ctx = c.getContext("2d");
  ctx.drawImage(STRIP.img.canvas, 0, 0);
  const rr = Math.max(8, c.width / 70);
  const mark = (p, label, color) => {
    ctx.lineWidth = Math.max(2, rr / 4); ctx.strokeStyle = "#fff"; ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.font = `600 ${Math.round(rr * 1.1)}px sans-serif`; ctx.fillStyle = "#fff"; ctx.strokeStyle = "rgba(0,0,0,.7)";
    ctx.strokeText(label, p.x + rr * 1.3, p.y + rr * 0.4); ctx.fillText(label, p.x + rr * 1.3, p.y + rr * 0.4);
  };
  if (STRIP.pad) mark(STRIP.pad, "test", `rgb(${STRIP.pad.rgb.map(Math.round).join(",")})`);
  STRIP.swatches.forEach(s => mark(s, String(s.value), `rgb(${s.rgb.map(Math.round).join(",")})`));
  if (vals.length < 2) { step.innerHTML = "Enter at least two values printed on the chart above."; return; }
  if (!STRIP.pad) step.innerHTML = "<strong>Step 1:</strong> tap the middle of the test pad or capsule.";
  else if (STRIP.swatches.length < vals.length) step.innerHTML = `<strong>Step ${STRIP.swatches.length + 2}:</strong> tap the chart colour for <strong>${vals[STRIP.swatches.length]}</strong>.`;
  else { step.innerHTML = "Done. Here's the reading:"; showStripResult(); }
}
$("#stripCanvas").addEventListener("pointerdown", e => {
  if (!STRIP.img || STRIP.values.length < 2) return;
  if (STRIP.pad && STRIP.swatches.length >= STRIP.values.length) return;
  const c = e.currentTarget, rect = c.getBoundingClientRect();
  const x = (e.clientX - rect.left) * c.width / rect.width, y = (e.clientY - rect.top) * c.height / rect.height;
  const rgb = sampleColor(STRIP.img.data, x, y, Math.max(3, Math.round(c.width / 150)));
  if (!STRIP.pad) STRIP.pad = { x, y, rgb };
  else STRIP.swatches.push({ x, y, rgb, value: STRIP.values[STRIP.swatches.length] });
  drawStrip();
});
function showStripResult() {
  const type = $("#stripType").value, t = STRIP_TYPES[type];
  let res;
  try { res = readStrip(STRIP.pad.rgb, STRIP.swatches); } catch (err) { $("#stripResult").innerHTML = `<p class="small status-low">${esc(err.message)}</p>`; return; }
  const save = toSoilTest(type, res);
  const words = { high: "Close match to the chart.", medium: "Reasonable match. Daylight and a sharp photo make it tighter.", low: "The colours don't match the chart well. Retake the photo in daylight, without shadows or flash." }[res.confidence];
  $("#stripResult").innerHTML = `<div class="sun-result">
    <div class="row" style="align-items:baseline;gap:6px;flex-wrap:wrap"><div class="big num">${fmt(save[t.field], t.decimals)}</div><div class="small">${esc(t.label)}</div></div>
    <div class="small ${res.confidence === "low" ? "status-low" : res.confidence === "high" ? "status-ok" : ""}">${esc(words)}${res.at_edge ? " It's at the end of the chart, so the true value may be beyond it." : ""} (Colour difference ${fmt(res.match)}.)</div>
    <div class="sun-actions"><button class="btn" data-strip-save>Save to my soil test</button></div></div>`;
  $("[data-strip-save]", stripSheet).onclick = () => {
    SOILTEST = { ...(SOILTEST || {}), ...save };
    store.set("soiltest", SOILTEST); fillTest(); markLive(); recompute();
    closeSheet(stripSheet);
    toast(`Saved ${t.label} ${fmt(save[t.field], t.decimals)}. Every number in the app now uses it.`);
  };
}

// ---- First-run tour -------------------------------------------------------------------------------------------------------
const TOUR = [
  { title: "Welcome to EcoAnalytics", body: () => `<p>A free garden planner that works out <strong>your</strong> soil, season, sun and money, then tells you what to grow, when, and what it's worth.</p>
      <p>Which units do you use?</p><div class="seg tour-units" data-units="us"><button data-u="us" class="${isMetric() ? "" : "on"}">US (°F, lb, sq ft)</button><button data-u="metric" class="${isMetric() ? "on" : ""}">Metric (°C, kg, m²)</button></div>` },
  { target: "#locBox", title: "Start with where your garden is", body: () => `<p>We guessed from your connection. For the best soil numbers, tap <strong>Change</strong> and enter your address, or use your phone's location.</p>` },
  { target: "#weekCard", title: "Your week, done for you", body: () => `<p>Frost, heat, storms, watering and planting dates for your actual beds, from the 7-day forecast. Check it once a week.</p>` },
  { target: "nav.tabs", title: "Everything else is one tap away", body: () => VIEW === "simple"
      ? `<p><strong>Crop value</strong> ranks what pays here. <strong>Garden ROI</strong> holds your beds. <strong>Calendar</strong> says when to plant. <strong>Guide</strong> fixes problems.</p><p>You're in the simple view. Tap <strong>Show everything</strong> any time for water, fertilizer, the yard map and good-year/bad-year odds.</p>`
      : `<p><strong>Crop value</strong> ranks what pays here. <strong>Garden ROI</strong> holds your beds, yard map and good-year/bad-year odds. <strong>Calendar</strong>, <strong>Water</strong> and <strong>Fertilizer</strong> plan the season. <strong>Guide</strong> fixes problems.</p><p>Tap any <span class="why-dot">i</span> to see exactly where a number comes from.</p>` },
  { title: "Free, private, yours", body: () => `<p>No account, no ads, no tracking. Your plan stays on this phone; save a backup any time from Garden ROI.</p><p>Tip: add it to your home screen to use it like an app.</p>` },
];
// Spanish tour (written whole, since it mixes bold words into sentences).
const TOUR_ES = [
  { title: "Te damos la bienvenida a EcoAnalytics", body: () => `<p>Un planificador de huerto gratuito que calcula <strong>tu</strong> suelo, temporada, sol y dinero, y te dice qué cultivar, cuándo y cuánto vale.</p>
      <p>¿Qué unidades usas?</p><div class="seg tour-units" data-units="us" translate="no"><button data-u="us" class="${isMetric() ? "" : "on"}">EE. UU. (°F, lb, pies²)</button><button data-u="metric" class="${isMetric() ? "on" : ""}">Métrico (°C, kg, m²)</button></div>` },
  { target: "#locBox", title: "Empieza por dónde está tu huerto", body: () => `<p>Lo calculamos por tu conexión. Para los mejores números de suelo, toca <strong>Cambiar</strong> y escribe tu dirección, o usa la ubicación del teléfono.</p>` },
  { target: "#weekCard", title: "Tu semana, ya organizada", body: () => `<p>Heladas, calor, tormentas, riego y fechas de siembra para tus canteros reales, según el pronóstico de 7 días. Revísalo una vez por semana.</p>` },
  { target: "nav.tabs", title: "Todo lo demás está a un toque", body: () => VIEW === "simple"
      ? `<p><strong>Valor de cultivos</strong> clasifica lo que rinde aquí. <strong>Rentabilidad</strong> guarda tus canteros. <strong>Calendario</strong> dice cuándo sembrar. <strong>Guía</strong> resuelve problemas.</p><p>Estás en la vista simple. Toca <strong>Mostrar todo</strong> cuando quieras para ver agua, abono, el mapa del patio y las probabilidades de año bueno/malo.</p>`
      : `<p><strong>Valor de cultivos</strong> clasifica lo que rinde aquí. <strong>Rentabilidad</strong> guarda tus canteros, el mapa del patio y las probabilidades de año bueno/malo. <strong>Calendario</strong>, <strong>Agua</strong> y <strong>Abono</strong> planifican la temporada. <strong>Guía</strong> resuelve problemas.</p><p>Toca cualquier <span class="why-dot">i</span> para ver de dónde sale cada número.</p>` },
  { title: "Gratis, privado, tuyo", body: () => `<p>Sin cuenta, sin anuncios, sin rastreo. Tu plan se queda en este teléfono; guarda una copia cuando quieras desde Rentabilidad.</p><p>Consejo: agrégala a tu pantalla de inicio para usarla como una app.</p>` },
];
let TOUR_I = 0;
function showTour(i) {
  TOUR_I = i;
  const s = (lang() === "es" ? TOUR_ES : TOUR)[i], box = $("#tour");
  $$(".tour-focus").forEach(x => x.classList.remove("tour-focus"));
  $("#tourStep").textContent = `${i + 1} of ${TOUR.length}`;
  $("#tourTitle").textContent = s.title;
  $("#tourBody").innerHTML = s.body();
  $("#tourDots").innerHTML = TOUR.map((_, k) => `<i class="${k === i ? "on" : ""}"></i>`).join("");
  $("#tourNext").textContent = i === TOUR.length - 1 ? "Start growing" : "Next";
  box.hidden = false;
  box.classList.toggle("anchored", !!s.target);
  if (s.target) { const t = $(s.target); if (t) { t.classList.add("tour-focus"); t.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" }); } }
  $$(".tour-units button").forEach(b => (b.onclick = () => {
    const metricNow = b.dataset.u === "metric";
    store.set("units", metricNow ? "metric" : "us");
    if (metricNow !== isMetric()) { store.set("tour_resume", 1); location.reload(); }
  }));
  $("#tourNext").focus({ preventScroll: true });
}
function endTour() {
  $("#tour").hidden = true;
  $$(".tour-focus").forEach(x => x.classList.remove("tour-focus"));
  store.set("toured", true);
}
$("#tourNext").onclick = () => (TOUR_I >= TOUR.length - 1 ? endTour() : showTour(TOUR_I + 1));
$("#tourSkip").onclick = endTour;
$("#tourBtn").onclick = () => { showTab("soil"); showTour(0); };
addEventListener("keydown", e => { if (e.key === "Escape" && !$("#tour").hidden) endTour(); });

// ---- Units ------------------------------------------------------------------------------------------------------------------------
$("#unitsLbl").textContent = isMetric() ? "°C · kg" : "°F · lb";
$("#langBtn").textContent = lang() === "es" ? "English" : "Español";
$("#langBtn").setAttribute("lang", lang() === "es" ? "en" : "es");
$("#langBtn").onclick = () => { store.set("lang", lang() === "es" ? "en" : "es"); location.reload(); };
$("#unitsBtn").onclick = () => { store.set("units", isMetric() ? "us" : "metric"); location.reload(); };

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
  $("#waterRate").value = wrToShown(6);   // typical US rate, in the units shown
  if (s) {
    $("#waterRate").value = wrToShown(+s.water || 0); $("#irrigation").value = s.irr; $("#setupCost").value = s.setup; $("#setupYears").value = s.years; $("#organicOnly").checked = s.org;
    if (s.labor != null) $("#laborHrs").value = s.labor;
    if (s.wage != null) $("#hourlyWage").value = s.wage;
  }
  $("#logLb").placeholder = isMetric() ? "kg picked" : "lb picked";
  fillTest();
  renderPlan();
  checkSharedPlan();
  const resume = store.get("tour_resume", 0);
  if (!store.get("toured", false) || resume) { store.set("tour_resume", 0); setTimeout(() => showTour(resume ? 1 : 0), 600); }
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
addEventListener("hashchange", () => { checkSharedPlan(); recompute(); });
// Redraw charts only when the width really changes (phones fire "resize" while
// scrolling as the address bar hides), and without replaying entrance animations.
let resizeT, lastW = innerWidth;
addEventListener("resize", () => {
  if (innerWidth === lastW) return;
  lastW = innerWidth;
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { if (LAST) { markLive(); renderCharts(LAST); } }, 200);
});
