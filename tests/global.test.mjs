// Southern hemisphere, phone alerts, more crops, currency, Spanish, season report, compass check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNet, njAddress, openMeteoDaily } from "./helpers.mjs";
import * as climate from "../public/js/climate.js";
import * as soilMod from "../public/js/soil.js";
import * as eco from "../public/js/economics.js";
import { plantingCalendar } from "../public/js/planner.js";
import { CROPS } from "../public/js/data.js";
import { GUIDE } from "../public/js/guide.js";
import { SUN_NEED, sunNow, compassOffset } from "../public/js/sun.js";
import { PER_SQFT } from "../public/js/yard.js";
import * as cur from "../public/js/currency.js";
import * as units from "../public/js/units.js";
import * as i18n from "../public/js/i18n.js";
import { ES } from "../public/js/lang-es.js";
import { seasonReport } from "../public/js/calibration.js";
import "../public/alerts-core.js";

const { EcoAlerts } = globalThis;
async function njSoil() { fakeNet(); return soilMod.researchSoil(njAddress()); }

// A Sydney-like year: coldest in July, frost from mid-May to mid-September.
function southDaily(years = [2022, 2023, 2024]) {
  const time = [], tmax = [], tmin = [], p = [], et = [];
  for (const y of years) for (let d = 1; d <= 365; d++) {
    time.push(new Date(Date.UTC(y, 0, d)).toISOString().slice(0, 10));
    const c = Math.cos(2 * Math.PI * (d - 15) / 365);
    tmin.push(40 + 18 * c); tmax.push(62 + 20 * c); p.push(2); et.push(3 + 2 * c);
  }
  return { time, temperature_2m_max: tmax, temperature_2m_min: tmin, precipitation_sum: p, et0_fao_evapotranspiration: et };
}

// ---- Southern hemisphere --------------------------------------------------------------------------
test("south of the equator the frost-free season runs across New Year", () => {
  const cl = climate.summarize(southDaily(), [2022, 2023, 2024]);
  assert.equal(cl.southern, true);
  assert.ok(cl.frost_free_days > 200 && cl.frost_free_days < 270, cl.frost_free_days);
  assert.match(cl.last_spring_frost, /^Sep/);
  assert.match(cl.first_fall_frost, /^May/);
  assert.ok(cl.monthly_active_frac_warm[0] === 1 && cl.monthly_active_frac_warm[6] === 0, "January growing, July not");
  assert.ok(cl.season_gdd50 > 1500);
});

test("northern summaries are unchanged by the southern logic", () => {
  const cl = climate.summarize(openMeteoDaily().daily, [2023, 2024, 2025]);
  assert.equal(cl.southern, false);
  assert.ok(cl.first_fall_frost_doy <= 365);
});

test("southern planting calendar puts tomatoes in spring (Oct) and harvest over summer", async () => {
  const soil = await njSoil();
  const cl = climate.summarize(southDaily(), [2022, 2023, 2024]);
  const cal = plantingCalendar({ plan: [{ crop: "tomato", sqft: 8 }, { crop: "lettuce", sqft: 4 }], soil, cl, today: 300 });
  const tom = cal.crops.find(c => c.id === "tomato");
  const sow = tom.windows.find(w => w.kind === "sow");
  assert.ok(sow.start >= 260 && sow.start <= 300, `sow ${sow.start}`);
  assert.ok(tom.windows.filter(w => w.kind === "harvest").some(w => w.start <= 60), "harvest continues into Jan-Feb");
  for (const c of cal.crops) for (const w of c.windows) assert.ok(w.start >= 1 && w.end <= 365 && w.start <= w.end, `${c.id} ${w.start}-${w.end}`);
  assert.ok(eco.rankCrops(soil, cl).every(r => Number.isFinite(r.net_per_sqft)));
});

test("latitude fallback centres summer on January in the south", () => {
  const cl = climate.fallbackClimate(-35, [2024]);
  assert.ok(cl.monthly_tmean_f[0] > cl.monthly_tmean_f[6]);
  assert.ok(cl.monthly_active_frac_warm[0] > 0 && cl.monthly_active_frac_warm[6] === 0);
});

// ---- Phone alerts --------------------------------------------------------------------------------------
test("phone alerts: frost for tender crops, hard freeze for all, heat; each shown once", () => {
  const days = [{ date: "2026-05-01", tmin: 31, tmax: 60 }, { date: "2026-05-02", tmin: 24, tmax: 50 }, { date: "2026-05-03", tmin: 20, tmax: 40 }];
  const cfg = { tender: ["tomatoes", "peppers"], hardy: ["lettuce"], metric: false };
  const a = EcoAlerts.alertsFor(days, cfg, []);
  assert.deepEqual(a.map(x => x.id), ["frost:2026-05-01", "freeze:2026-05-02"], "only the next two days");
  assert.match(a[0].title, /tonight \(31°F\)/);
  assert.match(a[1].body, /lettuce/);
  assert.deepEqual(EcoAlerts.alertsFor(days, cfg, a.map(x => x.id)), []);
  assert.deepEqual(EcoAlerts.alertsFor(days, { tender: [], hardy: ["lettuce"] }, []).map(x => x.id), ["freeze:2026-05-02"]);
  const hot = EcoAlerts.alertsFor([{ date: "2026-07-01", tmin: 75, tmax: 99 }], { tender: ["tomatoes"], hardy: [], metric: true }, []);
  assert.match(hot[0].title, /37°C/);
  assert.match(EcoAlerts.forecastUrl(40.123, -74.5), /latitude=40.12&longitude=-74.50.*forecast_days=3/);
  assert.equal(EcoAlerts.parse({ daily: { time: ["2026-01-01"], temperature_2m_max: [50], temperature_2m_min: [30] } })[0].tmin, 30);
});

// ---- More crops ------------------------------------------------------------------------------------------------
test("every crop (now 29) has guide, sun, spacing and calendar data", async () => {
  assert.ok(CROPS.length >= 29);
  for (const c of CROPS) {
    assert.ok(GUIDE[c.id] && SUN_NEED[c.id] && PER_SQFT[c.id], c.id);
    assert.ok(c.price_per_lb > 0 && c.yield_lb_per_sqft > 0 && c.days > 0, c.id);
  }
  const soil = await njSoil();
  const cl = climate.summarize(openMeteoDaily().daily, [2023, 2024, 2025]);
  const cal = plantingCalendar({ plan: [], soil, cl, today: 120 });
  assert.equal(cal.crops.length, CROPS.length);
});

test("your own store prices change the numbers", async () => {
  const soil = await njSoil();
  const cl = climate.summarize(openMeteoDaily().daily, [2023, 2024, 2025]);
  const base = eco.rankCrops(soil, cl).find(r => r.id === "kale");
  const dear = eco.rankCrops(soil, cl, { prices: { kale: 10 } }).find(r => r.id === "kale");
  assert.ok(dear.value_per_sqft > base.value_per_sqft * 2);
});

// ---- Currency ---------------------------------------------------------------------------------------------------
test("currency: defaults by region, converts both ways, formats", () => {
  assert.equal(cur.defaultCurrency("en-US"), "USD");
  assert.equal(cur.defaultCurrency("de-DE"), "EUR");
  assert.equal(cur.defaultCurrency("en-GB"), "GBP");
  assert.equal(cur.defaultCurrency("xx"), "USD");
  try {
    cur.setCurrency("EUR", 0.9);
    assert.equal(cur.currency().rate, 0.9);
    assert.equal(cur.currency().live, true);
    assert.equal(cur.money(10), "€9.00");
    assert.equal(cur.money(-10), "−€9.00");
    assert.ok(Math.abs(cur.toUSD(cur.toLocal(7)) - 7) < 1e-9);
    cur.setCurrency("JPY");
    assert.equal(cur.currency().live, false);
    assert.equal(cur.money(10), "¥1,500");
    units.setMetric(true);
    cur.setCurrency("EUR", 0.9);
    assert.equal(units.convertText("€2.00/sq ft"), "€21.53/m²");
    assert.equal(units.convertText("at €5.40 per 1,000 gal"), "at €1.43 per m³");
  } finally { cur.setCurrency("USD"); units.setMetric(false); }
  assert.equal(cur.money(1234.5), "$1,234.50");
});

test("today's rate comes from the ECB (Frankfurter)", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async u => new Response(JSON.stringify({ base: "USD", rates: { GBP: 0.8 } }));
  try { assert.equal(await cur.fetchRate("GBP"), 0.8); assert.equal(await cur.fetchRate("USD"), 1); }
  finally { globalThis.fetch = real; }
});

// ---- Spanish -------------------------------------------------------------------------------------------------------
test("Spanish: phrases with numbers, crops, weekdays and dates are translated; unknown text is left alone", () => {
  i18n.setLang("es");
  try {
    assert.equal(i18n.translateText("Water on Tue and Fri"), "Regar el martes y el viernes");
    assert.equal(i18n.translateText("Frost Saturday night (low 28°F)"), "Helada la noche del sábado (mínima 28°F)");
    assert.equal(i18n.translateText("Next planting Mar 19."), "Próxima siembra: 19 mar.");
    assert.equal(i18n.translateText("  Crop value "), "  Valor de cultivos ");
    assert.equal(i18n.translateText("Tomatoes (slicing)"), "Tomates (para rebanar)");
    assert.equal(i18n.translateText("Something not in the phrase book"), "Something not in the phrase book");
    assert.equal(i18n.translateText("#9 of 29, $2.95 net per sq ft."), "n.º 9 de 29, $2.95 netos por pie².");
  } finally { i18n.setLang("en"); }
  assert.equal(i18n.translateText("Crop value"), "Crop value", "English is untouched");
  assert.equal(i18n.defaultLang("es-MX"), "es");
  assert.equal(i18n.defaultLang("en-GB"), "en");
});

test("Spanish phrase book: every placeholder in a translation exists in its English key", () => {
  for (const [k, v] of Object.entries(ES)) {
    const keys = new Set(k.match(/\{[dwcnm]\d+\}/g) || []);
    for (const p of v.match(/\{[dwcnm]\d+\}/g) || []) assert.ok(keys.has(p), `${k} → ${v}`);
  }
  assert.ok(Object.keys(ES).length > 600);
});

// ---- Season report, compass check -------------------------------------------------------------------------------------
test("season report compares predicted and actual per crop, with location rounded", async () => {
  const soil = await njSoil();
  const cl = climate.summarize(openMeteoDaily().daily, [2023, 2024, 2025]);
  const plan = [{ crop: "tomato", sqft: 16, sun: 6 }, { crop: "lettuce", sqft: 8 }];
  const log = [{ id: "a", crop: "tomato", lb: 10, date: "2026-08-01" }, { id: "b", crop: "tomato", lb: 5, date: "2025-08-01" }];
  const csv = seasonReport({ plan, log, soil, cl, location: { lat: 40.3487, lon: -74.659 }, year: 2026 }).trim().split("\n");
  assert.equal(csv.length, 3);
  assert.match(csv[0], /^year,crop_id,crop,sqft,sun_hours,predicted_lb,actual_lb,actual_over_predicted/);
  const tom = csv[1].split(",");
  assert.equal(tom[1], "tomato"); assert.equal(tom[4], "6"); assert.equal(tom[6], "10");
  assert.ok(+tom[7] > 0);
  assert.ok(csv[1].includes(",40.5,-74.5,"));
});

test("sun position now and the compass correction", () => {
  // Solar noon at Greenwich around the March equinox: sun due south, about 90 - 51.5 = 38.5 degrees up.
  const p = sunNow(51.48, 0, new Date("2026-03-20T12:07:00Z"));
  assert.ok(Math.abs(p.azimuth - 180) < 3, p.azimuth);
  assert.ok(Math.abs(p.elevation - 38.5) < 2, p.elevation);
  assert.equal(compassOffset(170, 180), 10);
  assert.equal(compassOffset(350, 10), 20);
  assert.equal(compassOffset(10, 350), -20);
});
