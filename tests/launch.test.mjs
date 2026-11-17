// This week, season shift, yard map, test-strip reader, metric units, worldwide locations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNet, njAddress, openMeteoDaily, forecastPayload } from "./helpers.mjs";
import * as climate from "../public/js/climate.js";
import * as soilMod from "../public/js/soil.js";
import { parseForecast, wateringAdvice } from "../public/js/forecast.js";
import { plantingCalendar } from "../public/js/planner.js";
import { weekActions } from "../public/js/weekly.js";
import { linreg, strength, climateShift } from "../public/js/trend.js";
import * as yard from "../public/js/yard.js";
import * as strip from "../public/js/strip.js";
import * as units from "../public/js/units.js";
import { detectVPN } from "../public/js/geo.js";
import { CROPS } from "../public/js/data.js";

const cl = climate.summarize(openMeteoDaily().daily, [2023, 2024, 2025]);
async function njSoil() { fakeNet(); return soilMod.researchSoil(njAddress()); }

// ---- This week -----------------------------------------------------------------------------------
function week(start, f) {
  // 2 past days + 7 future days starting `start` (YYYY-MM-DD); f(i) overrides each future day.
  const d0 = new Date(start + "T12:00:00Z");
  return Array.from({ length: 9 }, (_, k) => {
    const d = new Date(d0.getTime() + (k - 2) * 864e5).toISOString().slice(0, 10);
    return { date: d, tmax: 75, tmin: 55, rain_in: 0, et0_in: 0.18, pop: 10, wind_mph: 8, ...(k >= 2 ? f?.(k - 2) : {}) };
  });
}
const plan = [{ crop: "tomato", sqft: 16 }, { crop: "lettuce", sqft: 8 }, { crop: "pepper", sqft: 4 }];

test("this week: a frost night puts covering tender crops first", async () => {
  const soil = await njSoil();
  const days = week("2025-05-10", i => (i === 3 ? { tmin: 30 } : {}));
  const acts = weekActions({ days, plan, cl, soil, calendar: plantingCalendar({ plan, soil, cl, today: 130 }), today: 130 });
  assert.equal(acts[0].kind, "frost");
  assert.equal(acts[0].level, "urgent");
  assert.match(acts[0].detail, /Tomatoes/);
  assert.match(acts[0].title, /30°F/);
});

test("this week: heat, heavy rain and wind each give a matching job", async () => {
  const soil = await njSoil();
  const days = week("2025-07-10", i => (i === 1 ? { tmax: 97 } : i === 2 ? { rain_in: 1.6 } : i === 4 ? { wind_mph: 32 } : {}));
  const acts = weekActions({ days, plan, cl, soil, calendar: null, today: 191 });
  const k = Object.fromEntries(acts.map(a => [a.kind, a]));
  assert.match(k.heat.detail, /Lettuce/); assert.match(k.heat.detail, /drop flowers/);
  assert.match(k.rain.detail, /split/);
  assert.match(k.wind.detail, /stakes/);
  assert.ok(!acts.some(a => a.kind === "frost"));
});

test("this week: watering days come from the watering plan; calm weeks say so; no plan asks for beds", async () => {
  const soil = await njSoil();
  const days = parseForecast(forecastPayload("2025-07-01").daily);
  const advice = wateringAdvice({ days, plan, soil, cl });
  const acts = weekActions({ days, plan, cl, soil, advice, calendar: null, today: 182 });
  assert.ok(acts.some(a => a.kind === "water"));
  assert.equal(weekActions({ days: null, plan: [], cl, today: 182 })[0].kind, "start");
  const calm = weekActions({ days: week("2025-07-10"), plan: [{ crop: "garlic", sqft: 4 }], cl, soil, calendar: null, today: 191 });
  assert.ok(calm.length >= 1);
});

test("this week: planting windows opening in the next 7 days are listed", async () => {
  const soil = await njSoil();
  const cal = plantingCalendar({ plan, soil, cl, today: 60 });
  const tomato = cal.crops.find(c => c.id === "tomato").windows.find(w => w.kind === "sow");
  const acts = weekActions({ days: null, plan, cl, soil, calendar: cal, today: tomato.start - 3 });
  assert.ok(acts.some(a => a.kind === "plant" && /Tomatoes/.test(a.title)));
});

// ---- Season shift ----------------------------------------------------------------------------------
test("linear trend: slope and when it counts as clear", () => {
  const xs = [2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020];
  const fit = linreg(xs, xs.map(x => 100 - 0.8 * (x - 2011)));
  assert.ok(Math.abs(fit.slope + 0.8) < 1e-9);
  assert.equal(strength(fit), "clear");
  const noisy = linreg(xs, [5, -5, 5, -5, 5, -5, 5, -5, 5, -5]);
  assert.equal(strength(noisy), "none");
  assert.equal(linreg([1, 2], [1, 2]), null);
});

test("season shift reads an earlier spring frost and a longer season", () => {
  const climates = Array.from({ length: 15 }, (_, i) => ({
    year: 2011 + i, last_spring_frost_doy: 115 - i + (i % 2 ? 2 : -2), first_fall_frost_doy: 290 + (i % 3) - 1,
    frost_free_days: 175 + i + (i % 2 ? 2 : -2), season_gdd50: 3000 + (i % 4) * 30,
  }));
  const sh = climateShift(climates);
  const by = Object.fromEntries(sh.metrics.map(m => [m.key, m]));
  assert.equal(by.last_spring_frost_doy.strength, "clear");
  assert.ok(by.last_spring_frost_doy.per_decade < -5);
  assert.ok(by.last_spring_frost_doy.favourable);
  assert.match(sh.headline, /earlier per decade/);
  assert.ok(sh.ideas.some(i => /second planting/.test(i)));
  assert.equal(climateShift(climates.slice(0, 5)), null);
});

// ---- Yard map ----------------------------------------------------------------------------------------
test("yard layout places every bed without overlap, inside the yard", () => {
  const p = [{ crop: "tomato", sqft: 16 }, { crop: "lettuce", sqft: 8 }, { crop: "basil", sqft: 4 }, { crop: "potato", sqft: 40 }, { crop: "kale", sqft: 2 }];
  const { plan: out, yard: Y } = yard.layout(p, { w: 20, h: 10 });
  for (const b of out) {
    assert.ok(b.w * b.h >= b.sqft, `${b.crop} rect holds its area`);
    assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= Y.w && b.y + b.h <= Y.h);
  }
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
    const a = out[i], b = out[j];
    assert.ok(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h), `${a.crop} overlaps ${b.crop}`);
  }
  // Already-placed beds stay put.
  const again = yard.layout(out, Y).plan;
  assert.deepEqual(again.map(b => [b.x, b.y]), out.map(b => [b.x, b.y]));
});

test("moving and resizing a bed snaps to whole feet, stays in the yard, and sets its area", () => {
  const p = yard.layout([{ crop: "tomato", sqft: 16 }], { w: 20, h: 10 }).plan;
  const moved = yard.placeBed(p, 0, { x: 30.4, y: -3, w: 4.4, h: 2.6 }, { w: 20, h: 10 });
  assert.deepEqual([moved[0].x, moved[0].y, moved[0].w, moved[0].h, moved[0].sqft], [16, 0, 4, 3, 12]);
  assert.equal(yard.resizeToArea({ ...moved[0], sqft: 20 }).h, 5);
});

test("plants per bed and plant dots follow square-foot spacing", () => {
  assert.equal(yard.plantCount("tomato", 16), 4);
  assert.equal(yard.plantCount("carrot", 2), 32);
  assert.equal(yard.plantCount("zucchini", 2), 1);
  assert.equal(yard.plantDots("carrot", 1, 1).length, 16);
  assert.equal(yard.plantDots("tomato", 4, 4).length, 4);
  for (const c of CROPS) assert.ok(yard.PER_SQFT[c.id] > 0, c.id);
  assert.match(yard.spacingText("tomato"), /1 plant per 4 sq ft/);
});

test("yard notes: touching bad neighbours, shade from tall crops on the south side", () => {
  const p = [
    { crop: "tomato", sqft: 16, x: 2, y: 10, w: 4, h: 4 },
    { crop: "lettuce", sqft: 8, x: 2, y: 6, w: 4, h: 2 },      // 2 ft north of the tomatoes
    { crop: "potato", sqft: 8, x: 7, y: 10, w: 2, h: 4 },      // 1 ft east of the tomatoes
    { crop: "basil", sqft: 4, x: 20, y: 1, w: 2, h: 2 },       // far away
  ];
  const n = yard.yardNotes(p);
  assert.ok(n.warn.some(w => w.beds.includes(0) && w.beds.includes(2)));
  assert.ok(n.shade.some(s => s.beds[0] === 0 && s.beds[1] === 1));
  assert.ok(!n.good.some(g => g.beds.includes(3)), "basil is too far to count");
  const south = yard.yardNotes(p, { southernHemisphere: true });
  assert.ok(!south.shade.some(s => s.beds[1] === 1));
});

// ---- Test strip ------------------------------------------------------------------------------------------
test("strip reader: colour maths and interpolation between chart colours", () => {
  const lab = strip.rgbToLab([255, 255, 255]);
  assert.ok(Math.abs(lab[0] - 100) < 0.5 && Math.abs(lab[1]) < 0.5 && Math.abs(lab[2]) < 0.5);
  const chart = [{ rgb: [230, 120, 40], value: 5 }, { rgb: [200, 200, 40], value: 6 }, { rgb: [60, 160, 70], value: 7 }];
  const exact = strip.readStrip([200, 200, 40], chart);
  assert.equal(exact.value, 6); assert.equal(exact.confidence, "high");
  const between = strip.readStrip([130, 180, 55], chart);
  assert.ok(between.value > 6 && between.value < 7, between.value);
  const off = strip.readStrip([20, 20, 220], chart);
  assert.equal(off.confidence, "low");
  assert.throws(() => strip.readStrip([1, 2, 3], chart.slice(0, 1)), /at least two/);
});

test("strip reader: sampling a photo and saving within sensible limits", () => {
  const w = 10, h = 10, data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(i % w < 5 ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4);
  assert.deepEqual(strip.sampleColor({ width: w, height: h, data }, 2, 5, 1), [255, 0, 0]);
  assert.deepEqual(strip.sampleColor({ width: w, height: h, data }, 8, 5, 1), [0, 0, 255]);
  assert.deepEqual(strip.parseValues("4.5, 5.5 6.5;x"), [4.5, 5.5, 6.5]);
  assert.deepEqual(strip.toSoilTest("ph", { value: 6.234 }), { ph: 6.2 });
  assert.deepEqual(strip.toSoilTest("ph", { value: 14 }), { ph: 10 });
  assert.deepEqual(strip.toSoilTest("k_ppm", { value: 151.6 }), { k_ppm: 152 });
});

// ---- Units -----------------------------------------------------------------------------------------------
test("metric text conversion covers every unit the app prints", () => {
  const c = units.convertText;
  assert.equal(c("16 sq ft"), "1.5 m²");
  assert.equal(c("$2.14/sq ft"), "$23.03/m²");
  assert.equal(c("Net $5.79 per sq ft"), "Net $62.32 per m²");
  assert.equal(c("41.2 lb at store prices"), "18.7 kg at store prices");
  assert.equal(c("0.95 lb/sq ft"), "4.6 kg/m²");
  assert.equal(c("1,250 gal"), "4,732 L");
  assert.equal(c("low 31°F"), "low -1°C");
  assert.equal(c("Days averaging 40–75°F"), "Days averaging 4–24°C");
  assert.equal(c("1 plant per 4 sq ft"), "2.7 plants per m²");
  assert.equal(c("Deep and even, 1-2 in a week."), "Deep and even, 2.5-5.1 cm a week.");
  assert.equal(c("0.25 in of rain"), "6.4 mm of rain");
  assert.equal(c("wind 35 mph"), "wind 56.3 km/h");
  assert.equal(c("Water rate ($ / 1,000 gal)"), "Water rate ($ per m³)");
  // Ordinary words are left alone, and metric text passes through.
  assert.equal(c("Plant in spring, grow in shade"), "Plant in spring, grow in shade");
  assert.equal(c("1.5 m² and 18.7 kg"), "1.5 m² and 18.7 kg");
  assert.equal(units.convertSplit("$5.79", "/sq ft").number, "$62.32");
  assert.equal(units.convertSplit("41.2", " lb at").unit, " kg at");
});

test("metric is the default outside the US; inputs convert both ways", () => {
  assert.equal(units.defaultMetric("en-US"), false);
  assert.equal(units.defaultMetric("en-GB"), true);
  assert.equal(units.defaultMetric("es-MX"), true);
  assert.equal(units.defaultMetric("fr"), true);
  units.setMetric(true);
  try {
    assert.equal(units.area.toShown(10.7639), 1);
    assert.ok(Math.abs(units.area.fromShown(1) - 10.7639) < 1e-6);
    assert.ok(Math.abs(units.weight.fromShown(units.weight.toShown(10)) - 10) < 0.02);
    assert.ok(Math.abs(units.waterPrice.fromShown(units.waterPrice.toShown(6)) - 6) < 0.02);
  } finally { units.setMetric(false); }
  assert.equal(units.area.toShown(16), 16);
});

test("connections from outside the US are no longer treated as suspicious", () => {
  assert.deepEqual(detectVPN({ org: "Deutsche Telekom AG", country: "DE", timezone: "Europe/Berlin" }, "Europe/Berlin"), []);
});
