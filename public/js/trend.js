// How your season is shifting.
//
// The same 15 past seasons used for "good year, bad year" also show where the
// season is heading at this exact spot: is the last spring frost coming
// earlier, the first fall frost later, the summer hotter? We fit a straight
// line through the years and only call it a trend when it stands out from the
// year-to-year noise (slope at least twice its standard error). Fifteen years
// is short for climate, so the wording stays modest.

const r = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

/** Least-squares line through (xs, ys): slope, intercept, slope's standard error, r². */
export function linreg(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); syy += (ys[i] - my) ** 2; }
  if (!sxx) return null;
  const slope = sxy / sxx, intercept = my - slope * mx;
  const sse = ys.reduce((a, y, i) => a + (y - (intercept + slope * xs[i])) ** 2, 0);
  const se = Math.sqrt(sse / Math.max(1, n - 2) / sxx);
  return { slope, intercept, se, r2: syy ? 1 - sse / syy : 0, n };
}

export function strength(fit) {
  if (!fit) return "none";
  const t = fit.se > 0 ? Math.abs(fit.slope / fit.se) : (fit.slope ? Infinity : 0);
  return t >= 2 ? "clear" : t >= 1.2 ? "possible" : "none";
}

const doyText = d => new Date(Date.UTC(2021, 0, Math.round(d))).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const METRICS = [
  { key: "last_spring_frost_doy", label: "Last spring frost", unit: "days", good: -1,
    say: (d, s) => `${s === "none" ? "No clear change in" : "The"} last spring frost${s === "none" ? "" : ` is coming ${Math.abs(r(d, 0))} days ${d < 0 ? "earlier" : "later"} per decade`}` },
  { key: "first_fall_frost_doy", label: "First fall frost", unit: "days", good: 1,
    say: (d, s) => `${s === "none" ? "No clear change in" : "The"} first fall frost${s === "none" ? "" : ` is coming ${Math.abs(r(d, 0))} days ${d > 0 ? "later" : "earlier"} per decade`}` },
  { key: "frost_free_days", label: "Frost-free season", unit: "days", good: 1,
    say: (d, s) => `${s === "none" ? "No clear change in the" : "The"} frost-free season${s === "none" ? "" : ` is ${d > 0 ? "growing" : "shrinking"} by about ${Math.abs(r(d, 0))} days per decade`}` },
  { key: "season_gdd50", label: "Summer heat (GDD)", unit: "GDD", good: 1,
    say: (d, s, k = 1) => `${s === "none" ? "No clear change in summer heat" : `Summer heat is ${d > 0 ? "rising" : "falling"} by about ${Math.abs(r(d * k / 10, 0)) * 10} degree days per decade`}` },
];

/**
 * Trends across per-year climate summaries ({year, ...} from risk.perYearClimates).
 * Returns null if there are fewer than 8 usable years.
 */
export function climateShift(climates, { gddFactor = 1 } = {}) {
  if (!Array.isArray(climates) || climates.length < 8) return null;
  const first = climates[0].year, last = climates[climates.length - 1].year;
  const metrics = METRICS.map(m => {
    const pts = climates.filter(c => Number.isFinite(c[m.key])).map(c => [c.year, c[m.key]]);
    const fit = linreg(pts.map(p => p[0]), pts.map(p => p[1]));
    const s = pts.length >= 8 ? strength(fit) : "none";
    const perDecade = fit ? fit.slope * 10 : 0;
    const startFit = fit ? fit.intercept + fit.slope * first : null, endFit = fit ? fit.intercept + fit.slope * last : null;
    return {
      key: m.key, label: m.label, unit: m.unit, strength: s, per_decade: r(perDecade), favourable: s !== "none" && Math.sign(perDecade) === m.good,
      points: pts.map(([year, v]) => ({ year, value: v })),
      from: startFit, to: endFit, text: m.say(perDecade, s, gddFactor),
      from_label: m.key.endsWith("_doy") && startFit ? doyText(startFit) : null, to_label: m.key.endsWith("_doy") && endFit ? doyText(endFit) : null,
    };
  });
  const by = Object.fromEntries(metrics.map(m => [m.key, m]));
  const ideas = [];
  const season = by.frost_free_days, spring = by.last_spring_frost_doy, fall = by.first_fall_frost_doy, heat = by.season_gdd50;
  if (season.strength !== "none" && season.per_decade > 0) ideas.push("A longer season leaves room for a second planting: sow lettuce, spinach or radishes again after early crops come out, or try longer-season tomato and pepper varieties.");
  if (spring.strength !== "none" && spring.per_decade < 0) ideas.push("Spring frost is coming earlier than older planting guides assume. Your calendar already uses recent years, so trust its dates over the seed packet.");
  if (fall.strength !== "none" && fall.per_decade > 0) ideas.push("Fall frost is coming later: a late-summer sowing of beans or a fall crop of greens has more time to finish.");
  if (heat.strength !== "none" && heat.per_decade > 0) ideas.push("Summers are getting hotter: give lettuce and spinach afternoon shade, water early in the day, and favour heat-tolerant varieties.");
  if (season.strength !== "none" && season.per_decade < 0) ideas.push("The season is getting shorter here: choose quick-maturing varieties and start warm crops indoors.");
  if (!ideas.length) ideas.push("Your season has been steady. Year-to-year swings matter more here than any trend, which is what Good year, bad year on Garden ROI is for.");
  const changing = metrics.filter(m => m.strength !== "none");
  const headline = changing.length ? changing[0].text + "." : "Your growing season hasn't shifted in a way that stands out from normal year-to-year swings.";
  return { first, last, years: climates.length, metrics, headline, ideas,
    caveat: `Based on ${climates.length} seasons (${first}-${last}) at your spot. That's short for climate, so treat these as hints, not forecasts.` };
}
