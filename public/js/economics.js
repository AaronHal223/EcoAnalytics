// The money side of a backyard garden, driven by the researched soil and the
// local weather history:
//   1. Crop value ranking   - net dollars per sq ft per year in *this* yard
//   2. Water cost           - monthly irrigation beyond rainfall, in gallons and $
//   3. Fertilizer optimizer - cheapest set of *whole bags* covering N-P-K needs
//                             (mixed-integer program), plus lime/sulfur and compost
//   4. Garden ROI           - harvest value vs. every cost, with payback time
// Prices and yields live in data.js so anyone can edit them.

import { CROPS, FERTILIZERS, PH_PRODUCTS, COMPOST } from "./data.js";
import { MONTHS } from "./climate.js";

const GAL_PER_SQFT_INCH = 0.623;
export const N_RATE = { low: 0.08, med: 0.25, high: 0.35 };   // lb N / 100 sq ft / planting
export const P_RATE = { low: 0.25, ok: 0.10, high: 0.0 };      // lb P2O5 / 100 sq ft / season
export const K_RATE = { low: 0.30, ok: 0.15, high: 0.0 };      // lb K2O / 100 sq ft / season
export const IRRIGATION_EFFICIENCY = { drip: 0.90, hose: 0.75, sprinkler: 0.65 };
export const DEFAULT_WATER_RATE = 6.0;  // $ per 1,000 gallons

export const CROP_BY_ID = Object.fromEntries(CROPS.map(c => [c.id, c]));
const r = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const sum = a => a.reduce((x, y) => x + y, 0);

// ---- Season fit ---------------------------------------------------------------
export function seasonFit(crop, cl) {
  const days = crop.days;
  if (crop.season === "warm") {
    const ffd = cl.frost_free_days;
    const frac = Math.min(Math.min(1, cl.season_gdd50 / (crop.gdd50 || 1000)),
      Math.min(1, Math.max(0, (ffd - 14) / (days + 30))));
    let plantings = 1;
    while (plantings < crop.max_plantings && ffd >= (plantings + 1) * days + 30) plantings++;
    const note = frac < 0.6 ? "Season is too short or too cool for a full crop"
      : frac < 1 ? "Partial harvest: season is a bit short"
      : `${plantings} planting${plantings > 1 ? "s" : ""} fit your frost-free season`;
    return { plantings, fraction: r(frac), note };
  }
  const cool = cl.cool_growing_days;
  if (crop.overwinter) {
    const cold = cl.monthly_tmean_f.some(t => t !== null && t < 45);
    return { plantings: 1, fraction: cold ? 1 : 0.5,
      note: cold ? "Plant in fall, harvest next summer" : "Winters may be too warm for full bulbs" };
  }
  const plantings = Math.min(crop.max_plantings, Math.floor(cool / days));
  if (plantings >= 1) return { plantings, fraction: 1, note: `${plantings} planting${plantings > 1 ? "s" : ""} across your cool seasons` };
  return { plantings: 1, fraction: r(cool / days), note: "Cool season is short; expect a partial harvest" };
}

/** First 0.2 pH units outside a crop's range are free (within map/test error); then -25% per unit. */
export function phFactor(crop, ph) {
  const [lo, hi] = crop.ph;
  const off = ph < lo ? lo - ph : ph > hi ? ph - hi : 0;
  return r(Math.max(0.5, 1 - 0.25 * Math.max(0, off - 0.2)));
}

// ---- Water -------------------------------------------------------------------------
export function effectiveRainFactor(texture) {
  if (["sand", "loamy sand"].includes(texture)) return 0.60;
  if (["clay", "silty clay", "sandy clay"].includes(texture)) return 0.70;
  return 0.75;
}

function occupancy(crop, fit, cl) {
  if (crop.season === "warm" || crop.overwinter) return 1;  // warm crops hold the bed all season
  return Math.min(1, fit.plantings * crop.days / Math.max(cl.cool_growing_days, 1));
}

export function monthlyIrrigationIn(crop, fit, cl, texture) {
  const eff = effectiveRainFactor(texture);
  const active = crop.season === "warm" ? cl.monthly_active_frac_warm : cl.monthly_active_frac_cool;
  const occ = occupancy(crop, fit, cl);
  return MONTHS.map((_, m) => Math.max(0, crop.kc * cl.monthly_et0_in[m] - eff * cl.monthly_precip_in[m]) * active[m] * occ);
}

export const gallons = (inches, sqft, method = "hose") =>
  inches * sqft * GAL_PER_SQFT_INCH / (IRRIGATION_EFFICIENCY[method] || 0.75);

// ---- 1) Crop value ranking ------------------------------------------------------------
export function cheapestNPrice(organicOnly) {
  let best = Infinity;
  for (const f of FERTILIZERS) {
    if (organicOnly && !f.organic) continue;
    const n = f.bag_lb * f.n / 100 * f.n_avail;
    if (n > 0) best = Math.min(best, f.bag_price / n);
  }
  return best;
}

export function rankCrops(soil, cl, { waterRate = DEFAULT_WATER_RATE, method = "hose", organicOnly = false, prices = {} } = {}) {
  const ph = soil.values.ph.value;
  const nFree = soil.n_mineralized_lb_per_100sqft / 100;
  const nPrice = cheapestNPrice(organicOnly);
  return CROPS.map(c => {
    const price = prices[c.id] ?? c.price_per_lb;
    const fit = seasonFit(c, cl), pf = phFactor(c, ph);
    const y = c.yield_lb_per_sqft * fit.plantings * fit.fraction * pf;
    const value = y * price, seed = c.cost_per_sqft * fit.plantings;
    const gal = gallons(sum(monthlyIrrigationIn(c, fit, cl, soil.texture_class)), 1, method);
    const water = gal / 1000 * waterRate;
    const fert = Math.max(0, N_RATE[c.n_demand] / 100 * fit.plantings - 0.5 * nFree) * nPrice;
    return {
      id: c.id, name: c.name, season: c.season, plantings: fit.plantings, season_fraction: fit.fraction,
      soil_fit: pf, yield_lb_per_sqft: r(y), value_per_sqft: r(value), seed_cost_per_sqft: r(seed),
      water_gal_per_sqft: r(gal, 1), water_cost_per_sqft: r(water, 3), fertilizer_cost_per_sqft: r(fert, 3),
      net_per_sqft: r(value - seed - water - fert),
      value_per_100_gal: gal > 0.05 ? r(value / gal * 100) : null,
      note: fit.note, soil_note: pf === 1 ? "Soil pH suits it" : `Prefers pH ${c.ph[0]}-${c.ph[1]}; your soil is ${ph.toFixed(1)}`,
    };
  }).sort((a, b) => b.net_per_sqft - a.net_per_sqft);
}

// ---- 2) Water cost tracking --------------------------------------------------------------
export function waterPlan(plan, soil, cl, waterRate = DEFAULT_WATER_RATE, method = "hose") {
  let monthly = Array(12).fill(0);
  const byCrop = [];
  for (const item of plan) {
    const c = CROP_BY_ID[item.crop], fit = seasonFit(c, cl);
    const gal = monthlyIrrigationIn(c, fit, cl, soil.texture_class).map(i => gallons(i, item.sqft, method));
    monthly = monthly.map((a, m) => a + gal[m]);
    byCrop.push({ crop: c.name, sqft: item.sqft, gallons: Math.round(sum(gal)), cost: r(sum(gal) / 1000 * waterRate) });
  }
  const total = sum(monthly), area = sum(plan.map(p => p.sqft)) || 1;
  const eff = effectiveRainFactor(soil.texture_class);
  const rainGal = sum(MONTHS.map((_, m) => Math.min(cl.monthly_precip_in[m] * eff, 0.85 * cl.monthly_et0_in[m])
    * Math.max(cl.monthly_active_frac_warm[m], cl.monthly_active_frac_cool[m]))) * area * GAL_PER_SQFT_INCH;
  const cost = total / 1000 * waterRate;
  return {
    months: MONTHS, monthly_gallons: monthly.map(Math.round), monthly_cost: monthly.map(g => r(g / 1000 * waterRate)),
    monthly_rain_in: cl.monthly_precip_in, monthly_et0_in: cl.monthly_et0_in,
    total_gallons: Math.round(total), total_cost: r(cost), rain_supplied_gallons: Math.round(rainGal),
    by_crop: byCrop, water_rate: waterRate, method,
    drip_savings: method === "drip" ? 0 : r(cost * (1 - (IRRIGATION_EFFICIENCY[method] || 0.75) / IRRIGATION_EFFICIENCY.drip)),
  };
}

// ---- 3) Fertilizer optimizer ---------------------------------------------------------------
export function phAdjustment(soil, area) {
  const ph = soil.values.ph.value, cec = soil.values.cec.value;
  let rate, p, verb, target;
  if (ph < 6.0) {
    const perUnit = Math.min(10, Math.max(2.5, 0.4 * cec + 2));        // lb lime / 100 sq ft / pH unit
    rate = Math.min(10, perUnit * (6.5 - ph)); p = PH_PRODUCTS.lime; verb = "raise"; target = 6.5;
  } else if (ph > 7.3) {
    const perUnit = Math.min(2.5, Math.max(0.5, 0.1 * cec + 0.2));     // lb sulfur / 100 sq ft / pH unit
    rate = Math.min(2, perUnit * (ph - 6.8)); p = PH_PRODUCTS.sulfur; verb = "lower"; target = 6.8;
  } else return null;
  const lbs = rate * area / 100, bags = Math.max(1, Math.ceil(lbs / p.bag_lb));
  return {
    product: p.name, action: `${verb} pH from ${ph.toFixed(1)} toward ${target}`,
    lb_per_100_sqft: r(rate, 1), lbs: r(lbs, 1), bags, upfront_cost: r(bags * p.bag_price),
    season_cost: r(lbs * p.bag_price / p.bag_lb / 3),  // one application lasts ~3 seasons
    note: verb === "raise" ? "Mix into the top 6 in. Lime works slowly; apply in fall if you can."
      : "Sulfur acts over months; re-check pH next year before adding more.",
  };
}

export function compostAdjustment(soil, area) {
  const om = soil.values.organic_matter_pct.value;
  if (om >= 4) return null;
  const inches = Math.min(2, Math.max(0.5, Math.ceil((4 - om) / 1.5 * 2) / 2));  // ~1.5% OM per inch
  const cuft = area * inches / 12, bags = Math.ceil(cuft / COMPOST.bag_cuft);
  return {
    product: COMPOST.name, inches, cubic_feet: r(cuft, 1), bags,
    upfront_cost: r(bags * COMPOST.bag_price), season_cost: r(bags * COMPOST.bag_price),
    n_credit_lb: r(cuft * COMPOST.lb_per_cuft * COMPOST.n_pct / 100 * COMPOST.n_avail, 3),
    note: `Organic matter is ${om.toFixed(1)}% (aim for 4-8%). Bulk compost by the yard is usually half the price of bags for beds over ~50 sq ft.`,
  };
}

export function planNeeds(plan, soil, cl) {
  const area = sum(plan.map(p => p.sqft));
  const n = sum(plan.map(i => { const c = CROP_BY_ID[i.crop]; return N_RATE[c.n_demand] * seasonFit(c, cl).plantings * i.sqft / 100; }));
  const p = P_RATE[soil.values.p_ppm.status || "ok"] * area / 100;
  const k = K_RATE[soil.values.k_ppm.status || "ok"] * area / 100;
  return { area, n, p, k };
}

function solve(model) {
  const s = globalThis.solver;
  if (!s) throw new Error("LP solver not loaded");
  return s.Solve(model);
}

export function optimizeFertilizer(plan, soil, cl, organicOnly = false) {
  const { area, n: nGross, p: pReq, k: kReq } = planNeeds(plan, soil, cl);
  const compost = compostAdjustment(soil, area);
  const omCredit = Math.min(0.5 * nGross, soil.n_mineralized_lb_per_100sqft * area / 100);
  const compostCredit = compost ? compost.n_credit_lb : 0;
  const nReq = Math.max(0, nGross - omCredit - compostCredit);
  const ferts = FERTILIZERS.filter(f => !organicOnly || f.organic);
  const notes = [], purchases = [];
  let supplied = { N: 0, P2O5: 0, K2O: 0 };

  if (nReq + pReq + kReq > 1e-6) {
    // Variables: x_i = lb applied, b_i = whole bags bought (integer, x_i <= bag_lb_i * b_i).
    // Minimise money spent at the store; tiny tie-break on product used.
    const build = (withCaps) => {
      const constraints = {
        N: { min: nReq, ...(withCaps ? { max: nReq * 1.5 + 0.05 * area / 100 } : {}) },
        P: { min: pReq, ...(withCaps ? { max: pReq + 0.15 * area / 100 } : {}) },
        K: { min: kReq, ...(withCaps ? { max: kReq + 0.30 * area / 100 } : {}) },
      };
      const variables = {}, ints = {};
      ferts.forEach((f, i) => {
        constraints[`cap${i}`] = { max: 0 };
        constraints[`bmax${i}`] = { max: 20 };
        variables[`x${i}`] = { cost: 1e-3 * f.bag_price / f.bag_lb, N: f.n / 100 * f.n_avail, P: f.p / 100, K: f.k / 100, [`cap${i}`]: 1 };
        variables[`b${i}`] = { cost: f.bag_price, [`cap${i}`]: -f.bag_lb, [`bmax${i}`]: 1 };
        ints[`b${i}`] = 1;
      });
      return { optimize: "cost", opType: "min", constraints, variables, ints };
    };
    let res = solve(build(true));
    if (!res.feasible) {
      res = solve(build(false));
      notes.push("No product mix hit every target exactly; some nutrients are slightly over.");
    }
    if (res.feasible) {
      supplied = { N: 0, P2O5: 0, K2O: 0 };
      ferts.forEach((f, i) => {
        const x = res[`x${i}`] || 0, b = Math.round(res[`b${i}`] || 0);
        if (x <= 1e-4) return;
        const perLb = f.bag_price / f.bag_lb;
        purchases.push({ name: f.name, bags: b, bag_lb: f.bag_lb, lbs_to_apply: r(x),
          upfront_cost: r(b * f.bag_price), season_cost: r(x * perLb),
          per_100_sqft_lb: r(x / area * 100), leftover_lb: r(b * f.bag_lb - x, 1) });
        supplied.N += x * f.n / 100 * f.n_avail; supplied.P2O5 += x * f.p / 100; supplied.K2O += x * f.k / 100;
      });
      supplied = { N: r(supplied.N, 3), P2O5: r(supplied.P2O5, 3), K2O: r(supplied.K2O, 3) };
    }
  } else {
    notes.push("Your soil and compost cover this plan's nutrient needs; no fertilizer to buy.");
  }

  const ph = phAdjustment(soil, area);
  if (soil.values.p_ppm.source !== "soil_test") {
    notes.push("Phosphorus and potassium targets use estimated soil levels. A home or extension soil test would let this plan skip anything you don't need.");
  }
  const upfront = sum(purchases.map(p => p.upfront_cost)) + (ph?.upfront_cost || 0) + (compost?.upfront_cost || 0);
  const season = sum(purchases.map(p => p.season_cost)) + (ph?.season_cost || 0) + (compost?.season_cost || 0);
  return {
    area_sqft: area, need_lb: { N: r(nReq, 3), P2O5: r(pReq, 3), K2O: r(kReq, 3) }, supplied_lb: supplied,
    credits_lb: { N_from_organic_matter: r(omCredit, 3), N_from_compost: r(compostCredit, 3) },
    purchases, upfront_cost: r(upfront), season_cost: r(season), ph_action: ph, compost_action: compost, notes,
  };
}

// ---- 4) Garden ROI ---------------------------------------------------------------------------
export function gardenROI(plan, soil, cl, { waterRate = DEFAULT_WATER_RATE, method = "hose", setupCost = 0,
  setupYears = 5, organicOnly = false, prices = {} } = {}) {
  const water = waterPlan(plan, soil, cl, waterRate, method);
  const fert = optimizeFertilizer(plan, soil, cl, organicOnly);
  const rows = [];
  let lb = 0, value = 0, seeds = 0;
  for (const item of plan) {
    const c = CROP_BY_ID[item.crop], price = prices[c.id] ?? c.price_per_lb;
    const fit = seasonFit(c, cl), pf = phFactor(c, soil.values.ph.value);
    const y = c.yield_lb_per_sqft * fit.plantings * fit.fraction * pf * item.sqft;
    const s = c.cost_per_sqft * fit.plantings * item.sqft;
    rows.push({ crop: c.name, sqft: item.sqft, harvest_lb: r(y, 1), value: r(y * price), seed_cost: r(s) });
    lb += y; value += y * price; seeds += s;
  }
  const setupPerYear = setupCost / Math.max(1, setupYears);
  const running = seeds + water.total_cost + fert.season_cost;
  const total = running + setupPerYear, gain = value - running;
  return {
    rows, harvest_lb: r(lb, 1), harvest_value: r(value),
    costs: { seeds_and_plants: r(seeds), water: water.total_cost, soil_and_fertilizer: fert.season_cost, setup_per_year: r(setupPerYear) },
    upfront_store_cost: r(fert.upfront_cost + seeds + setupCost),
    total_cost: r(total), net: r(value - total),
    roi_pct: total > 0 ? r((value - total) / total * 100, 1) : null,
    payback_seasons: setupCost > 0 && gain > 0 ? r(setupCost / gain, 1) : null,
    cost_per_lb: lb > 0 ? r(total / lb) : null,
    water, fertilizer: fert,
  };
}
