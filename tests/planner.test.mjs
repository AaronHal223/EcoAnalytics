import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNet, njAddress, openMeteoDaily, sdaTable } from "./helpers.mjs";
import * as climate from "../public/js/climate.js";
import * as soil from "../public/js/soil.js";
import * as pl from "../public/js/planner.js";
import { CROPS } from "../public/js/data.js";

const cl = climate.summarize(openMeteoDaily().daily, [2023, 2024, 2025]);   // last frost day 105, first fall frost day 290
async function soilWith(opts) { const n = fakeNet(); n.sda = sdaTable(opts); return soil.researchSoil(njAddress()); }
const crop = id => CROPS.find(c => c.id === id);
const sow = w => w.find(x => x.kind === "sow");

test("frost days come through the climate summary and from old cached labels", () => {
  assert.equal(cl.last_spring_frost_doy, 105);
  assert.equal(cl.first_fall_frost_doy, 290);
  const old = { last_spring_frost: "Apr 15", first_fall_frost: "Oct 17" };   // a cache entry from before the doy fields existed
  assert.deepEqual(pl.frostDoys(old), { spring: 105, fall: 290, frostFree: false });
  assert.equal(pl.labelToDoy("nonsense"), null);
  assert.deepEqual(pl.frostDoys({ last_spring_frost: null, first_fall_frost: null }), { spring: 0, fall: 366, frostFree: true });
});

test("soil texture shifts spring planting: clay waits, sand goes early", async () => {
  const loam = await soilWith({ sand: 40, silt: 40, clay: 20 });
  const clay = await soilWith({ sand: 15, silt: 25, clay: 60 });
  const sand = await soilWith({ sand: 85, silt: 10, clay: 5 });
  assert.equal(loam.texture_class, "loam"); assert.equal(clay.texture_class, "clay"); assert.equal(sand.texture_class, "loamy sand");
  const t = crop("tomato");
  const base = sow(pl.cropWindows(t, loam, cl).windows).start;
  assert.equal(base, 105 + 14);                                              // last frost + tender buffer
  assert.equal(sow(pl.cropWindows(t, clay, cl).windows).start, base + 7);
  assert.equal(sow(pl.cropWindows(t, sand, cl).windows).start, base - 4);
  assert.match(pl.cropWindows(t, clay, cl).shift.why, /cold and wet/);
});

test("every window is a valid range and warm crops finish before the first fall frost", async () => {
  const s = await soilWith({});
  for (const c of CROPS) {
    const { windows } = pl.cropWindows(c, s, cl);
    assert.ok(windows.length >= 2, c.id);
    for (const w of windows) { assert.ok(w.start >= 1 && w.end <= 365 && w.start <= w.end, `${c.id} ${w.kind} ${w.start}-${w.end}`); }
    if (c.season === "warm") for (const w of windows.filter(x => x.kind === "harvest")) assert.ok(w.end <= 290, c.id);
  }
});

test("cool crops get spring and fall plantings; onions and potatoes are spring only; garlic goes in the fall", async () => {
  const s = await soilWith({});
  const kinds = id => pl.cropWindows(crop(id), s, cl).windows.filter(w => w.kind === "sow").map(w => w.season);
  assert.deepEqual(kinds("lettuce"), ["spring", "fall"]);
  assert.deepEqual(kinds("onion"), ["spring"]);
  assert.deepEqual(kinds("potato"), ["spring"]);
  const garlic = pl.cropWindows(crop("garlic"), s, cl).windows;
  assert.deepEqual(garlic.filter(w => w.kind === "sow").map(w => w.season), ["fall"]);
  assert.equal(garlic.find(w => w.kind === "harvest").nextYear, true);
});

test("a too-short season is flagged instead of promising a crop", async () => {
  const s = await soilWith({});
  const short = { ...cl, last_spring_frost_doy: 150, first_fall_frost_doy: 240, last_spring_frost: "May 30", first_fall_frost: "Aug 28", frost_free_days: 90, season_gdd50: 900 };
  const { notes, windows } = pl.cropWindows(crop("sweet_corn"), s, short);
  assert.ok(notes.some(n => /short/.test(n)));
  assert.ok(windows.every(w => w.start <= w.end));
});

test("acid soil is called out for crops that need a higher pH", async () => {
  const acid = await soilWith({ ph: 4.8 });
  const shown = acid.values.ph.value.toFixed(1);
  assert.ok(pl.cropWindows(crop("tomato"), acid, cl).notes.some(n => n.includes(`pH ${shown}`) && /adjust pH first/.test(n)));
  const fine = await soilWith({ ph: 6.4 });
  assert.ok(!pl.cropWindows(crop("tomato"), fine, cl).notes.some(n => /pH/.test(n)));
});

test("what to do today: plant now, harvest now, coming up, later", async () => {
  const s = await soilWith({});
  const w = pl.cropWindows(crop("tomato"), s, cl).windows;
  const st = sow(w).start;
  assert.equal(pl.nowStatus(w, st + 3).action, "sow");
  assert.equal(pl.nowStatus(w, st - 10).action, "soon");
  assert.equal(pl.nowStatus(w, 5).action, "later");
  assert.match(pl.nowStatus(w, 5).text, /^Next planting [A-Z][a-z]{2} \d+$/);
  const h = w.find(x => x.kind === "harvest");
  assert.equal(pl.nowStatus(w, h.start + 2).action, "harvest");
  assert.equal(pl.nowStatus(w, 360).action, "later");   // after this year's windows, points at next spring
});

test("calendar lists every crop, plan first, and survives a frost-free climate", async () => {
  const s = await soilWith({});
  const c = pl.plantingCalendar({ plan: [{ crop: "kale", sqft: 8 }, { crop: "basil", sqft: 0 }], soil: s, cl, today: 120 });
  assert.equal(c.crops.length, CROPS.length);
  assert.equal(c.crops[0].id, "kale"); assert.equal(c.crops[0].inPlan, true);
  assert.equal(c.crops.find(x => x.id === "basil").inPlan, false);          // zero sq ft is not in the plan
  assert.match(pl.describeWindows(c.crops[0]), /^Kale: plant /);
  const tropic = { ...cl, last_spring_frost: null, first_fall_frost: null, last_spring_frost_doy: null, first_fall_frost_doy: null };
  const t = pl.plantingCalendar({ plan: [], soil: s, cl: tropic, today: 200 });
  assert.equal(t.frost.frostFree, true);
  for (const x of t.crops) for (const w of x.windows) assert.ok(w.start >= 1 && w.end <= 365 && w.start <= w.end, x.id);
});

test("day-of-year helpers", () => {
  assert.equal(pl.doyOfDate(new Date(Date.UTC(2026, 0, 1))), 1);
  assert.equal(pl.doyOfDate(new Date(Date.UTC(2026, 3, 15))), 105);
  assert.equal(pl.dayLabel(105), "Apr 15");
  assert.equal(pl.dayLabel(366), "Jan 1");   // wraps into next year
});
