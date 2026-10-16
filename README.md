# EcoAnalytics

**Your soil, your season, your dollars.** Soil-first, economics-first analytics for backyard growers.

EcoAnalytics works out what's in your soil without you typing a single number, then answers the money questions every backyard grower has: which crops actually pay off in *this* yard, what watering really costs, the cheapest way to fix your soil, and whether the garden is earning its keep.

It deliberately does **not** track livestock or egg counts. Those depend on daily manual logging that's rarely complete. Everything here comes from published soil surveys, real local weather history and store prices.

## One site, website and app

It's a single static website that adapts to the screen:

| Screen | Layout |
|---|---|
| Computer / tablet (wider than 760px) | Website: leafy hero header, pill tabs on top, cards side by side, full data tables |
| Phone (760px or narrower) | App: compact sticky header, bottom tab bar, collapsible location, card lists instead of tables |
| Added to a phone's home screen | Runs full-screen with its own icon like a native app, and opens instantly (offline-ready shell) |

No app store and no separate codebase. On Android/Chrome an **Install app** button appears in the header. On iPhone it's Share, then **Add to Home Screen**.

## What it does

| Tab | What you get |
|---|---|
| **Soil** | pH, organic matter, nutrient-holding capacity (CEC), texture, estimated phosphorus and potassium. Each shows its ideal range for vegetables, the spread across nearby survey points, and a high/medium/low confidence rating. |
| **Crop value** | All 19 crops ranked by **net dollars per square foot per year** in your soil and season, after seeds/plants, water and nitrogen. One tap adds a crop to your plan. |
| **Garden ROI** | Bed-by-bed plan with size sliders: harvest value at store prices, yearly cost, net savings, return %, cost per pound, payback time. Updates live as you drag. |
| **Water cost** | Month-by-month irrigation beyond rainfall in gallons and dollars. Try hose vs. drip vs. sprinkler and drag your water rate to see the effect instantly. Tap or hover any bar for its value. |
| **Fertilizer plan** | The cheapest **whole-bag** shopping list that covers your plan's N-P-K needs (solved as a mixed-integer program), plus lime or sulfur for pH and compost for organic matter. Organic-only mode included. |

## How the soil gets researched

1. **Find the garden.** Starts from your internet connection's location. If that looks like a VPN, the site says so and asks for an address instead. It checks for:
   - a VPN or proxy provider's network,
   - a data-centre network (home internet never comes from one),
   - your device clock's timezone not matching the connection's timezone (a VPN moves your IP, not your laptop's clock).

   You can always refine with a **street address**, **ZIP code**, or **device GPS**.

2. **Sample a ring of points and average them.** One map point is a guess, so it queries the USDA soil survey at the centre plus six points around it, sized to how sure the location is:

   | Location from | Ring radius |
   |---|---|
   | Device GPS or street address | 0.3 km |
   | ZIP code | 2 km |
   | IP address | 6 km |

   Values are depth-weighted over the top 30 cm (the root zone) and weighted by each soil component's share of the map unit, with the centre counting double. When the points disagree, confidence drops.

3. **Be honest about what can't be mapped.** Plant-available phosphorus and potassium depend on what's been spread on your yard in past years, so they're estimated and always marked low-confidence. Enter a real soil test and those numbers take over everywhere.

Results are cached in your browser for 30 days, so return visits are instant and the public services aren't hammered.

### Data sources (all free, no API keys)

| Source | Used for |
|---|---|
| [USDA NRCS Soil Data Access (SSURGO)](https://sdmdataaccess.sc.egov.usda.gov) | pH, organic matter, CEC, sand/silt/clay |
| [ISRIC SoilGrids 2.0](https://soilgrids.org) | Total nitrogen; backup where the survey has no data (e.g. "Urban land") |
| [Open-Meteo historical weather](https://open-meteo.com) | 3 years of daily temperature, rain, evapotranspiration: frost dates, growing degree days, irrigation |
| [OpenStreetMap Nominatim](https://nominatim.org) | Street address to coordinates |
| [Zippopotam.us](https://zippopotam.us) | ZIP code to coordinates |
| [GeoJS](https://www.geojs.io) (backup: [ipapi.co](https://ipapi.co)) | Connection location and network owner |

Everything runs in the visitor's browser. If a service is down, the site falls back (SoilGrids, then regional soil averages; latitude-based climate) and says so on screen.

## Hosting (free)

The site is static (HTML, CSS, JavaScript) with no server and no build step, so it can be hosted for free.

### GitHub Pages (recommended: no card, never bills)

**One-time setup:** in this repo, go to **Settings**, then **Pages**, and under **Build and deployment** set **Source** to **GitHub Actions**. Then open the **Actions** tab and re-run the latest "deploy website" run (or push any change).

The site goes live at **https://aaronhal223.github.io/EcoAnalytics/**. After that, every push to `main` runs the tests and redeploys automatically ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)). If a test fails, the previous version stays live.

### Render (optional)

[`render.yaml`](render.yaml) also lets you host on Render instead (**New**, then **Blueprint**, pick this repo, **Deploy Blueprint**). Render's static hosting is free, but Render may ask for a card at sign-up and bills for traffic over 5 GB a month. Render also adds same-address routes (`/proxy/sda`, `/proxy/soilgrids/*`) that the site uses only if a browser blocks a direct call to the soil services.

## Run it locally

```bash
npm start            # serves public/ at http://localhost:8000
```

Add `?offline=1` to the URL to run on built-in estimates with no network calls.

## Tests

```bash
npm test
```

43 tests (Node's built-in runner, no dependencies) cover location and VPN detection, soil parsing and averaging, the texture triangle, the proxy fallback, climate summaries, every economics tool, and the site itself (every referenced file exists, HTTPS-only data sources). All outside services are replaced with realistic canned responses.

## Make it yours

Every price, yield and bag size is in [`public/js/data.js`](public/js/data.js): store price per lb, yield per sq ft, seed/plant cost, water use, pH range and season for each crop, and fertilizer analyses and bag prices. Your water rate (on your bill per 1,000 gallons, or per CCF, which is 748 gallons), watering method, setup cost and plan are set on the page and remembered in your browser.

## Project layout

```
public/                  <- everything that gets published
  index.html             page (both layouts)
  styles.css             nature palette, website + app layouts, dark mode, motion
  manifest.webmanifest   install-as-app details
  sw.js                  service worker: instant, offline-ready app shell
  icons/                 app icons
  js/
    app.js               page logic, layout switching, charts, interactions
    geo.js               IP / ZIP / address / GPS location, VPN detection
    soil.js              soil research: SSURGO + SoilGrids, ring averaging, confidence
    climate.js           frost dates, growing degree days, rain and ET from weather history
    economics.js         crop ranking, water cost, fertilizer optimizer, ROI
    data.js              editable crop and fertilizer tables
    net.js               shared fetch helper, offline switch
  vendor/lp-solver.js    javascript-lp-solver (public domain), used by the fertilizer optimizer
tests/                   node --test suite
render.yaml              Render hosting blueprint
```

## Limits worth knowing

- Soil surveys describe **native** soil. Raised beds filled with bagged mix, or yards built on construction fill, can be very different. A $15-25 soil test from your state's extension office is the single best upgrade.
- Prices are typical US supermarket and garden-center values. Edit them to match yours.
- US only (USDA soil survey).
