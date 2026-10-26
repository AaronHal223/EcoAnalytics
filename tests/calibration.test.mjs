import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNet, njAddress, openMeteoDaily, sdaTable } from "./helpers.mjs";
import * as climate from "../public/js/climate.js";
import * as soil from "../public/js/soil.js";
import * as eco from "../public/js/economics.js";
import * as cal from "../public/js/calibration.js";

const cl = climate.summarize(openMeteoDaily().daily, [2023, 2024, 2025]);
async function njSoil() { fakeNet(); return soil.researchSoil(njAddress()); }
const near = (a, b, tol = 0.02) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test("harvest entries are validated", () => {
  assert.equal(cal.makeEntry({ crop: "tomato", lb: "abc" }), null);
  assert.equal(cal.makeEntry({ crop: "tomato", lb: 0 }), null);
  assert.equal(cal.makeEntry({ crop: "tomato", lb: -3 }), null);
  assert.equal(cal.makeEntry({ crop: "tomato", lb: 99999 }), null);
  assert.equal(cal.makeEntry({ crop: "unicorn_fruit", lb: 2 }), null);
  const e = cal.makeEntry({ crop: "tomato", lb: "2.5", date: "2026-08-02" });
  assert.deepEqual({ crop: e.crop, lb: e.lb, date: e.date }, { crop: "tomato", lb: 2.5, date: "2026-08-02" });
  assert.match(cal.makeEntry({ crop: "tomato", lb: 1, date: "garbage" }).date, /^\d{4}-\d{2}-\d{2}$/);
});

test("logged pounds are summed per crop and year", () => {
  const log = [{ crop: "tomato", lb: 3, date: "2026-07-01" }, { crop: "tomato", lb: 4.5, date: "2026-08-01" },
    { crop: "tomato", lb: 9, date: "2025-08-01" }, { crop: "basil", lb: 1, date: "2026-08-01" }];
  assert.equal(cal.loggedLb(log, "tomato", 2026), 7.5);
  assert.equal(cal.loggedLb(log, "tomato", 2024), 0);
});

test("finishing a season measures actual against the uncalibrated prediction", async () => {
  const s = await njSoil();
  const plan = [{ crop: "tomato", sqft: 10 }, { crop: "tomato", sqft: 6 }];
  const predicted = cal.predictedLb(plan, "tomato", s, cl);
  assert.equal(cal.sqftOf(plan, "tomato"), 16);
  near(predicted, eco.baseYieldPerSqft(eco.CROP_BY_ID.tomato, s, cl) * 16, 0.1);
  const res = cal.finishSeason({}, { crop: "tomato", year: 2026, lb: predicted * 0.5, predicted, sqft: 16 });
  near(res.factor, 0.5, 0.01);
  assert.deepEqual(cal.factorsFromHistory(res.history), { tomato: res.factor });
  // predicted never includes calibration, so the ratio can't compound on itself
  assert.equal(cal.predictedLb(plan, "tomato", s, cl), predicted);
});

test("one freak season can't swing the numbers: factors are clamped and averaged over the last three", () => {
  let h = {};
  h = cal.finishSeason(h, { crop: "kale", year: 2023, lb: 1, predicted: 100, sqft: 10 }).history;        // 0.01 -> clamped
  assert.equal(cal.factorsFromHistory(h).kale, cal.MIN_FACTOR);
  h = cal.finishSeason(h, { crop: "kale", year: 2024, lb: 1000, predicted: 100, sqft: 10 }).history;     // 10 -> clamped
  h = cal.finishSeason(h, { crop: "kale", year: 2025, lb: 100, predicted: 100, sqft: 10 }).history;      // 1.0
  near(cal.factorsFromHistory(h).kale, (cal.MIN_FACTOR + cal.MAX_FACTOR + 1) / 3, 0.01);
  h = cal.finishSeason(h, { crop: "kale", year: 2026, lb: 100, predicted: 100, sqft: 10 }).history;      // oldest drops off
  assert.equal(h.kale.length, cal.SEASONS_KEPT);
  near(cal.factorsFromHistory(h).kale, (cal.MAX_FACTOR + 1 + 1) / 3, 0.01);
  // finishing the same year again replaces it, not duplicates it
  h = cal.finishSeason(h, { crop: "kale", year: 2026, lb: 50, predicted: 100, sqft: 10 }).history;
  assert.equal(h.kale.filter(x => x.year === 2026).length, 1);
});

test("finishing without data is refused with a plain message", () => {
  assert.match(cal.finishSeason({}, { crop: "tomato", year: 2026, lb: 0, predicted: 10, sqft: 4 }).error, /Log at least one/);
  assert.match(cal.finishSeason({}, { crop: "tomato", year: 2026, lb: 5, predicted: 0, sqft: 0 }).error, /plan/);
  assert.ok(cal.finishSeason({}, { crop: "nope", year: 2026, lb: 5, predicted: 10, sqft: 4 }).error);
  assert.deepEqual(cal.factorsFromHistory(undefined), {});
  assert.deepEqual(cal.factorsFromHistory({ ghost_crop: [{ year: 2026, factor: 2 }] }), {});
});

test("calibration flows into rankings and ROI, and a missing factor changes nothing", async () => {
  const s = await njSoil();
  const plan = [{ crop: "tomato", sqft: 16 }];
  const a = eco.gardenROI(plan, s, cl), b = eco.gardenROI(plan, s, cl, { yieldAdjust: { tomato: 0.5 } });
  near(b.harvest_lb, a.harvest_lb / 2, 0.1);
  assert.equal(b.rows[0].calibration, 0.5); assert.equal(a.rows[0].calibration, null);
  assert.deepEqual(eco.gardenROI(plan, s, cl, { yieldAdjust: {} }), a);
  const ra = eco.rankCrops(s, cl).find(x => x.id === "tomato"), rb = eco.rankCrops(s, cl, { yieldAdjust: { tomato: 0.5 } }).find(x => x.id === "tomato");
  assert.ok(rb.net_per_sqft < ra.net_per_sqft); assert.equal(rb.calibration, 0.5); assert.equal(ra.calibration, null);
});

test("CSV export escapes properly and sorts by date", () => {
  const csv = cal.toCSV([{ crop: "tomato", lb: 2, date: "2026-08-02" }, { crop: "snap_pea", lb: 1.25, date: "2026-06-01" }]);
  assert.equal(csv.split("\n")[0], "date,crop,pounds");
  assert.match(csv.split("\n")[1], /^2026-06-01,/);
  assert.match(cal.toCSV([{ crop: "mystery,crop", lb: 1, date: "2026-06-01" }]), /"mystery,crop"/);
});

test("labor: hours follow bed size and season, wage is optional, and defaults leave costs untouched", async () => {
  const s = await njSoil();
  const plan = [{ crop: "tomato", sqft: 50 }, { crop: "kale", sqft: 50 }];
  const free = eco.gardenROI(plan, s, cl);
  const { weeks, hours } = eco.laborHours(100, cl);
  assert.equal(free.labor.hours, hours); assert.equal(free.labor.weeks, weeks);
  assert.equal(free.costs.labor, 0);
  near(free.total_cost, Object.values(free.costs).reduce((x, y) => x + y, 0));
  const paid = eco.gardenROI(plan, s, cl, { hourlyWage: 15 });
  near(paid.costs.labor, hours * 15, 0.02);
  near(paid.total_cost - free.total_cost, hours * 15, 0.05);
  near(paid.total_cost, Object.values(paid.costs).reduce((x, y) => x + y, 0), 0.02);
  near(free.labor.per_hour, free.labor.net_before_labor / hours, 0.01);
  assert.equal(eco.gardenROI(plan, s, cl, { laborHrPer100Week: 0 }).labor.per_hour, null);   // no hours, no hourly figure
  assert.ok(eco.laborHours(100, { frost_free_days: 400 }).weeks <= 40 && eco.laborHours(100, { frost_free_days: 10 }).weeks >= 8);
});

test("corrupted saved calibration data is ignored, not fatal", () => {
  for (const bad of ["abc", 42, null, [], { tomato: "oops" }, { tomato: [null, 5, { factor: "x" }] }, { tomato: { year: 1 } }]) {
    assert.deepEqual(cal.factorsFromHistory(bad), {}, JSON.stringify(bad));
  }
  const res = cal.finishSeason({ tomato: "garbage" }, { crop: "tomato", year: 2026, lb: 5, predicted: 10, sqft: 4 });
  assert.equal(res.factor, 0.5);
  assert.equal(res.history.tomato.length, 1);
});
