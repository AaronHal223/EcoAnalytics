import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNet } from "./helpers.mjs";
import * as geo from "../public/js/geo.js";

test("ZIP prefix to state", () => {
  assert.equal(geo.stateFromZip("08031"), "NJ");
  assert.equal(geo.stateFromZip("90210"), "CA");
  assert.equal(geo.stateFromZip("10001"), "NY");
  assert.equal(geo.stateFromZip("abc"), null);
});

test("state names and codes normalise", () => {
  assert.equal(geo.toStateCode("New Jersey"), "NJ");
  assert.equal(geo.toStateCode("US-NJ"), "NJ");
  assert.equal(geo.toStateCode("nj"), "NJ");
});

test("offline fallback is marked imprecise", () => {
  const loc = geo.fallbackLocation("08031");
  assert.equal(loc.state, "NJ");
  assert.ok(loc.precision_km >= 100 && loc.needs_better_location);
});

test("home internet connection is trusted", async () => {
  fakeNet();
  const loc = await geo.locateByIP("America/New_York");
  assert.equal(loc.source, "ip");
  assert.equal(loc.vpn_suspected, false);
  assert.equal(loc.state, "NJ");
  assert.equal(loc.precision_km, geo.PRECISION_KM.ip);
});

test("VPN provider network is flagged and never trusted for soil", async () => {
  const net = fakeNet();
  net.geojs.organization_name = "Datacamp Limited";
  const loc = await geo.locateByIP("America/New_York");
  assert.ok(loc.vpn_suspected);
  assert.equal(loc.precision_km, geo.PRECISION_KM.fallback);
});

test("data-centre network is flagged", async () => {
  const net = fakeNet();
  net.geojs.organization_name = "DigitalOcean, LLC";
  const loc = await geo.locateByIP("America/New_York");
  assert.ok(loc.vpn_reasons.some(r => r.includes("data centre")));
});

test("timezone mismatch reveals a VPN", async () => {
  const net = fakeNet();
  Object.assign(net.geojs, { timezone: "Europe/Amsterdam", city: "Amsterdam", country_code: "NL" });
  const loc = await geo.locateByIP("America/New_York");
  assert.ok(loc.vpn_suspected);
  assert.ok(loc.vpn_reasons.some(r => r.includes("clock")));
});

test("falls back to the second IP service", async () => {
  const net = fakeNet();
  net.fail.add("geojs.io");
  const loc = await geo.locateByIP(null);
  assert.equal(loc.lat, 1);
  assert.ok(net.calls.some(c => c.url.includes("ipapi.co")));
});

test("ZIP and street address", async () => {
  fakeNet();
  const z = await geo.locateByZip("08031");
  assert.equal(z.source, "zip"); assert.equal(z.state, "NJ"); assert.equal(z.precision_km, 3);
  const a = await geo.locateByAddress("100 Main St, Bellmawr NJ");
  assert.equal(a.source, "address"); assert.ok(a.precision_km < 1);
  assert.equal(a.state, "NJ"); assert.equal(a.zip, "08031");
});

test("bad input is rejected", async () => {
  await assert.rejects(() => geo.locateByAddress("x"));
  await assert.rejects(() => geo.locateByZip("12"));
  assert.throws(() => geo.locateByDevice(200, 0));
});
