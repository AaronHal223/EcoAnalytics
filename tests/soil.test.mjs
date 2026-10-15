import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNet, njAddress, sdaTable, soilgridsPayload } from "./helpers.mjs";
import * as soil from "../public/js/soil.js";

const near = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

test("SSURGO rows: depth and component weighting, nulls ignored", () => {
  const v = soil.parseSdaRows(sdaTable({ ph: 6.0, om: 3.0 }).Table);
  near(v.ph, 6.0 * 2 / 3 + 6.2 / 3);       // 0-20 cm at 6.0, 20-30 cm at 6.2
  near(v.organic_matter_pct, 3 * 2 / 3 + 1 / 3);
  near(v.clay_pct, 20);
});

test("SoilGrids unit conversion", () => {
  const v = soil.parseSoilgrids(soilgridsPayload());
  near(v.ph, 6.2); near(v.total_n_gkg, 2.1); near(v.clay_pct, 20); near(v.cec, 15);
  near(v.organic_matter_pct, 18 * 1.72 / 10);
});

for (const [s, si, c, want] of [
  [40, 40, 20, "loam"], [20, 65, 15, "silt loam"], [85, 10, 5, "loamy sand"], [95, 3, 2, "sand"],
  [20, 20, 60, "clay"], [65, 25, 10, "sandy loam"], [35, 30, 35, "clay loam"], [5, 55, 40, "silty clay"],
]) test(`texture triangle: ${s}/${si}/${c} is ${want}`, () => assert.equal(soil.textureClass(s, si, c), want));

test("sampling ring shrinks as location gets more precise", () => {
  const r = p => soil.ringRadiusKm({ precision_km: p });
  assert.ok(r(0.1) < r(3) && r(3) < r(15));
  const pts = soil.samplePoints(40, -75, 2);
  assert.equal(pts.length, 7); assert.equal(pts[0][2], 2);
});

test("survey ring averaged with high confidence", async () => {
  const net = fakeNet();
  const rep = await soil.researchSoil(njAddress());
  assert.equal(rep.points_with_data, 7);
  assert.equal(rep.values.ph.source, "ssurgo");
  assert.equal(rep.values.ph.confidence, "high");
  assert.equal(rep.values.ph.status, "low");     // 6.07 is under the 6.2 vegetable ideal
  assert.equal(rep.values.total_n_gkg.source, "soilgrids");
  assert.equal(rep.values.p_ppm.confidence, "low");
  assert.equal(rep.texture_class, "loam");
  // Form-encoded POST: a "simple" CORS request with no preflight.
  const post = net.calls.find(c => c.url.includes("sdmdataaccess"));
  assert.equal(post.init.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.match(post.init.body, /format=JSON%2BCOLUMNNAME/);
});

test("disagreeing points lower confidence and widen the range", async () => {
  const net = fakeNet();
  const phs = [5.0, 7.5, 5.2, 7.2, 5.5, 7.8, 6.0];
  let i = 0;
  globalThis.fetch = async (url) => ({ ok: true, json: async () =>
    String(url).includes("sdmdataaccess") ? sdaTable({ ph: phs[i++ % 7] }) : soilgridsPayload() });
  const rep = await soil.researchSoil(njAddress());
  assert.notEqual(rep.values.ph.confidence, "high");
  assert.ok(rep.values.ph.low < 5.5 && rep.values.ph.high > 7.5);
  void net;
});

test("soil test overrides estimates", async () => {
  fakeNet();
  const rep = await soil.researchSoil(njAddress(), { ph: 6.5, p_ppm: 80, k_ppm: 90 });
  assert.equal(rep.values.ph.value, 6.5); assert.equal(rep.values.ph.source, "soil_test");
  assert.equal(rep.values.p_ppm.status, "high"); assert.equal(rep.values.k_ppm.status, "low");
  assert.ok(rep.sources.includes("Your soil test"));
});

test("SoilGrids fills in where the survey has no data", async () => {
  const net = fakeNet();
  net.sda = { Table: [sdaTable().Table[0]] };  // header only, e.g. "Urban land"
  const rep = await soil.researchSoil(njAddress());
  assert.equal(rep.points_with_data, 0);
  assert.equal(rep.values.ph.source, "soilgrids");
});

test("everything down: regional averages, clearly labelled", async () => {
  const net = fakeNet();
  net.fail.add("sdmdataaccess"); net.fail.add("soilgrids");
  const rep = await soil.researchSoil(njAddress());
  assert.equal(rep.values.ph.source, "regional");
  assert.ok(rep.notes.some(n => n.includes("couldn't be reached")));
});

test("blocked cross-origin calls retry through the host's proxy routes", async () => {
  const net = fakeNet();
  net.fail.add("sdmdataaccess.sc.egov.usda.gov"); net.fail.add("rest.isric.org");
  globalThis.location = { protocol: "https:", search: "" };
  soil._resetModes();
  try {
    const rep = await soil.researchSoil(njAddress());
    assert.equal(rep.values.ph.source, "ssurgo");
    assert.equal(rep.values.total_n_gkg.source, "soilgrids");
    assert.ok(net.calls.some(c => c.url === "proxy/sda"));
    assert.ok(net.calls.some(c => c.url.startsWith("proxy/soilgrids/properties/query?")));
  } finally {
    delete globalThis.location;
    soil._resetModes();
  }
});
