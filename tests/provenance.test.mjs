import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNet, njAddress, openMeteoDaily, forecastPayload } from "./helpers.mjs";
import * as climate from "../public/js/climate.js";
import * as soil from "../public/js/soil.js";
import * as eco from "../public/js/economics.js";
import * as fc from "../public/js/forecast.js";
import { explain } from "../public/js/provenance.js";
import { CROPS } from "../public/js/data.js";

const cl = climate.summarize(openMeteoDaily().daily, [2023, 2024, 2025]);

async function ctx(soilTest = null) {
  fakeNet();
  const base = await soil.researchSoilBase(njAddress());
  const s = soil.applySoilTest(base, soilTest);
  const plan = [{ crop: "tomato", sqft: 16 }, { crop: "lettuce", sqft: 8 }];
  const settings = { waterRate: 6, method: "hose", setupCost: 100, setupYears: 5, organicOnly: false, yieldAdjust: { tomato: 0.8 }, laborHrPer100Week: 1, hourlyWage: 10 };
  return { soil: s, climate: cl, settings, ranking: eco.rankCrops(s, cl, settings), roi: eco.gardenROI(plan, s, cl, settings), emptyPlan: false,
    advice: fc.wateringAdvice({ days: fc.parseForecast(forecastPayload().daily), plan, soil: s, cl, method: "hose", waterRate: 6 }) };
}
const KEYS = ["soil:ph", "soil:organic_matter_pct", "soil:cec", "soil:p_ppm", "soil:k_ppm", "season:frost", "season:gdd", "season:cool", "season:rain",
  "roi:value", "roi:cost", "roi:net", "roi:time", "water:total", "water:cost", "water:rain", "water:week", "fert:store", "fert:season", "fert:nitrogen",
  ...CROPS.map(c => "crop:" + c.id)];

test("every number the page puts an 'i' button on has a real explanation", async () => {
  const d = await ctx();
  for (const k of KEYS) {
    const e = explain(k, d);
    assert.ok(e, `no explanation for ${k}`);
    assert.ok(e.title && e.summary && Array.isArray(e.steps) && e.steps.length >= 1 && Array.isArray(e.sources), k);
    for (const step of e.steps.filter(Boolean)) assert.ok(!/undefined|NaN|\[object/.test(step), `${k}: ${step}`);
    assert.ok(!/undefined|NaN/.test(e.summary), `${k} summary: ${e.summary}`);
  }
});

test("unknown keys return nothing instead of throwing", async () => {
  const d = await ctx();
  for (const k of ["", "nope", "soil:nothing", "crop:ghost", "roi:x", "water:x", "fert:x", "season:x"]) assert.equal(explain(k, d), null, k);
  assert.equal(explain("soil:ph", null), null);
});

test("soil explanations tell the truth about the source", async () => {
  const d = await ctx();
  const ph = explain("soil:ph", d);
  assert.match(ph.steps[0], /SSURGO/); assert.match(ph.steps[0], new RegExp(`${d.soil.points_with_data} of ${d.soil.points_sampled}`));
  assert.match(ph.steps.join(" "), /Confidence: (High|Medium|Low)/);
  assert.match(explain("soil:p_ppm", d).steps[0], /Estimated from organic matter/);
  assert.match(explain("soil:k_ppm", d).steps[0], /clay/);
  const tested = await ctx({ ph: 6.5, p_ppm: 40 });
  assert.match(explain("soil:ph", tested).steps[0], /soil test/);
  assert.equal(explain("soil:ph", tested).caveat, null);
  assert.match(explain("soil:ph", d).caveat, /soil test/);
});

test("ROI explanations quote the numbers on screen", async () => {
  const d = await ctx();
  const v = explain("roi:value", d);
  assert.ok(v.steps.some(s => s.includes("Tomatoes (slicing)") && s.includes("calibration ×0.8")));
  const t = explain("roi:time", d);
  assert.match(t.steps[0], new RegExp(`${d.roi.labor.weeks} weeks`));
  assert.match(t.steps[2], /\$10\.00 per hour/);
  assert.match(t.caveat, /assumption/);
  const c = explain("roi:cost", d);
  assert.ok(c.steps.some(s => /Your time/.test(s)));
  assert.equal(explain("roi:value", { ...d, emptyPlan: true }), null);        // empty plan shows no tiles, so no explanation
});

test("crop explanations add up to the net shown in the ranking", async () => {
  const d = await ctx();
  const row = d.ranking.find(r => r.id === "tomato");
  const e = explain("crop:tomato", d);
  assert.match(e.summary, new RegExp(Math.abs(row.net_per_sqft).toFixed(2)));
  assert.ok(e.steps.some(s => /×0\.8/.test(s)));                              // calibration is disclosed
});

test("the watering explanation matches the plan on screen, and is absent when there is no plan", async () => {
  const d = await ctx();
  const e = explain("water:week", d);
  assert.match(e.summary, new RegExp(`${d.advice.water_days} watering day`));
  assert.ok(e.steps.some(s => s.includes(`${d.advice.timer_gallons.toLocaleString("en-US")} gal`)));
  assert.equal(explain("water:week", { ...d, advice: null }), null);
  assert.equal(explain("water:week", { ...d, advice: { available: true, active: false } }), null);
});
