// Sun hours, good-year/bad-year risk, Plan it for me, crop guide, sharing, reminders and backup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNet, njAddress, openMeteoDaily } from "./helpers.mjs";
import * as climate from "../public/js/climate.js";
import * as soilMod from "../public/js/soil.js";
import * as eco from "../public/js/economics.js";
import * as sun from "../public/js/sun.js";
import * as risk from "../public/js/risk.js";
import * as guide from "../public/js/guide.js";
import * as share from "../public/js/share.js";
import { plantingCalendar } from "../public/js/planner.js";
import { predictedLb } from "../public/js/calibration.js";
import { explain } from "../public/js/provenance.js";
import { CROPS } from "../public/js/data.js";

const cl = climate.summarize(openMeteoDaily().daily, [2023, 2024, 2025]);
async function njSoil() { fakeNet(); return soilMod.researchSoil(njAddress()); }

// ---- Sun ---------------------------------------------------------------------------------------
test("sun position: solar noon on the June solstice at 40N is due south, about 73 degrees up", () => {
  const p = sun.solarPosition(40, 172, 12);
  assert.ok(Math.abs(p.elevation - 73.4) < 0.5, p.elevation);
  assert.ok(Math.abs(p.azimuth - 180) < 0.5, p.azimuth);
  const am = sun.solarPosition(40, 172, 8);
  assert.ok(am.azimuth > 60 && am.azimuth < 110, "morning sun is in the east");
  const south = sun.solarPosition(-35, 355, 12);
  assert.ok(south.azimuth < 5 || south.azimuth > 355, "southern hemisphere noon sun is due north");
});

test("open sky gets the most sun; obstacles take hours away in order", () => {
  const open = sun.sunHours(40, null).hours;
  const fence = sun.sunHours(40, sun.skylineFromEstimate({ E: "low", SE: "low", S: "low", SW: "low", W: "low" }, 40)).hours;
  const trees = sun.sunHours(40, sun.skylineFromEstimate({ E: "high", SE: "high", S: "high", SW: "high", W: "high" }, 40)).hours;
  assert.ok(open > 11 && open < 14, `open ${open}`);
  assert.ok(open > fence && fence > trees, `${open} > ${fence} > ${trees}`);
  // A tall tree only to the west costs afternoon sun, less than trees all round.
  const west = sun.sunHours(40, sun.skylineFromEstimate({ W: "high", SW: "high" }, 40)).hours;
  assert.ok(west < open && west > trees);
});

test("sun factor: fruiting crops lose most in shade, leafy greens least, never above 1", () => {
  assert.equal(sun.sunFactor("tomato", 10), 1);
  assert.equal(sun.sunFactor("tomato", null), 1);
  assert.ok(sun.sunFactor("tomato", 4) < sun.sunFactor("lettuce", 4));
  assert.equal(sun.sunFactor("lettuce", 4), 1);
  assert.ok(sun.sunFactor("pepper", 0) >= 0.05);
  for (const c of CROPS) assert.ok(sun.SUN_NEED[c.id], `no sun need for ${c.id}`);
});

test("camera direction from device angles", () => {
  assert.deepEqual(sun.cameraDirection(0, 90, 0), { heading: 0, elevation: 0 });          // upright, facing north
  const w = sun.cameraDirection(90, 120, 0);                                               // turned west, tilted up 30
  assert.equal(w.heading, 270); assert.equal(w.elevation, 30);
  const e = sun.cameraDirection(270, 90, 0);
  assert.equal(e.heading, 90);
});

test("scan samples become a skyline; a narrow sweep is rejected", () => {
  const samples = [];
  for (let h = 80; h <= 280; h += 1) samples.push({ heading: h, elevation: h < 180 ? 30 : 5 });
  const sky = sun.skylineFromSamples(samples);
  assert.ok(sky && sky.covered > 0.5);
  assert.ok(sky.skyline[sun.binOf(120)] > 25 && sky.skyline[sun.binOf(240)] < 10);
  assert.equal(sun.skylineFromSamples(samples.slice(0, 20)), null);
  assert.equal(sun.skylineFromSamples([{ heading: NaN, elevation: 3 }]), null);
});

test("bed sun reaches yields, rankings and the calibration baseline", async () => {
  const soil = await njSoil();
  const full = eco.gardenROI([{ crop: "tomato", sqft: 16 }], soil, cl);
  const shady = eco.gardenROI([{ crop: "tomato", sqft: 16, sun: 4 }], soil, cl);
  assert.ok(shady.harvest_value < full.harvest_value * 0.5);
  assert.equal(shady.rows[0].sun_fit, sun.sunFactor("tomato", 4));
  const rankShade = eco.rankCrops(soil, cl, { sunHours: 4 });
  const pos = id => rankShade.findIndex(r => r.id === id);
  assert.ok(pos("lettuce") < pos("pepper"), "greens beat peppers in shade");
  assert.ok(predictedLb([{ crop: "tomato", sqft: 16, sun: 4 }], "tomato", soil, cl) < predictedLb([{ crop: "tomato", sqft: 16 }], "tomato", soil, cl));
});

// ---- Risk -----------------------------------------------------------------------------------------
function historyDaily() {
  // Five past years; the middle one has a late spring frost and an early fall one (a bad year).
  const parts = [[2020, 105, 290], [2021, 105, 290], [2022, 150, 240], [2023, 105, 290], [2024, 100, 300]]
    .map(([y, sp, fa]) => openMeteoDaily([y], sp, fa).daily);
  const keys = Object.keys(parts[0]);
  return Object.fromEntries(keys.map(k => [k, parts.flatMap(p => p[k])]));
}

test("past seasons are summarised one year at a time", () => {
  const cls = risk.perYearClimates(historyDaily(), [2020, 2021, 2022, 2023, 2024, 2025]);
  assert.equal(cls.length, 5);
  const bad = cls.find(c => c.year === 2022), good = cls.find(c => c.year === 2024);
  assert.ok(bad.frost_free_days < good.frost_free_days);
});

test("crop and plan risk: the short season shows up as the bad year", async () => {
  const soil = await njSoil();
  const cls = risk.perYearClimates(historyDaily(), [2020, 2021, 2022, 2023, 2024]);
  const k = risk.cropRisk(soil, cls);
  assert.ok(k.tomato.bad <= k.tomato.typical && k.tomato.typical <= k.tomato.good);
  assert.equal(k.tomato.n, 5);
  const pr = risk.planRisk([{ crop: "tomato", sqft: 16 }, { crop: "lettuce", sqft: 8 }], soil, cls);
  assert.equal(pr.years.length, 5);
  assert.equal(pr.worst_year, 2022);
  assert.ok(pr.positive >= 0 && pr.positive <= 5);
  assert.equal(risk.percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(risk.percentile([10, 20], 0.1), 11);
});

test("history download: one request, years before this one", async () => {
  const net = fakeNet();
  const urls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (u, i) => { urls.push(String(u)); if (String(u).includes("archive-api")) return new Response(JSON.stringify({ daily: historyDaily() })); return real(u, i); };
  try {
    const h = await risk.getHistory(40.1, -74.5, new Date("2025-06-01"), 5);
    assert.equal(h.climates.length, 5);
    assert.match(urls[0], /start_date=2020-01-01/); assert.match(urls[0], /end_date=2024-12-31/);
    assert.match(h.source, /2020-2024/);
  } finally { globalThis.fetch = real; void net; }
});

test("Plan it for me fills the space exactly, spreads risk and respects sun", async () => {
  const soil = await njSoil();
  const ranking = eco.rankCrops(soil, cl);
  const plan = risk.autoPlan({ area: 40, ranking });
  assert.equal(plan.reduce((a, p) => a + p.sqft, 0), 40);
  assert.ok(plan.length >= 4, "at least four crops");
  assert.ok(plan.every(p => p.sqft <= 10 && Number.isInteger(p.sqft)));
  const shade = risk.autoPlan({ area: 20, ranking: eco.rankCrops(soil, cl, { sunHours: 4 }), sunHours: 4 });
  assert.ok(shade.every(p => p.sun === 4));
  assert.ok(shade.some(p => ["lettuce", "spinach", "kale", "chard"].includes(p.crop)));
  assert.deepEqual(risk.autoPlan({ area: 0, ranking }), []);
  const tiny = risk.autoPlan({ area: 10, ranking: ranking.slice(0, 1) });
  assert.equal(tiny.reduce((a, p) => a + p.sqft, 0), 10);
});

// ---- Guide ------------------------------------------------------------------------------------------
test("every crop has a complete guide, and companion ids are real crops", () => {
  const ids = new Set(CROPS.map(c => c.id));
  for (const c of CROPS) {
    const g = guide.GUIDE[c.id];
    assert.ok(g, `no guide for ${c.id}`);
    for (const k of ["spacing", "ready", "store", "water"]) assert.ok(g[k]?.length > 5, `${c.id}.${k}`);
    assert.ok(g.pests.length >= 2 && g.pests.every(p => p.length === 3), `${c.id} pests`);
    for (const f of [...g.friends, ...g.avoid]) assert.ok(ids.has(f), `${c.id} lists unknown ${f}`);
    assert.ok(!g.friends.some(f => g.avoid.includes(f)), `${c.id} is both friend and foe`);
  }
});

test("companion check flags tomatoes next to potatoes and praises tomatoes with basil", () => {
  const c = guide.companionCheck([{ crop: "tomato", sqft: 8 }, { crop: "potato", sqft: 8 }, { crop: "basil", sqft: 4 }]);
  assert.ok(c.bad.some(x => /blight/.test(x.text)));
  assert.ok(c.good.some(x => x.a === "basil" || x.b === "basil"));
  assert.deepEqual(guide.companionCheck([{ crop: "tomato", sqft: 0 }, { crop: "potato", sqft: 8 }]).bad, []);
});

test("problem solver adds notes about this yard's soil", async () => {
  const soil = await njSoil();
  const acid = { ...soil, values: { ...soil.values, ph: { ...soil.values.ph, value: 5.5 } } };
  const ber = guide.problemsFor(acid).find(p => p.id === "ber");
  assert.match(ber.soil_note, /5\.5/);
  assert.ok(guide.problemsFor(null).every(p => p.soil_note === null));
  assert.ok(guide.PROBLEMS.length >= 10);
});

// ---- Share, reminders, backup ----------------------------------------------------------------------------
test("plan links round-trip, and junk is rejected", () => {
  const plan = [{ crop: "tomato", sqft: 16, sun: 6.5 }, { crop: "lettuce", sqft: 8 }];
  const text = share.encodePlan(plan);
  assert.match(text, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(share.decodePlan(text), plan);
  assert.deepEqual(share.planFromHash(`#plan=${text}`), plan);
  assert.equal(share.decodePlan("not-a-plan"), null);
  const evil = Buffer.from(JSON.stringify({ v: 1, p: [["<script>", 5], ["tomato", -3], ["kale", 1e9], ["kale", 4, null]] })).toString("base64url");
  assert.deepEqual(share.decodePlan(evil), [{ crop: "kale", sqft: 4 }]);
  assert.equal(share.planFromHash("#other=1"), null);
});

test("calendar file has one event per window of the plan's crops, with reminders", async () => {
  const soil = await njSoil();
  const cal = plantingCalendar({ plan: [{ crop: "tomato", sqft: 8 }, { crop: "lettuce", sqft: 4 }], soil, cl, today: 200 });
  const ics = share.buildICS(cal, new Date("2026-07-19T12:00:00Z"));
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
  const n = cal.crops.filter(c => c.inPlan).reduce((a, c) => a + c.windows.length, 0);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, n);
  assert.equal((ics.match(/BEGIN:VALARM/g) || []).length, n);
  assert.match(ics, /SUMMARY:Plant tomatoes/);
  // Past windows roll to next year; nothing is dated before today.
  for (const m of ics.matchAll(/DTEND;VALUE=DATE:(\d{8})/g)) assert.ok(m[1] > "20260719", m[1]);
});

test("backup keeps the user's own data, skips caches, and restore validates", () => {
  const data = { "eco:plan": JSON.stringify([{ crop: "kale", sqft: 4 }]), "eco:harvests": "[]", "eco:research:v1:1,2": "{}", "eco:forecast:1,2": "{}", "eco:history:1,2": "{}", "other": "1" };
  const storage = { get length() { return Object.keys(data).length; }, key: i => Object.keys(data)[i], getItem: k => data[k] };
  const text = share.makeBackup(storage, new Date("2026-01-01"));
  const back = share.readBackup(text);
  assert.deepEqual(Object.keys(back).sort(), ["eco:harvests", "eco:plan"]);
  assert.throws(() => share.readBackup("{}"), /isn't an EcoAnalytics backup/);
  assert.throws(() => share.readBackup("nope"), /isn't an EcoAnalytics backup/);
  assert.throws(() => share.readBackup(JSON.stringify({ app: "ecoanalytics", data: { "eco:plan": "not json", "x": "1" } })), /nothing to restore/);
});

test("explanations cover sun and good-year/bad-year", async () => {
  const soil = await njSoil();
  const plan = [{ crop: "tomato", sqft: 16, sun: 5 }];
  const cls = risk.perYearClimates(historyDaily(), [2020, 2021, 2022, 2023, 2024]);
  const d = { soil, climate: cl, settings: { sunHours: 5 }, ranking: eco.rankCrops(soil, cl, { sunHours: 5 }), roi: eco.gardenROI(plan, soil, cl),
    risk: risk.cropRisk(soil, cls), planRisk: risk.planRisk(plan, soil, cls), historySource: "test", emptyPlan: false };
  const crop = explain("crop:tomato", d);
  assert.ok(crop.steps.some(s => /5 hours/.test(s ?? "")));
  assert.ok(crop.steps.some(s => /past seasons/.test(s ?? "")));
  const r = explain("risk:plan", d);
  assert.match(r.summary, /of 5 past seasons/);
  assert.ok(explain("roi:value", d).steps.some(s => /h of sun/.test(s)));
});
