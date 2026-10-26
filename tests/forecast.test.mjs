import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNet, njAddress, openMeteoDaily, sdaTable, forecastPayload } from "./helpers.mjs";
import * as climate from "../public/js/climate.js";
import * as soil from "../public/js/soil.js";
import * as fc from "../public/js/forecast.js";

const cl = climate.summarize(openMeteoDaily().daily, [2023, 2024, 2025]);
async function soilWith(opts) { const n = fakeNet(); n.sda = sdaTable(opts); return soil.researchSoil(njAddress()); }
const days = (start, spec) => fc.parseForecast(forecastPayload(start, spec).daily);
const PLAN = [{ crop: "tomato", sqft: 16 }, { crop: "pepper", sqft: 8 }];

test("forecast is requested from Open-Meteo and converted to inches", async () => {
  const net = fakeNet();
  net.forecast = forecastPayload("2026-07-14", i => (i === 3 ? { rain: 25.4 } : {}));
  const d = await fc.getForecast(39.87, -75.09);
  const url = net.calls.find(c => c.url.includes("/v1/forecast")).url;
  assert.match(url, /past_days=2/); assert.match(url, /forecast_days=7/); assert.match(url, /latitude=39\.87/);
  assert.equal(d.length, 9);
  assert.equal(d[3].rain_in, 1);                       // 25.4 mm = 1 in
  assert.ok(Math.abs(d[0].et0_in - 5 / 25.4) < 0.01);
});

test("a hot dry week means watering; the recommended gallons and dollars are consistent", async () => {
  const s = await soilWith({});
  const a = fc.wateringAdvice({ days: days("2026-07-14"), plan: PLAN, soil: s, cl, method: "hose", waterRate: 8 });
  assert.equal(a.available, true); assert.equal(a.active, true);
  assert.equal(a.days.length, 7);
  assert.ok(a.water_days >= 2);
  const sumGal = a.days.reduce((x, d) => x + d.gallons, 0);
  assert.ok(Math.abs(sumGal - a.week_gallons) <= a.water_days);        // per-day rounding only
  for (const d of a.days.filter(x => x.action === "water")) assert.ok(Math.abs(d.cost - d.gallons / 1000 * 8) < 0.01);
  assert.equal(a.saved_gallons, Math.max(0, a.timer_gallons - a.week_gallons));
  assert.equal(a.area_sqft, 24);
});

test("rain lets you skip, and the saving is measured against a timer that ignores rain", async () => {
  const s = await soilWith({});
  const rainy = days("2026-07-14", i => (i >= 3 && i <= 6 ? { rain: 20, tmax: 74 } : {}));
  const dry = days("2026-07-14");
  const a = fc.wateringAdvice({ days: rainy, plan: PLAN, soil: s, cl });
  const b = fc.wateringAdvice({ days: dry, plan: PLAN, soil: s, cl });
  assert.ok(a.week_gallons < b.week_gallons);
  assert.ok(a.saved_gallons > b.saved_gallons);
  assert.ok(a.saved_cost > 0);
  const rainDay = a.days.find(d => d.rain_in > 0.5);
  assert.equal(rainDay.action, "skip"); assert.match(rainDay.reason, /Rain/);
});

test("light drizzle under 0.1 in doesn't count as rain", async () => {
  const s = await soilWith({});
  const drizzle = days("2026-07-14", () => ({ rain: 1.5 }));              // ~0.06 in a day
  const dry = days("2026-07-14");
  const a = fc.wateringAdvice({ days: drizzle, plan: PLAN, soil: s, cl });
  const b = fc.wateringAdvice({ days: dry, plan: PLAN, soil: s, cl });
  assert.equal(a.week_gallons, b.week_gallons);
});

test("sandy soil needs more frequent watering than clay", async () => {
  const sand = await soilWith({ sand: 85, silt: 10, clay: 5 });
  const clay = await soilWith({ sand: 15, silt: 25, clay: 60 });
  assert.ok(fc.bucketInches(sand.texture_class) < fc.bucketInches(clay.texture_class));
  const a = fc.wateringAdvice({ days: days("2026-07-14"), plan: PLAN, soil: sand, cl });
  const b = fc.wateringAdvice({ days: days("2026-07-14"), plan: PLAN, soil: clay, cl });
  assert.ok(a.water_days > b.water_days);
});

test("drip uses less water than a hose for the same plan", async () => {
  const s = await soilWith({});
  const hose = fc.wateringAdvice({ days: days("2026-07-14"), plan: PLAN, soil: s, cl, method: "hose" });
  const drip = fc.wateringAdvice({ days: days("2026-07-14"), plan: PLAN, soil: s, cl, method: "drip" });
  assert.ok(drip.week_gallons < hose.week_gallons);
});

test("nothing growing means no watering plan, but still a frost check", async () => {
  const s = await soilWith({});
  const winter = days("2026-01-14", () => ({ tmax: 40, tmin: 25, et: 0.4 }));
  const a = fc.wateringAdvice({ days: winter, plan: PLAN, soil: s, cl });
  assert.equal(a.available, true); assert.equal(a.active, false);
  assert.match(a.reason, /Nothing in your plan is growing/);
  assert.equal(a.days.length, 7);
  assert.equal(a.frost, null);                                              // tomatoes are not in the ground in January
  assert.equal(fc.wateringAdvice({ days: winter, plan: [], soil: s, cl }).active, false);
});

test("freeze warning names the tender crops, and only when they could still be growing", async () => {
  const s = await soilWith({});
  const oct = days("2026-10-14", i => (i === 5 ? { tmin: 28 } : { tmin: 50 }));
  const a = fc.wateringAdvice({ days: oct, plan: PLAN, soil: s, cl });
  assert.equal(a.frost.level, "freeze");
  assert.match(a.frost.text, /Tomatoes/); assert.match(a.frost.text, /peppers/i);
  const chilly = days("2026-10-14", i => (i === 5 ? { tmin: 35 } : { tmin: 50 }));
  assert.equal(fc.wateringAdvice({ days: chilly, plan: PLAN, soil: s, cl }).frost.level, "chilly");
  assert.equal(fc.frostWatch(oct.slice(2), [{ crop: "kale", sqft: 8 }], cl), null);   // hardy crops: no warning
});

test("missing or short forecasts are handled, not thrown", async () => {
  const s = await soilWith({});
  assert.equal(fc.wateringAdvice({ days: null, plan: PLAN, soil: s, cl }).available, false);
  assert.equal(fc.wateringAdvice({ days: days("2026-07-14").slice(0, 2), plan: PLAN, soil: s, cl }).available, false);
});

test("forecast service failure surfaces as an error the page catches", async () => {
  const net = fakeNet(); net.fail.add("api.open-meteo.com/v1/forecast");
  await assert.rejects(() => fc.getForecast(39.87, -75.09));
});
