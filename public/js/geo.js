// Where is the garden?
//
// Everything else (soil, rainfall, season length, water cost) hangs off a
// latitude/longitude, so this works out the best point it can and how
// *precise* it is. All lookups run from the browser, so every source here is
// HTTPS and allows cross-origin requests.
//
//   Device GPS (browser, user-approved)            ~0.1 km
//   Street address  -> OpenStreetMap Nominatim     ~0.1 km
//   ZIP code        -> Zippopotam.us centroid      ~3 km
//   IP address      -> GeoJS (ipapi.co backup)     ~15 km
//   ZIP prefix      -> state population centre     ~150 km (offline)
//
// IP location needs nothing from the user but a VPN breaks it. `detectVPN`
// combines independent signals so the page knows when to stop trusting it:
//   * the network belongs to a VPN brand or a hosting/cloud company
//     (home internet is never hosted in a data centre),
//   * the device clock's timezone disagrees with the IP's timezone
//     (a VPN moves the IP, not the laptop's clock),
//   * the IP is outside the US.

import { getJSON, SourceUnavailable } from "./net.js";

export const PRECISION_KM = { device: 0.1, address: 0.1, zip: 3, ip: 15, fallback: 150 };

export function makeLocation(o) {
  return {
    lat: o.lat, lon: o.lon, source: o.source, precision_km: o.precision_km ?? PRECISION_KM[o.source],
    label: o.label || "", zip: o.zip ?? null, state: o.state ?? null, timezone: o.timezone ?? null,
    vpn_suspected: !!o.vpn_suspected, vpn_reasons: o.vpn_reasons || [],
    needs_better_location: !!o.needs_better_location,
  };
}

// ---- Offline fallback: ZIP prefix -> state -> population centre ------------
const ZIP3 = [
  [5, 5, "NY"], [10, 27, "MA"], [28, 29, "RI"], [30, 38, "NH"], [39, 49, "ME"], [50, 54, "VT"],
  [55, 55, "MA"], [56, 59, "VT"], [60, 69, "CT"], [70, 89, "NJ"], [100, 149, "NY"], [150, 196, "PA"],
  [197, 199, "DE"], [200, 205, "DC"], [206, 219, "MD"], [220, 246, "VA"], [247, 268, "WV"],
  [270, 289, "NC"], [290, 299, "SC"], [300, 319, "GA"], [320, 349, "FL"], [350, 369, "AL"],
  [370, 385, "TN"], [386, 397, "MS"], [398, 399, "GA"], [400, 427, "KY"], [430, 458, "OH"],
  [460, 479, "IN"], [480, 499, "MI"], [500, 528, "IA"], [530, 549, "WI"], [550, 567, "MN"],
  [569, 569, "DC"], [570, 577, "SD"], [580, 588, "ND"], [590, 599, "MT"], [600, 629, "IL"],
  [630, 658, "MO"], [660, 679, "KS"], [680, 693, "NE"], [700, 714, "LA"], [716, 729, "AR"],
  [730, 732, "OK"], [733, 733, "TX"], [734, 749, "OK"], [750, 799, "TX"], [800, 816, "CO"],
  [820, 831, "WY"], [832, 838, "ID"], [840, 847, "UT"], [850, 865, "AZ"], [870, 884, "NM"],
  [885, 885, "TX"], [889, 898, "NV"], [900, 961, "CA"], [967, 968, "HI"], [970, 979, "OR"],
  [980, 994, "WA"], [995, 999, "AK"],
];

export const STATE_CENTERS = {
  AL: [33.0, -86.8, "Alabama"], AK: [61.4, -149.5, "Alaska"], AZ: [33.4, -111.9, "Arizona"],
  AR: [34.9, -92.4, "Arkansas"], CA: [35.5, -119.4, "California"], CO: [39.6, -105.0, "Colorado"],
  CT: [41.6, -72.9, "Connecticut"], DE: [39.4, -75.6, "Delaware"], DC: [38.9, -77.0, "District of Columbia"],
  FL: [27.8, -81.6, "Florida"], GA: [33.6, -84.2, "Georgia"], HI: [21.4, -157.9, "Hawaii"],
  ID: [43.7, -115.7, "Idaho"], IL: [41.3, -88.4, "Illinois"], IN: [39.9, -86.3, "Indiana"],
  IA: [41.9, -93.0, "Iowa"], KS: [38.5, -96.8, "Kansas"], KY: [37.8, -85.3, "Kentucky"],
  LA: [30.7, -91.3, "Louisiana"], ME: [44.3, -69.8, "Maine"], MD: [39.1, -76.8, "Maryland"],
  MA: [42.3, -71.4, "Massachusetts"], MI: [42.9, -84.2, "Michigan"], MN: [45.2, -93.6, "Minnesota"],
  MS: [32.6, -89.6, "Mississippi"], MO: [38.4, -92.2, "Missouri"], MT: [46.7, -111.0, "Montana"],
  NE: [41.2, -97.4, "Nebraska"], NV: [36.6, -115.6, "Nevada"], NH: [43.0, -71.5, "New Hampshire"],
  NJ: [40.4, -74.4, "New Jersey"], NM: [34.6, -106.4, "New Mexico"], NY: [41.5, -74.6, "New York"],
  NC: [35.6, -79.6, "North Carolina"], ND: [47.4, -99.0, "North Dakota"], OH: [40.5, -82.7, "Ohio"],
  OK: [35.6, -97.0, "Oklahoma"], OR: [44.7, -122.6, "Oregon"], PA: [40.5, -77.0, "Pennsylvania"],
  RI: [41.8, -71.4, "Rhode Island"], SC: [34.0, -81.0, "South Carolina"], SD: [44.0, -97.8, "South Dakota"],
  TN: [35.8, -86.4, "Tennessee"], TX: [31.0, -97.4, "Texas"], UT: [40.4, -111.9, "Utah"],
  VT: [44.1, -72.8, "Vermont"], VA: [38.0, -77.8, "Virginia"], WA: [47.3, -121.6, "Washington"],
  WV: [38.8, -80.9, "West Virginia"], WI: [43.7, -89.0, "Wisconsin"], WY: [42.4, -106.8, "Wyoming"],
};

const STATE_BY_NAME = Object.fromEntries(Object.entries(STATE_CENTERS).map(([k, v]) => [v[2].toLowerCase(), k]));

export function stateFromZip(zip) {
  const z = String(zip || "").trim().slice(0, 5);
  if (!/^\d{5}$/.test(z)) return null;
  const p = +z.slice(0, 3);
  for (const [lo, hi, st] of ZIP3) if (p >= lo && p <= hi) return st;
  return null;
}

export function toStateCode(s) {
  if (!s) return null;
  const t = String(s).trim();
  if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase();
  if (/^US-[A-Z]{2}$/.test(t)) return t.slice(3);
  return STATE_BY_NAME[t.toLowerCase()] || null;
}

export function fallbackLocation(zip = null, state = null) {
  const st = state || (zip ? stateFromZip(zip) : null) || "PA";
  const [lat, lon, name] = STATE_CENTERS[st] || STATE_CENTERS.PA;
  return makeLocation({ lat, lon, source: "fallback", label: `${name} (approximate, offline)`,
    zip, state: st, needs_better_location: true });
}

// ---- IP + VPN detection ------------------------------------------------------
const VPN_WORDS = /\b(vpn|proxy|tor\b|nord|express ?vpn|surfshark|mullvad|proton|private internet access|cyberghost|ipvanish|windscribe|hide\.?me|purevpn|tunnelbear|datacamp|m247|cdn77)\b/i;
const HOSTING_WORDS = /\b(amazon|aws|google cloud|google llc|microsoft|azure|digitalocean|linode|akamai|vultr|choopa|ovh|hetzner|leaseweb|contabo|oracle|cloudflare|hosting|host|datacenter|data center|server|colo|colocation|scaleway|ionos|godaddy|hostinger|packet|equinix|zenlayer)\b/i;

export function detectVPN(info, browserTimezone) {
  const reasons = [];
  const org = info.org || "";
  if (VPN_WORDS.test(org)) reasons.push(`Your connection is routed through ${org}, a VPN or proxy provider.`);
  else if (HOSTING_WORDS.test(org)) reasons.push(`Your connection comes from ${org}, a data centre, not a home internet provider.`);
  if (browserTimezone && info.timezone && browserTimezone !== info.timezone) {
    reasons.push(`Your device clock is set to ${browserTimezone}, but the connection looks like it's in ${info.timezone}.`);
  }
  if (info.country && info.country !== "US") {
    reasons.push("The connection is outside the US; soil and price data here are US-only.");
  }
  return reasons;
}

async function ipLookup() {
  try {
    const g = await getJSON("https://get.geojs.io/v1/ip/geo.json");
    return { lat: +g.latitude, lon: +g.longitude, timezone: g.timezone, city: g.city,
      region: g.region, country: g.country_code, org: g.organization_name || g.organization || "", zip: null };
  } catch (e) {
    if (!(e instanceof SourceUnavailable)) throw e;
  }
  const a = await getJSON("https://ipapi.co/json/");
  if (a.error) throw new SourceUnavailable(a.reason || "ipapi error");
  return { lat: +a.latitude, lon: +a.longitude, timezone: a.timezone, city: a.city,
    region: a.region_code || a.region, country: a.country_code, org: a.org || "", zip: a.postal || null };
}

export async function locateByIP(browserTimezone) {
  let info;
  try {
    info = await ipLookup();
  } catch {
    return fallbackLocation();
  }
  if (!Number.isFinite(info.lat) || !Number.isFinite(info.lon)) return fallbackLocation();
  const reasons = detectVPN(info, browserTimezone);
  return makeLocation({
    lat: info.lat, lon: info.lon, source: "ip",
    // Never build a soil profile on a VPN server's city.
    precision_km: reasons.length ? PRECISION_KM.fallback : PRECISION_KM.ip,
    label: [info.city, info.region].filter(Boolean).join(", "),
    zip: info.zip, state: toStateCode(info.region), timezone: info.timezone,
    vpn_suspected: reasons.length > 0, vpn_reasons: reasons,
    needs_better_location: true,  // IP is never better than ~15 km
  });
}

// ---- User-supplied refinements ---------------------------------------------
export async function locateByZip(zip) {
  const z = String(zip || "").trim().slice(0, 5);
  if (!/^\d{5}$/.test(z)) throw new Error("ZIP code must be 5 digits.");
  try {
    const d = await getJSON(`https://api.zippopotam.us/us/${z}`);
    const p = d.places[0];
    return makeLocation({ lat: +p.latitude, lon: +p.longitude, source: "zip",
      label: `${p["place name"]}, ${p["state abbreviation"]} ${z}`, zip: z, state: p["state abbreviation"] });
  } catch {
    return fallbackLocation(z);
  }
}

export async function locateByAddress(address) {
  const q = String(address || "").trim();
  if (q.length < 6) throw new Error("Enter a street address with city and state, or a ZIP code.");
  let hits = [];
  try {
    hits = await getJSON("https://nominatim.openstreetmap.org/search",
      { q, format: "jsonv2", countrycodes: "us", limit: "1", addressdetails: "1" });
  } catch { hits = []; }
  if (Array.isArray(hits) && hits.length) {
    const h = hits[0];
    const a = h.address || {};
    const exact = ["house", "building", "residential", "place"].includes(h.addresstype) || a.house_number;
    const road = h.addresstype === "road";
    return makeLocation({
      lat: +h.lat, lon: +h.lon, source: exact || road ? "address" : "zip",
      precision_km: exact ? 0.1 : road ? 0.5 : PRECISION_KM.zip,
      label: h.display_name?.replace(/, United States$/, "") || q,
      zip: a.postcode || null, state: toStateCode(a["ISO3166-2-lvl4"]) || toStateCode(a.state),
    });
  }
  const zm = q.match(/\b(\d{5})(?:-\d{4})?\b/);
  if (zm) return locateByZip(zm[1]);
  throw new Error("Couldn't find that address. Try adding the city and state, or just a ZIP code.");
}

export function locateByDevice(lat, lon) {
  if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) throw new Error("Invalid coordinates.");
  return makeLocation({ lat, lon, source: "device", label: `Device location (${lat.toFixed(4)}, ${lon.toFixed(4)})` });
}
