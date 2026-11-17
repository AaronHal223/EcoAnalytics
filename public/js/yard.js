// Yard map.
//
// Each bed in the plan can sit somewhere real: x, y, width and length in feet
// on a sketch of the yard, with north at the top. Knowing where beds are lets
// the app do things a list can't:
//   * count plants per bed from square-foot spacing,
//   * warn about traditional bad neighbours only when beds actually touch,
//   * spot tall crops that will shade a shorter bed just north of them.
// Pure functions; app.js draws the map and handles dragging.

import { CROP_BY_ID } from "./economics.js";
import { GUIDE } from "./guide.js";

export const DEFAULT_YARD = { w: 30, h: 20 };
export const PATH_FT = 2;           // walking space between beds when laying out
export const NEAR_FT = 3;           // beds this close count as neighbours

/** Plants per square foot (square-foot gardening spacing). Fractions mean one plant needs several squares. */
export const PER_SQFT = {
  tomato: 0.25, cherry_tomato: 0.25, pepper: 1, zucchini: 0.2, cucumber: 2, bush_bean: 9, sweet_corn: 1, basil: 4,
  lettuce: 4, spinach: 9, kale: 1, chard: 4, snap_pea: 8, carrot: 16, radish: 16, beet: 9, onion: 9, garlic: 9, potato: 1,
};
/** Crops that grow tall enough (staked, caged or trellised) to shade a neighbour. */
export const TALL = { tomato: 5, cherry_tomato: 5, sweet_corn: 6, snap_pea: 5, cucumber: 5, pepper: 2.5, zucchini: 2.5, kale: 2 };

export function plantCount(cropId, sqft) {
  const per = PER_SQFT[cropId] ?? 1;
  return Math.max(1, Math.floor(sqft * per + 1e-9));
}
export function spacingText(cropId) {
  const per = PER_SQFT[cropId] ?? 1;
  return per >= 1 ? `${per} per sq ft` : `1 plant per ${Math.round(1 / per)} sq ft`;
}

/** A sensible bed shape for an area: 4 ft wide (reachable from both sides), or 2 ft for small beds. */
export function shapeFor(sqft) {
  const a = Math.max(1, Math.round(+sqft || 0));
  const w = a >= 8 ? 4 : a >= 4 ? 2 : 1;
  return { w, h: Math.max(1, Math.ceil(a / w)) };
}

const hasPos = p => [p.x, p.y, p.w, p.h].every(Number.isFinite) && p.w > 0 && p.h > 0;
const overlaps = (a, b, gap = 0) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

/**
 * Gives every bed without a position a spot, keeping beds that have one.
 * Rows run left to right with a path between beds; the yard grows to fit.
 * Returns { plan, yard } (new objects).
 */
export function layout(plan, yard = DEFAULT_YARD) {
  const Y = { w: Math.max(4, Math.round(+yard?.w || DEFAULT_YARD.w)), h: Math.max(4, Math.round(+yard?.h || DEFAULT_YARD.h)) };
  const out = plan.map(p => ({ ...p }));
  const placed = out.filter(hasPos);
  for (const p of out) {
    if (hasPos(p)) continue;
    const s = shapeFor(p.sqft);
    let spot = null;
    for (let y = 1; !spot && y < 400; y++) {
      for (let x = 1; x + s.w <= Y.w - 1 || x === 1; x++) {
        const r = { x, y, w: s.w, h: s.h };
        if (!placed.some(b => overlaps(r, b, PATH_FT - 0.01))) { spot = r; break; }
        if (x + s.w > Y.w - 1) break;
      }
    }
    Object.assign(p, spot);
    placed.push(p);
  }
  const maxX = Math.max(0, ...out.filter(hasPos).map(p => p.x + p.w)), maxY = Math.max(0, ...out.filter(hasPos).map(p => p.y + p.h));
  return { plan: out, yard: { w: Math.max(Y.w, Math.ceil(maxX + 1)), h: Math.max(Y.h, Math.ceil(maxY + 1)) } };
}

/** Keeps a placed bed's rectangle in step when its size is typed in the list. */
export function resizeToArea(p) {
  if (!hasPos(p)) return p;
  const w = Math.min(p.w, Math.max(1, Math.round(p.sqft))) || 1;
  return { ...p, w, h: Math.max(1, Math.ceil(p.sqft / w)) };
}

/** Moves/resizes bed `i` to rect r (feet), snapped to whole feet and kept inside the yard. sqft follows the rectangle. */
export function placeBed(plan, i, r, yard) {
  const w = Math.max(1, Math.min(yard.w, Math.round(r.w))), h = Math.max(1, Math.min(yard.h, Math.round(r.h)));
  const x = Math.max(0, Math.min(yard.w - w, Math.round(r.x))), y = Math.max(0, Math.min(yard.h - h, Math.round(r.y)));
  return plan.map((p, k) => (k === i ? { ...p, x, y, w, h, sqft: w * h } : p));
}

const name = id => CROP_BY_ID[id].name.replace(/\s*\(.*\)/, "");

/** Notes that depend on where beds are: bad neighbours that touch, good ones nearby, and shade from tall crops. */
export function yardNotes(plan, { southernHemisphere = false } = {}) {
  const beds = plan.map((p, i) => ({ ...p, i })).filter(p => hasPos(p) && p.sqft > 0 && CROP_BY_ID[p.crop]);
  const warn = [], good = [], shade = [];
  for (let a = 0; a < beds.length; a++) for (let b = a + 1; b < beds.length; b++) {
    const A = beds[a], B = beds[b];
    if (A.crop === B.crop || !overlaps(A, B, NEAR_FT)) continue;
    const ga = GUIDE[A.crop], gb = GUIDE[B.crop];
    if (ga?.avoid.includes(B.crop) || gb?.avoid.includes(A.crop)) warn.push({ beds: [A.i, B.i], text: `${name(A.crop)} and ${name(B.crop)} are next to each other. They're traditionally kept apart; move one at least ${NEAR_FT} ft away.` });
    else if (ga?.friends.includes(B.crop) || gb?.friends.includes(A.crop)) good.push({ beds: [A.i, B.i], text: `${name(A.crop)} next to ${name(B.crop)}: good neighbours.` });
  }
  // Tall bed T shades bed S when S lies on T's shady side (north in the northern hemisphere, top of the map) and they overlap east-west.
  for (const T of beds) {
    const tall = TALL[T.crop];
    if (!tall) continue;
    for (const S of beds) {
      if (S === T || (TALL[S.crop] ?? 0) >= tall) continue;
      const eastWest = S.x < T.x + T.w && T.x < S.x + S.w;
      const gap = southernHemisphere ? S.y - (T.y + T.h) : T.y - (S.y + S.h);
      if (eastWest && gap >= 0 && gap < tall) shade.push({ beds: [T.i, S.i], text: `${name(T.crop)} grows about ${tall} ft tall and will shade ${name(S.crop)} just ${southernHemisphere ? "south" : "north"} of it. Swap them, or leave ${Math.ceil(tall)} ft between.` });
    }
  }
  return { warn, good, shade };
}

/** Plant positions inside a bed (for drawing dots on the square-foot grid), in feet from the bed's corner. */
export function plantDots(cropId, w, h, max = 400) {
  const per = PER_SQFT[cropId] ?? 1, dots = [];
  if (per >= 1) {
    const k = Math.round(Math.sqrt(per));        // 1, 2, 3 or 4 a side
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
      for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) dots.push([x + (i + 0.5) / k, y + (j + 0.5) / k]);
  } else {
    const side = Math.max(1, Math.round(Math.sqrt(1 / per)));   // 2 ft (4 squares) or 2-3 ft
    for (let y = 0; y + side <= h + 1e-9; y += side) for (let x = 0; x + side <= w + 1e-9; x += side) dots.push([x + side / 2, y + side / 2]);
    if (!dots.length) dots.push([w / 2, h / 2]);
  }
  return dots.slice(0, max);
}
