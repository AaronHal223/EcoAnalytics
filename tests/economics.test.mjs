import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNet, njAddress, openMeteoDaily, sdaTable } from "./helpers.mjs";
import * as climate from "../public/js/climate.js";
import * as soil from "../public/js/soil.js";
import * as eco from "../public/js/economics.js";
import { FERTILIZERS } from "../public/js/data.js";

const cl = climate.summarize(openMeteoDaily().daily, [2023, 2024, 2025]);
async function njSoil(opts) { const n = fakeNet(); if (opts) n.sda = sdaTable(opts); return soil.researchSoil(njAddress()); }
const near = (a, b, tol = 0.02) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test("frost dates and season from weather history", () => {
  assert.equal(cl.last_spring_frost, "Apr 15");
  assert.ok(cl.frost_free_days >= 180 && cl.frost_free_days <= 186);
  assert.ok(cl.season_gdd50 > 1000);
  near(cl.monthly_precip_in.reduce((a, b) => a + b, 0), cl.annual_precip_in, 0.1);
  assert.ok(Math.max(...cl.monthly_et0_in) > Math.min(...cl.monthly_et0_in));
});

test("climate falls back when the weather service is down", async () => {
  const net = fakeNet(); net.fail.add("open-meteo");
  const c = await climate.getClimate(39.9, -75.1, new Date("2026-10-15"));
  assert.deepEqual(c.years, [2023, 2024, 2025]);
  assert.match(c.source, /unreachable/);
});

test("pH yield factor with tolerance", () => {
  const tom = eco.CROP_BY_ID.tomato;
  assert.equal(eco.phFactor(tom, 6.5), 1);
  assert.equal(eco.phFactor(tom, 6.1), 1);
  assert.equal(eco.phFactor(tom, 5.2), 0.8);
  assert.equal(eco.phFactor(tom, 3.0), 0.5);
});

test("short season penalises warm crops", () => {
  const fit = eco.seasonFit(eco.CROP_BY_ID.sweet_corn, { ...cl, frost_free_days: 70, season_gdd50: 700 });
  assert.ok(fit.fraction < 0.6); assert.match(fit.note, /too short/);
});

test("ranking is complete and sorted", async () => {
  const r = eco.rankCrops(await njSoil(), cl);
  assert.equal(r.length, Object.keys(eco.CROP_BY_ID).length);
  for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].net_per_sqft >= r[i].net_per_sqft);
});

test("price override moves a crop up", async () => {
  const s = await njSoil();
  const base = eco.rankCrops(s, cl).find(x => x.id === "carrot");
  const bumped = eco.rankCrops(s, cl, { prices: { carrot: 10 } }).find(x => x.id === "carrot");
  assert.ok(bumped.net_per_sqft > base.net_per_sqft);
});

test("water scales with area and watering method", async () => {
  const s = await njSoil();
  const small = eco.waterPlan([{ crop: "tomato", sqft: 10 }], s, cl);
  const big = eco.waterPlan([{ crop: "tomato", sqft: 20 }], s, cl);
  const drip = eco.waterPlan([{ crop: "tomato", sqft: 20 }], s, cl, 6, "drip");
  near(big.total_gallons / small.total_gallons, 2, 0.02);
  assert.ok(drip.total_gallons < big.total_gallons && big.drip_savings > 0);
  assert.equal(big.monthly_gallons[0] + big.monthly_gallons[1], 0);  // nothing planted Jan/Feb
});

test("fertilizer optimizer meets needs with whole bags", async () => {
  const s = await njSoil();
  const f = eco.optimizeFertilizer([{ crop: "sweet_corn", sqft: 60 }, { crop: "kale", sqft: 40 }], s, cl);
  for (const k of ["N", "P2O5", "K2O"]) assert.ok(f.supplied_lb[k] >= f.need_lb[k] - 1e-6, k);
  assert.ok(f.purchases.length > 0);
  for (const p of f.purchases) {
    assert.ok(Number.isInteger(p.bags) && p.bags >= 1);
    assert.ok(p.lbs_to_apply <= p.bags * p.bag_lb + 1e-6);
  }
});

test("organic-only uses only organic products", async () => {
  const s = await njSoil();
  const organic = new Set(FERTILIZERS.filter(f => f.organic).map(f => f.name));
  const f = eco.optimizeFertilizer([{ crop: "spinach", sqft: 50 }], s, cl, true);
  assert.ok(f.purchases.length && f.purchases.every(p => organic.has(p.name)));
});

test("acid soil gets lime, alkaline soil gets sulfur, rich soil skips compost", async () => {
  assert.equal(eco.phAdjustment(await njSoil({ ph: 5.2 }), 100).product, "Pelletized limestone");
  assert.equal(eco.phAdjustment(await njSoil({ ph: 8.0 }), 100).product, "Elemental sulfur");
  assert.equal(eco.compostAdjustment(await njSoil({ om: 9 }), 100), null);
});

test("ROI adds up", async () => {
  const r = eco.gardenROI([{ crop: "tomato", sqft: 16 }, { crop: "basil", sqft: 4 }], await njSoil(), cl, { setupCost: 100, setupYears: 5 });
  near(r.total_cost, Object.values(r.costs).reduce((a, b) => a + b, 0));
  near(r.net, r.harvest_value - r.total_cost);
  assert.equal(r.costs.setup_per_year, 20);
  near(r.harvest_value, r.rows.reduce((a, x) => a + x.value, 0));
});
