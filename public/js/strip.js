// Test-strip reader.
//
// Cheap soil test kits (pH strips, capsule kits) are read by eye against a
// colour chart, which is hard: shades are close and kitchen light is yellow.
// Here you photograph the strip or capsule *next to the kit's colour chart*,
// tap the test, then tap the chart's colours. Because the chart is in the same
// photo, it's lit the same way, so we can compare colours fairly. Colours are
// compared in CIELAB (built to match how people see colour difference) and the
// reading is interpolated between the two closest chart colours.
// Everything happens on the phone; the photo is never uploaded.

const r = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

/** Average colour of a (2*rad+1)^2 square around (x, y) in ImageData-like {width, height, data}. */
export function sampleColor(img, x, y, rad = 4) {
  const x0 = Math.max(0, Math.round(x) - rad), x1 = Math.min(img.width - 1, Math.round(x) + rad);
  const y0 = Math.max(0, Math.round(y) - rad), y1 = Math.min(img.height - 1, Math.round(y) + rad);
  let R = 0, G = 0, B = 0, n = 0;
  for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
    const k = (yy * img.width + xx) * 4;
    R += img.data[k]; G += img.data[k + 1]; B += img.data[k + 2]; n++;
  }
  return n ? [R / n, G / n, B / n] : [0, 0, 0];
}

/** sRGB (0-255) to CIELAB (D65). */
export function rgbToLab([R, G, B]) {
  const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [rl, gl, bl] = [lin(R), lin(G), lin(B)];
  const X = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / 0.95047;
  const Y = rl * 0.2126 + gl * 0.7152 + bl * 0.0722;
  const Z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / 1.08883;
  const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const dist = (a, b) => Math.sqrt(dot(sub(a, b), sub(a, b)));

/**
 * Reading for the test's colour against chart swatches [{rgb, value}].
 * Projects the test colour onto the path through the chart colours (in value order)
 * and interpolates. `match` is the colour difference (ΔE) from that path:
 * under 10 is a close match, over 20 means the photo or taps are off.
 */
export function readStrip(testRgb, swatches) {
  const sw = (swatches || []).filter(s => Array.isArray(s.rgb) && Number.isFinite(s.value)).sort((a, b) => a.value - b.value);
  if (sw.length < 2) throw new Error("Tap at least two colours on the chart.");
  const p = rgbToLab(testRgb), labs = sw.map(s => rgbToLab(s.rgb));
  let best = null;
  for (let i = 0; i < sw.length - 1; i++) {
    const a = labs[i], b = labs[i + 1], ab = sub(b, a), len2 = dot(ab, ab);
    const t = len2 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / len2)) : 0;
    const q = a.map((v, k) => v + t * ab[k]);
    const d = dist(p, q);
    if (!best || d < best.d - 1e-9) best = { d, value: sw[i].value + t * (sw[i + 1].value - sw[i].value), i, t };
  }
  const confidence = best.d < 10 ? "high" : best.d < 20 ? "medium" : "low";
  const edge = (best.i === 0 && best.t === 0) || (best.i === sw.length - 2 && best.t === 1);
  return { value: r(best.value, 2), match: r(best.d, 1), confidence, at_edge: edge };
}

/** Chart values typed as "4.5, 5.5, 6.5" or "4.5 5 5.5". */
export function parseValues(text) {
  return String(text || "").split(/[\s,;]+/).map(s => s.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
}

export const STRIP_TYPES = {
  ph: { label: "pH", values: "4.5, 5.5, 6.5, 7.5", min: 3, max: 10, field: "ph", decimals: 1 },
  p_ppm: { label: "Phosphorus (ppm)", values: "0, 25, 50, 100", min: 0, max: 400, field: "p_ppm", decimals: 0 },
  k_ppm: { label: "Potassium (ppm)", values: "0, 100, 200, 300", min: 0, max: 800, field: "k_ppm", decimals: 0 },
};

/** Validates and rounds a reading for the soil test form. */
export function toSoilTest(type, reading) {
  const t = STRIP_TYPES[type];
  if (!t) throw new Error("Unknown test.");
  const v = Math.max(t.min, Math.min(t.max, reading.value));
  return { [t.field]: r(v, t.decimals) };
}
