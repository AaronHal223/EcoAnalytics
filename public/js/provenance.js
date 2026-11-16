// "Where did this number come from?"
//
// Most garden apps hand you a number and ask you to trust it. Every figure in
// EcoAnalytics has a small "i" button that opens its working: the source, the
// formula, the inputs it used and how sure the app is. This file builds those
// explanations from the same data the page is showing, so they can't drift from
// the numbers. Pure functions; app.js only renders what comes back.

import { CROP_BY_ID, IRRIGATION_EFFICIENCY } from "./economics.js";
import { SUN_NEED } from "./sun.js";

const money = (v, d = 2) => (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const num = (v, d = 1) => Number(v).toLocaleString("en-US", { maximumFractionDigits: d });
const CONF = { high: "High", medium: "Medium", low: "Low" };

const SOIL_TITLES = { ph: "Soil pH", organic_matter_pct: "Organic matter", cec: "Nutrient holding (CEC)", p_ppm: "Phosphorus", k_ppm: "Potassium" };

function soilSource(v, soil) {
  switch (v.source) {
    case "ssurgo":
      return `USDA soil survey (SSURGO). Averaged over ${soil.points_with_data} of ${soil.points_sampled} map points within ${soil.radius_km} km of your garden; the centre point counts double. Each point is weighted by the share of each soil type in its map unit and by depth, covering the top 30 cm (the root zone).`;
    case "soilgrids":
      return "ISRIC SoilGrids 2.0, a global 250 m soil map. It is used where the soil survey has no data at your spot (for example, urban land).";
    case "regional":
      return "A broad average for your region, because the soil services could not be reached or had no data here.";
    case "soil_test":
      return "The soil test result you entered. It replaces the estimate everywhere in the app.";
    case "derived":
      return v.key === "p_ppm"
        ? "Estimated from organic matter (20 ppm plus 4 ppm per 1% organic matter). Plant-available phosphorus depends on what has been added to your yard before, so no map knows it."
        : v.key === "k_ppm"
          ? "Estimated from nutrient-holding capacity and clay. Plant-available potassium depends on what has been added to your yard before, so no map knows it."
          : "Estimated from other soil values.";
    default: return String(v.source);
  }
}

function explainSoil(key, d) {
  const v = d.soil.values[key];
  if (!v) return null;
  const steps = [soilSource(v, d.soil)];
  if (v.low != null && v.high != null && v.high > v.low) steps.push(`The nearby map points ranged from ${num(v.low, 2)} to ${num(v.high, 2)}.`);
  if (v.ideal) steps.push(`Ideal range for vegetables: ${v.ideal[0]} to ${v.ideal[1]}.`);
  steps.push(`Confidence: ${CONF[v.confidence]} (score ${v.confidence_score}). It combines how good the source is, how precise your location is, and how closely nearby points agree.`);
  return {
    title: SOIL_TITLES[key] || v.label, summary: `${num(v.value, 2)} ${v.unit === "pH" ? "" : v.unit}`.trim(), steps,
    sources: ["USDA NRCS Soil Data Access", "ISRIC SoilGrids 2.0"],
    caveat: v.source === "soil_test" ? null : "Survey maps describe native soil. A $15-25 soil test from your state's extension office is the best upgrade you can make.",
  };
}

function explainSeason(key, d) {
  const c = d.climate, yrs = `${c.years[0]}-${c.years[c.years.length - 1]}`;
  const caveat = c.source.startsWith("Latitude") ? "Weather history could not be loaded, so this is a rough estimate from your latitude." : null;
  const sources = [c.source];
  if (key === "frost") return { title: "Frost-free season", summary: `${c.frost_free_days} days${c.last_spring_frost ? `, ${c.last_spring_frost} to ${c.first_fall_frost}` : ""}`,
    steps: [`Looks at each day's low temperature for ${yrs}. A night at 32°F or colder counts as a frost.`,
      "Finds the last spring frost and the first fall frost in each year.",
      "Takes the median across the years, so one odd spring doesn't decide what you plant."], sources, caveat };
  if (key === "gdd") return { title: "Growing degree days", summary: `${num(c.season_gdd50, 0)} (base 50°F)`,
    steps: ["Each day adds the average of the high (capped at 86°F) and the low (not below 50°F), minus 50.",
      "Only days between your median frost dates count.", `The result is the median of ${yrs}. Warm crops such as tomatoes and corn need a minimum amount of this heat to finish.`], sources, caveat };
  if (key === "cool") return { title: "Cool-crop days", summary: `${c.cool_growing_days} days`,
    steps: ["Counts days whose average temperature falls between 40°F and 75°F, the range cool-season crops like.", `Median of ${yrs}.`], sources, caveat };
  if (key === "rain") return { title: "Yearly rainfall", summary: `${num(c.annual_precip_in)} in`,
    steps: [`Average of the daily rainfall totals for ${yrs}.`, "The water model keeps only part of it: 60% on sand, 70% on clay, 75% otherwise, because the rest runs off or drains away."], sources, caveat };
  return null;
}

function explainRoi(key, d) {
  const r = d.roi;
  if (d.emptyPlan) return null;
  if (key === "value") return { title: "Harvest value", summary: `${money(r.harvest_value, 0)} from ${num(r.harvest_lb)} lb`,
    steps: ["For each bed: size × typical yield per sq ft × plantings that fit your season × how well the season fits × how well your soil pH suits the crop × how much of the sun it needs the bed gets (x your calibration, if you have finished a season).",
      ...r.rows.map(x => `${x.crop}: ${num(x.sqft, 0)} sq ft gives ${num(x.harvest_lb)} lb, worth ${money(x.value)}${x.sun_fit < 1 ? ` (${num(x.sun)} h of sun gives ${Math.round(x.sun_fit * 100)}% of a full crop)` : ""}${x.calibration ? ` (your yard's calibration ×${x.calibration})` : ""}.`),
      "Prices are typical US supermarket prices per pound (USDA ERS fruit and vegetable prices, rounded). Edit js/data.js to match your store."],
    sources: ["USDA ERS Fruit and Vegetable Prices (rounded)", d.climate.source], caveat: "Yields are for an intensively planted bed. Log your real harvests to calibrate them to your yard." };
  if (key === "cost") {
    const c = r.costs;
    return { title: "Yearly cost", summary: `${money(r.total_cost, 0)}`,
      steps: [`Seeds and plants: ${money(c.seeds_and_plants)}.`, `Water: ${money(c.water)} (gallons beyond rainfall × your rate of ${money(r.water.water_rate)} per 1,000 gal).`,
        `Soil and fertilizer: ${money(c.soil_and_fertilizer)} (only what you use this season; bags last longer).`, `Setup, spread over its years: ${money(c.setup_per_year)}.`,
        c.labor > 0 ? `Your time: ${money(c.labor)} (${num(r.labor.hours)} hours at ${money(r.labor.wage)} per hour).` : "Your time is not charged. Enter an hourly value to include it."],
      sources: [], caveat: null };
  }
  if (key === "net") return { title: "Net savings", summary: `${money(r.net, 0)}${r.roi_pct != null ? `, ${num(r.roi_pct, 0)}% return` : ""}`,
    steps: [`Harvest value ${money(r.harvest_value)} minus yearly cost ${money(r.total_cost)} = ${money(r.net)}.`, "Return % = net savings divided by yearly cost."], sources: [], caveat: null };
  if (key === "time") {
    const L = r.labor;
    return { title: "Your time", summary: L.per_hour != null ? `${money(L.per_hour)} per hour` : "No hours yet",
      steps: [`Hours = bed area / 100 × ${num(L.hr_per_100sqft_week, 2)} ${L.hr_per_100sqft_week === 1 ? "hour" : "hours"} per week per 100 sq ft × ${L.weeks} weeks of growing season = ${num(L.hours)} hours.`,
        `Per hour = (harvest value minus seeds, water, fertilizer and yearly setup, which is ${money(L.net_before_labor)}) divided by ${num(L.hours)} hours.`,
        L.wage > 0 ? `Your time is also counted as a cost at ${money(L.wage)} per hour.` : "Your time is not counted as a cost unless you enter an hourly value."],
      sources: [], caveat: "The hours per week is an assumption, not a measurement. Change it to match how much you actually work in the garden." };
  }
  return null;
}

function explainWater(key, d) {
  const w = d.roi.water, eff = IRRIGATION_EFFICIENCY[w.method] ?? 0.75;
  if (key === "total") return { title: "Irrigation per year", summary: `${num(w.total_gallons, 0)} gal`,
    steps: ["For each bed and month the crop is growing: crop water use (crop factor × evapotranspiration) minus the rain your soil keeps.",
      "Inches become gallons at 0.623 gal per sq ft per inch.", `Then it is divided by how efficient your method is (${Math.round(eff * 100)}% for ${w.method}; drip 90%, hose 75%, sprinkler 65%), because some water never reaches roots.`,
      "The rain your soil keeps is 60% on sand, 70% on clay, 75% otherwise."], sources: [d.climate.source], caveat: null };
  if (key === "cost") return { title: "Water cost per year", summary: money(w.total_cost),
    steps: [`${num(w.total_gallons, 0)} gal / 1,000 × your rate of ${money(w.water_rate)} per 1,000 gal = ${money(w.total_cost)}.`, "Find your rate on your water bill. If it is billed per CCF, a CCF is 748 gallons."], sources: [], caveat: null };
  if (key === "rain") return { title: "Rain does the rest", summary: `${num(w.rain_supplied_gallons, 0)} gal`,
    steps: ["Monthly rainfall × the share your soil keeps, capped at 85% of what the crops could use, summed over the growing months and multiplied by your planted area."], sources: [d.climate.source], caveat: null };
  if (key === "week") {
    const a = d.advice;
    if (!a?.available || !a.active) return null;
    return { title: "This week's watering", summary: `${a.water_days} watering day${a.water_days === 1 ? "" : "s"}, ${money(a.week_cost)}`,
      steps: [`Each day, plants use evapotranspiration × ${a.kc} (the average crop factor of the beds growing now, ${num(a.area_sqft, 0)} sq ft).`,
        "Only rain of 0.1 in or more counts, and only the share your soil keeps.",
        `Your soil holds about ${a.bucket_in} in of usable water before plants feel stress. When it runs down you water enough to refill it.`,
        "The starting dryness comes from the last two days of weather, assuming you haven't watered since.",
        `Saving: a timer that waters every day and ignores rain would use ${num(a.timer_gallons, 0)} gal this week; this plan uses ${num(a.week_gallons, 0)} gal. The difference is ${num(a.saved_gallons, 0)} gal, or ${money(a.saved_cost)}.`],
      sources: ["Open-Meteo forecast"], caveat: "A forecast is a forecast. Check the soil with your finger two inches down before you skip a watering." };
  }
  return null;
}

function explainFert(key, d) {
  const f = d.roi.fertilizer;
  if (key === "store") return { title: "At the store", summary: money(f.upfront_cost),
    steps: ["Whole bags, because you can't buy half a bag.", "A mixed-integer program picks the combination of products with the lowest store price that still meets the plan's nitrogen, phosphorus and potassium needs.", ...f.purchases.map(p => `${p.name}: ${p.bags} × ${p.bag_lb} lb = ${money(p.upfront_cost)}.`)],
    sources: [], caveat: "Prices are typical garden-center prices. Edit js/data.js to match yours." };
  if (key === "season") return { title: "Used this season", summary: money(f.season_cost),
    steps: ["The cost of the fertilizer you apply this season, not the whole bags. Leftovers carry over, so only what you use counts against this year's ROI."], sources: [], caveat: null };
  if (key === "nitrogen") return { title: "Nitrogen to add", summary: `${num(f.need_lb.N * 16, 1)} oz`,
    steps: ["Crop demand per planting (low, medium or high) × plantings that fit your season × bed area.",
      `Minus ${num(f.credits_lb.N_from_organic_matter * 16, 1)} oz your soil's organic matter releases (the credit is capped at half of the demand).`,
      `Minus ${num(f.credits_lb.N_from_compost * 16, 1)} oz from any compost you add.`], sources: [], caveat: null };
  return null;
}

function explainCrop(id, d) {
  const c = CROP_BY_ID[id], row = d.ranking?.find(x => x.id === id);
  if (!c || !row) return null;
  return { title: c.name, summary: `${money(row.net_per_sqft)} net per sq ft`,
    steps: [`Harvest value ${money(row.value_per_sqft)} (${num(row.yield_lb_per_sqft, 2)} lb per sq ft at the store price).`,
      `Minus seeds and plants ${money(row.seed_cost_per_sqft)}.`, `Minus water ${money(row.water_cost_per_sqft, 3)} (${num(row.water_gal_per_sqft)} gal per sq ft).`,
      `Minus nitrogen ${money(row.fertilizer_cost_per_sqft, 3)}.`, `Equals ${money(row.net_per_sqft)} net per sq ft for one year.`,
      row.calibration ? `This crop's yield is scaled by ×${row.calibration} from your own harvest log.` : row.note, row.soil_note,
      d.settings?.sunHours != null ? `Sun: ranked for ${num(d.settings.sunHours)} hours of direct sun a day. ${row.sun_fit < 1 ? `It needs about ${SUN_NEED[id]}, so it gives ${Math.round(row.sun_fit * 100)}% of a full crop (yield falls a little faster than the light does).` : "That's enough for a full crop."}` : "Sun: assumes full sun (8+ hours). Pick your yard's sun above the table, or measure each bed on Garden ROI.",
      d.risk?.[id] ? `Across ${d.risk[id].n} past seasons here: ${money(d.risk[id].bad)} in a bad (1-in-10) year, ${money(d.risk[id].typical)} typical, ${money(d.risk[id].good)} in a good year. It paid its way in ${d.risk[id].positive} of them.` : null],
    sources: [], caveat: null };
}

function explainRisk(key, d) {
  const p = d.planRisk;
  if (key !== "plan" || !p) return null;
  return { title: "Good year, bad year", summary: `Paid off in ${p.positive} of ${p.n} past seasons`,
    steps: [`Downloads the real daily weather at your garden for each of the last ${p.n} years.`,
      "For each year on its own, works out that year's frost dates, heat (growing degree days), cool-crop days, rain and evapotranspiration.",
      "Runs your plan through each year with the same yield, water and fertilizer models as the rest of the app, at today's prices.",
      `A "bad year" is the 10th percentile: about 1 season in 10 is worse. Here: ${money(p.bad, 0)}. Typical (median): ${money(p.typical, 0)}. Best: ${money(p.best, 0)} in ${p.best_year}; worst: ${money(p.worst, 0)} in ${p.worst_year}.`],
    sources: d.historySource ? [d.historySource] : [],
    caveat: "Weather is the only thing that varies here. Pests, hail and a busy summer can also cost a harvest." };
}

/** Returns { title, summary, steps[], sources[], caveat } for a key like "soil:ph", or null. */
export function explain(key, d) {
  if (!d || !key) return null;
  const [kind, id] = key.split(":");
  if (kind === "soil") return explainSoil(id, d);
  if (kind === "season") return explainSeason(id, d);
  if (kind === "roi") return explainRoi(id, d);
  if (kind === "water") return explainWater(id, d);
  if (kind === "fert") return explainFert(id, d);
  if (kind === "crop") return explainCrop(id, d);
  if (kind === "risk") return explainRisk(id, d);
  return null;
}
