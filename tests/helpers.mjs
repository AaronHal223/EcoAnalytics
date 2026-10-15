// Shared test helpers: canned responses shaped exactly like each real
// service, routed by URL through a fake `fetch`, so tests never hit the network.
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Load the vendored LP solver the same way the browser does (it sets window.solver).
globalThis.window = globalThis;
if (!globalThis.solver) vm.runInThisContext(fs.readFileSync(path.join(ROOT, "public/vendor/lp-solver.js"), "utf8"));

const SDA_HEADER = ["comppct_r", "compname", "hzdept_r", "hzdepb_r", "ph1to1h2o_r", "om_r",
  "cec7_r", "sandtotal_r", "silttotal_r", "claytotal_r"];

/** One map unit, two components (85% / 15%); the minor one is "Urban land" with no data. */
export function sdaTable({ ph = 6.0, om = 3.0, cec = 12, sand = 40, silt = 40, clay = 20 } = {}) {
  return { Table: [
    SDA_HEADER,
    ["85", "Downer", "0", "20", String(ph), String(om), String(cec), String(sand), String(silt), String(clay)],
    ["85", "Downer", "20", "50", String(ph + 0.2), String(om / 3), String(cec), String(sand), String(silt), String(clay)],
    ["15", "Urban land", "0", "200", null, null, null, null, null, null],
  ] };
}

export function soilgridsPayload({ ph10 = 62, soc = 180, nitrogen = 210, clay = 200, sand = 400, silt = 400, cec = 150 } = {}) {
  const layer = (name, d, mean) => ({ name, unit_measure: { d_factor: d },
    depths: ["0-5cm", "5-15cm", "15-30cm"].map(label => ({ label, values: { mean } })) });
  return { type: "Feature", properties: { layers: [
    layer("phh2o", 10, ph10), layer("soc", 10, soc), layer("nitrogen", 100, nitrogen),
    layer("clay", 10, clay), layer("sand", 10, sand), layer("silt", 10, silt), layer("cec", 10, cec)] } };
}

/** Three synthetic years: last spring frost on day 105 (Apr 15), first fall frost on day 290. */
export function openMeteoDaily(years = [2023, 2024, 2025], spring = 105, fall = 290) {
  const time = [], tmax = [], tmin = [], pr = [], et = [];
  for (const y of years) {
    const days = y % 4 === 0 ? 366 : 365;
    for (let doy = 1; doy <= days; doy++) {
      const d = new Date(Date.UTC(y, 0, doy));
      const season = Math.cos(2 * Math.PI * (doy - 200) / 365);
      let lo = 44 + 22 * season;
      if (doy === spring || doy === fall) lo = 30;
      else if (doy > spring && doy < fall) lo = Math.max(lo, 36);
      else lo = Math.min(lo, 31);
      time.push(d.toISOString().slice(0, 10)); tmax.push(62 + 24 * season); tmin.push(lo);
      pr.push(2.8); et.push(Math.max(0.4, 3 + 2.5 * season));
    }
  }
  return { daily: { time, temperature_2m_max: tmax, temperature_2m_min: tmin, precipitation_sum: pr, et0_fao_evapotranspiration: et } };
}

/** Installs a fake fetch. Returns mutable state so tests can change responses. */
export function fakeNet() {
  const state = {
    sda: sdaTable(), soilgrids: soilgridsPayload(), calls: [], fail: new Set(),
    geojs: { ip: "73.1.2.3", latitude: "39.867", longitude: "-75.094", timezone: "America/New_York",
      city: "Bellmawr", region: "New Jersey", country_code: "US", organization_name: "Comcast Cable Communications, LLC" },
  };
  const reply = body => ({ ok: true, status: 200, json: async () => body });
  globalThis.ECO_OFFLINE = false;
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    state.calls.push({ url, init });
    for (const f of state.fail) if (url.includes(f)) throw new TypeError("Failed to fetch");
    if (url.includes("geojs.io")) return reply(state.geojs);
    if (url.includes("ipapi.co")) return reply({ latitude: 1, longitude: 1 });
    if (url.includes("zippopotam")) return reply({ "post code": "08031", places: [{ "place name": "Bellmawr", "state abbreviation": "NJ", latitude: "39.8673", longitude: "-75.0946" }] });
    if (url.includes("nominatim")) return reply([{ lat: "39.8661", lon: "-75.0941", addresstype: "building",
      display_name: "100, Main Street, Bellmawr, Camden County, New Jersey, 08031, United States",
      address: { house_number: "100", postcode: "08031", state: "New Jersey", "ISO3166-2-lvl4": "US-NJ" } }]);
    if (url.includes("sdmdataaccess") || url.startsWith("proxy/sda")) return reply(state.sda);
    if (url.includes("soilgrids")) return reply(state.soilgrids);  // also matches proxy/soilgrids
    if (url.includes("open-meteo")) return reply(openMeteoDaily());
    throw new Error("unexpected fetch " + url);
  };
  return state;
}

export const njAddress = () => ({ lat: 39.8661, lon: -75.0941, source: "address", precision_km: 0.1,
  label: "100 Main St, Bellmawr, NJ", zip: "08031", state: "NJ", timezone: null,
  vpn_suspected: false, vpn_reasons: [], needs_better_location: false });
