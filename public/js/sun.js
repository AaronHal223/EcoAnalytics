// Sun hours: how much direct sun each bed really gets.
//
// Sunlight is the biggest single driver of how much a vegetable bed yields,
// and it's the one thing a map can't know: a fence, a neighbour's maple or the
// house itself decide it. EcoAnalytics measures it two ways, both free and
// entirely on the device:
//
//   1. Scan: stand at the bed, aim the phone's camera at the top of whatever
//      blocks the sky (trees, roofs, fences) and sweep from east to west. The
//      compass and tilt sensors record the "skyline": how high obstacles reach
//      in each direction. Nothing is uploaded; the camera is only a viewfinder.
//   2. Quick estimate: pick how tall obstacles look in each direction.
//
// Either way we get a skyline, then trace the sun's real path for your
// latitude across the growing months and count the hours it is above both the
// skyline and 10 degrees (very low sun gives little growing light).
// Pure functions; app.js handles the camera and sensors.

const RAD = Math.PI / 180;
export const BIN_DEG = 5;                       // skyline resolution
export const BINS = 360 / BIN_DEG;
export const MIN_SUN_ELEV = 10;                 // degrees; lower sun barely counts
export const FULL_SUN = 8;                      // hours; the default when nothing is measured
const r = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

/** Hours of direct sun each crop needs for a full harvest (rule of thumb from extension guides). */
export const SUN_NEED = {
  tomato: 8, cherry_tomato: 7, pepper: 8, zucchini: 7, cucumber: 7, sweet_corn: 8, bush_bean: 6, snap_pea: 6, basil: 6,
  carrot: 6, beet: 5, radish: 5, onion: 7, garlic: 6, potato: 6,
  lettuce: 4, spinach: 4, kale: 4, chard: 4,
};

/**
 * Share of a full harvest a crop gives with `hours` of direct sun.
 * Below its need, yield falls a little faster than the light does (exponent 1.5),
 * so fruiting crops suffer most in shade and leafy greens least. Never below 5%.
 */
export function sunFactor(cropId, hours) {
  if (hours == null || !Number.isFinite(+hours)) return 1;
  const need = SUN_NEED[cropId] ?? 6;
  if (hours >= need) return 1;
  return r(Math.max(0.05, (Math.max(0, hours) / need) ** 1.5), 2);
}

export function sunLabel(hours) {
  if (hours == null) return "Full sun (assumed)";
  if (hours >= 8) return "Full sun";
  if (hours >= 6) return "Mostly sunny";
  if (hours >= 4) return "Part shade";
  return "Shade";
}

/** Sun position for latitude `lat`, day of year `doy`, local solar time `hour` (12 = solar noon). Degrees; azimuth from north, clockwise. */
export function solarPosition(lat, doy, hour) {
  const decl = 23.44 * Math.sin(2 * Math.PI * (284 + doy) / 365) * RAD;
  const phi = lat * RAD, h = 15 * (hour - 12) * RAD;
  const sinEl = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(h);
  const el = Math.asin(Math.max(-1, Math.min(1, sinEl)));
  const azS = Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi));
  return { elevation: el / RAD, azimuth: ((azS / RAD + 180) % 360 + 360) % 360 };
}

export const binOf = az => Math.floor((((az % 360) + 360) % 360) / BIN_DEG) % BINS;

/** Months that count as the growing season: April to September, or October to March south of the equator. */
export function growingMonths(lat) { return lat >= 0 ? [3, 4, 5, 6, 7, 8] : [9, 10, 11, 0, 1, 2]; }
const MID_DOY = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349];

/** Average hours per day of direct sun over the growing months, plus each month's figure. */
export function sunHours(lat, skyline, months = growingMonths(lat)) {
  const sky = skyline && skyline.length === BINS ? skyline : Array(BINS).fill(0);
  const step = 1 / 6;   // 10 minutes
  const perMonth = {};
  for (const m of months) {
    let hrs = 0;
    for (let t = 0; t < 24; t += step) {
      const p = solarPosition(lat, MID_DOY[m], t + step / 2);
      if (p.elevation > MIN_SUN_ELEV && p.elevation > sky[binOf(p.azimuth)]) hrs += step;
    }
    perMonth[m] = r(hrs);
  }
  const vals = Object.values(perMonth);
  return { hours: r(vals.reduce((a, b) => a + b, 0) / (vals.length || 1)), perMonth, months };
}

/** Same sun path with an open sky: the most this spot could get. */
export const openSkyHours = lat => sunHours(lat, Array(BINS).fill(0)).hours;

// ---- Quick estimate -------------------------------------------------------------------------
/** Obstacle heights people can judge by eye, in degrees above the horizon. */
export const HEIGHTS = [
  { id: "open", label: "Open sky", deg: 0 },
  { id: "low", label: "Low (fence, shrubs)", deg: 12 },
  { id: "mid", label: "Medium (house, small tree)", deg: 28 },
  { id: "high", label: "Tall (big trees, building)", deg: 48 },
  { id: "blocked", label: "Blocked", deg: 75 },
];
export const DIRECTIONS = [
  { id: "E", az: 90 }, { id: "SE", az: 135 }, { id: "S", az: 180 }, { id: "SW", az: 225 }, { id: "W", az: 270 },
];

/** Skyline from by-eye heights for E, SE, S, SW, W (north-facing equivalents in the southern hemisphere). */
export function skylineFromEstimate(choice = {}, lat = 40) {
  const deg = id => (HEIGHTS.find(h => h.id === choice[id]) || HEIGHTS[0]).deg;
  // In the southern hemisphere the sun crosses the north, so mirror the compass.
  const pts = DIRECTIONS.map(d => ({ az: lat >= 0 ? d.az : (540 - d.az) % 360, deg: deg(d.id) }));
  // The far side (N in the north) matters little; carry the E and W values round so dawn/dusk aren't over-counted.
  const e = pts[0], w = pts[4];
  const far = { az: lat >= 0 ? 0 : 180, deg: Math.min(e.deg, w.deg) };
  return interpolate([...pts, far]);
}

/** Circular linear interpolation of {az, deg} points onto BINS bins. */
export function interpolate(points) {
  const p = points.filter(x => Number.isFinite(x.az) && Number.isFinite(x.deg))
    .map(x => ({ az: ((x.az % 360) + 360) % 360, deg: Math.max(0, Math.min(90, x.deg)) })).sort((a, b) => a.az - b.az);
  if (!p.length) return Array(BINS).fill(0);
  if (p.length === 1) return Array(BINS).fill(p[0].deg);
  return Array.from({ length: BINS }, (_, i) => {
    const az = i * BIN_DEG + BIN_DEG / 2;
    let a = p[p.length - 1], b = p[0];
    for (let k = 0; k < p.length; k++) {
      if (p[k].az >= az) { b = p[k]; a = p[(k - 1 + p.length) % p.length]; break; }
      if (k === p.length - 1) { a = p[k]; b = p[0]; }
    }
    const span = ((b.az - a.az) + 360) % 360 || 360, off = ((az - a.az) + 360) % 360;
    return r(a.deg + (b.deg - a.deg) * (off / span), 1);
  });
}

// ---- Scan with the camera ---------------------------------------------------------------------
/**
 * Direction the back camera points, from W3C DeviceOrientation angles (degrees).
 * `alpha` must be a true compass angle (deviceorientationabsolute, or corrected with
 * iOS's webkitCompassHeading). Returns compass heading (0 = north) and elevation above the horizon.
 */
export function cameraDirection(alpha, beta, gamma) {
  const a = alpha * RAD, b = beta * RAD, g = gamma * RAD;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
  // R = Rz(a) Rx(b) Ry(g) applied to the back-camera vector (0, 0, -1).
  const x = -(ca * sg + sa * sb * cg);
  const y = -(sa * sg - ca * sb * cg);
  const z = -(cb * cg);
  const heading = ((Math.atan2(x, y) / RAD) % 360 + 360) % 360;
  const elevation = Math.asin(Math.max(-1, Math.min(1, z))) / RAD;
  return { heading: r(heading) + 0, elevation: r(elevation) + 0 };
}

/**
 * Turn scan samples [{heading, elevation}] into a skyline.
 * Each 5-degree bin keeps the median elevation aimed at (clamped 0-90); gaps are interpolated.
 * Returns null if the sweep covered too little of the sky.
 */
export function skylineFromSamples(samples, { minBins = 10 } = {}) {
  const buckets = Array.from({ length: BINS }, () => []);
  for (const s of samples || []) {
    if (!Number.isFinite(s?.heading) || !Number.isFinite(s?.elevation)) continue;
    buckets[binOf(s.heading)].push(Math.max(0, Math.min(90, s.elevation)));
  }
  const filled = buckets.map((v, i) => v.length ? { az: i * BIN_DEG + BIN_DEG / 2, deg: median(v) } : null).filter(Boolean);
  if (filled.length < minBins) return null;
  return { skyline: interpolate(filled), covered: filled.length / BINS };
}

/** Which bins have been swept (for the coverage bar). */
export function coverage(samples) {
  const on = Array(BINS).fill(false);
  for (const s of samples || []) if (Number.isFinite(s?.heading)) on[binOf(s.heading)] = true;
  return on;
}

export function compassName(deg) {
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

function median(a) { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

/** Which crop groups suit `hours` of sun, for the result card. */
export function whatGrows(hours) {
  if (hours >= 8) return "Everything, including tomatoes, peppers and corn.";
  if (hours >= 6) return "Beans, peas, roots, herbs and greens do well; tomatoes and peppers give a bit less.";
  if (hours >= 4) return "Best for leafy greens (lettuce, spinach, kale, chard). Fruiting crops will struggle.";
  return "Too shady for most vegetables. Leafy greens may give a small harvest.";
}
