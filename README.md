# EcoAnalytics

**Your soil, your season, your dollars.** Soil-first, economics-first analytics for backyard growers.

Made by **Aaron Haldar**. Free for everyone, no account, no ads.

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
| **Calendar** | When to plant and harvest each crop, from your frost dates **adjusted for your soil**: heavy clay waits about a week, sandy soil can go in a few days early, and a pH far from a crop's range is flagged. A "right now" strip shows what's due today. |
| **Garden ROI** | Bed-by-bed plan with size sliders: harvest value at store prices, yearly cost, net savings, return %, cost per pound, payback time. Also **your time**: hours of work and what the garden pays per hour (optionally counted as a cost). Includes the optional **harvest log**. |
| **Water cost** | A **7-day watering plan** from the live forecast (water or skip each day, with gallons and dollars, plus a freeze warning for tender crops), then month-by-month irrigation beyond rainfall in gallons and dollars. Try hose vs. drip vs. sprinkler and drag your water rate to see the effect instantly. Tap or hover any bar for its value. |
| **Fertilizer plan** | The cheapest **whole-bag** shopping list that covers your plan's N-P-K needs (solved as a mixed-integer program), plus lime or sulfur for pH and compost for organic matter. Organic-only mode included. |
| **Journal** | A free **account** that saves your garden and follows you to any phone or computer, a **garden journal** the app writes for you every day (weather, this week's jobs, what you picked, what changed in your beds) that you can edit or add notes to, and a **garden assistant** (Google Gemini) that already knows your soil, beds and frost dates. Save any chat to the journal as a short summary. |
| **Guide** | A **problem solver** (yellow leaves, blossom-end rot, holes, mildew, bolting, no fruit…) with the cheapest fixes first and notes about *your* soil where they matter, plus a **growing guide** for every crop: spacing, watering, when it's ready, storage, good and bad neighbours, and the pests you'll actually meet. |

### What makes it different

- **Every number shows its working.** Tap the small **i** on any figure for its source, formula, inputs and confidence (`js/provenance.js`).
- **Soil-aware planning.** Calendars elsewhere use frost dates only. This one also uses your soil (`js/planner.js`).
- **Full-cost ROI.** Seeds, soil, water, setup and, if you want, your time.
- **Watering saved, in dollars.** Rain you can count on means a skipped watering, measured against a timer that ignores rain (`js/forecast.js`).
- **Sun, measured at each bed.** Tap the sun button on a bed and either sweep your phone's camera along the skyline (the compass and tilt sensors trace trees and roofs; nothing is recorded or uploaded) or answer five "how tall do obstacles look" questions. The app traces the sun's real path for your latitude and counts hours of direct sun, and each crop's yield scales with what it gets: tomatoes need about 8 hours, lettuce about 4 (`js/sun.js`).
- **Good year, bad year.** Your plan is replayed through each of the last 15 seasons of real local weather with the same models. You see the odds ("paid off in 13 of 15 seasons"), a bad (1-in-10) year, a typical year and the best, and every crop gets a range. Rank by "Bad year (safest)" to favour crops that hold up (`js/risk.js`).
- **Plan it for me.** Give it your space and sun; it fills it with the crops that pay best here in a typical year *and* a bad one, no more than a quarter of the space each.
- **Companion check.** Flags pairs traditionally kept apart (tomatoes and potatoes share blight) and points out good neighbours. Shown as tips only; the evidence is mixed, so they never change your numbers (`js/guide.js`).
- **Reminders in your own calendar.** One tap saves your plan's planting and harvest dates as a calendar file with an alert the day before. Works with Apple, Google and Outlook; no notifications service needed.
- **Share a plan as a link.** The plan travels after the `#` in the link, which is never sent to any server. Whoever opens it sees it worked out for *their* soil and weather (`js/share.js`).
- **Your data stays yours.** No tracking, no ads. The account is optional: without it everything stays on the phone, and you can still save a backup file and restore it on another phone.
- **Account and sync, free.** Sign up with an email and password (nothing to confirm, nothing to pay). Every change is saved to your account a few seconds later; opening the app on another device brings the latest copy down, and journal notes written on two devices are both kept. A recovery code shown once at sign-up resets a forgotten password, so no email service is needed (`js/account.js`, `server/api`).
- **A journal that writes itself.** Once a day the app records the weather, the top jobs this week, harvests since the last entry and changes to your beds. Until you edit it, today's entry keeps itself up to date; once you edit it, it's yours (`js/journal.js`).
- **Garden assistant.** Ask about your own garden in plain words; it's given your town (never the street), soil, beds, frost dates, this week's jobs and recent journal lines. Opt-in, 20 questions a day each. It runs on Google's free Gemini tier, which Google may use to improve its products, so the page asks people to agree first and not type anything private.
- **This week in your garden.** The 7-day forecast, your planting calendar and the watering plan become a short to-do list for the beds you actually have: cover the peppers before Thursday's frost, water early before the heat, skip watering because heavy rain is coming, check stakes before the wind, last week to plant lettuce. Most urgent first (`js/weekly.js`).
- **Yard map.** Drag beds to where they really are and resize them; each one shows a square-foot grid with how many plants fit. Because the app knows where beds sit, it warns when traditionally bad neighbours actually touch and when a tall crop (tomatoes, corn, trellised peas) will shade a shorter bed just north of it (`js/yard.js`).
- **Test-strip reader.** Photograph a cheap pH strip or capsule kit *next to its colour chart*, tap the test and the chart colours, and the phone reads it, comparing colours in CIELAB under the same light. The reading goes straight into your soil test and every number updates. The photo never leaves the phone (`js/strip.js`).
- **How your season is changing.** The 15 past seasons also show trends at your exact spot: last spring frost, first fall frost, season length and summer heat, with a straight-line trend that only counts when it stands out from normal year-to-year swings, and what it means for what you plant (`js/trend.js`).
- **Ready for the world.** Metric units (°C, kg, m², L) chosen automatically outside the US or with one tap; addresses and postcodes anywhere (soil comes from ISRIC SoilGrids outside the US); a short first-run tour (`js/units.js`).
- **Frost and heat alerts on the phone, with no server.** On Android (Chrome, app added to the home screen) the phone wakes the app about twice a day, checks a free 3-day forecast and warns before frost, a hard freeze or a heat wave for the crops in your beds (`alerts-core.js`, `sw.js`). iPhones don't allow background checks for web apps, so there the weekly list and calendar reminders do the job.
- **Works south of the equator.** Frost dates, season length, planting windows and summer heat all handle a growing season that runs across New Year (Australia, New Zealand, South Africa, South America).
- **29 crops, your own prices, your currency.** Ten more crops (eggplant, winter squash, pole beans, sweet potatoes, cantaloupe, broccoli, cabbage, arugula, cilantro, parsley). Enter what your store charges and every number follows. Money shows in 20 currencies at today's European Central Bank rate (`js/currency.js`).
- **Simple view.** New visitors see just where they are, what to plant and this week; one tap shows everything.
- **Spanish.** The interface, weekly list, tour, problem solver and explanations on the main screens are in Spanish (`js/i18n.js`, `js/lang-es.js`). The per-crop growing details are still in English.
- **Accessible.** Checked with axe-core on every tab, light and dark: colour contrast, headings, landmarks, labels and keyboard access to scrolling areas.
- **It learns your yard.** Log pounds picked, press **Finish season**, and that crop's yield is scaled by what you actually got (clamped, averaged over the last three seasons, never compounding on itself). Logging is optional (`js/calibration.js`).

The watering model, calendar shifts and labor hours are simple rules of thumb, and each says so in its **i** sheet. The labor default (1 hour per week per 100 sq ft) is an assumption you should change.

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
| [Open-Meteo forecast](https://open-meteo.com/en/docs) | Next 7 days (plus 2 past days): the watering plan and freeze warnings. Cached 2 hours; if it's unreachable the card says so and nothing else is affected |
| [Open-Meteo historical weather](https://open-meteo.com), 15 years | Good year / bad year: each past season replayed through the plan. Loaded after everything else and cached 30 days |
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

### The account server (free)

Accounts, sync and the assistant run on a small [Neon](https://neon.tech) function (`server/api`, free plan: Postgres plus Functions) at `https://br-silent-scene-bdsrlorq-api.compute.c-8.us-east-2.aws.neon.tech`. It has no npm dependencies: passwords are hashed with scrypt, sign-in uses random tokens (no cookies, so Safari works), and logins and sign-ups are rate-limited. Only `aaronhal223.github.io` and `localhost` may call it.

To switch the assistant on, create a free Gemini API key at [Google AI Studio](https://aistudio.google.com/apikey) (no card) and set it as the function's `GEMINI_API_KEY` environment variable in Neon. Never put the key in this repo. Without a key, accounts, sync and the journal still work and the assistant says it isn't switched on yet.

## Run it locally

```bash
npm start            # serves public/ at http://localhost:8000
```

Add `?offline=1` to the URL to run on built-in estimates with no network calls.

## Tests

```bash
npm test
```

Over 140 tests (Node's built-in runner, no dependencies) cover the account server (sign-up, sign-in, recovery, sync, throttling, the assistant), sync merging and the daily journal, southern-hemisphere seasons, phone alerts, currency, Spanish, the season report, the sun compass check, the weekly to-do list, season trends, yard layout and shade checks, strip colour reading, metric conversion, the sun path and skyline maths, sun-adjusted yields, past-season risk and Plan it for me, the crop guide and companion check, plan links, the calendar file, backup and restore, location and VPN detection, soil parsing and averaging, the texture triangle, the proxy fallback, climate summaries, every economics tool, the planting calendar, the watering model, harvest calibration, the source explanations, and the site itself (every referenced file exists, every element the script looks up is in the page, service worker caches every module, HTTPS-only data sources). All outside services are replaced with realistic canned responses.

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
    planner.js           soil-aware planting calendar
    forecast.js          7-day forecast, watering plan, freeze warning
    calibration.js       harvest log and per-crop yield calibration
    sun.js               sun path, skyline from camera scan or estimate, sun hours, crop sun needs
    risk.js              15 past seasons: crop ranges, plan odds, "Plan it for me"
    guide.js             crop guide, companion check, problem solver
    share.js             plan links, calendar (.ics) file, backup and restore
    account.js           free account: sign-in, sync to the server, merging two devices
    journal.js           daily journal entries, notes, what the garden assistant is told
    weekly.js            this week's to-do list from forecast, calendar and watering plan
    trend.js             season trends across 15 past years
    yard.js              yard map layout, plant counts, neighbour and shade checks
    strip.js             test-strip colour reading (CIELAB) against the kit's chart
    units.js             metric display and input conversion
    provenance.js        "where this number comes from" explanations
    economics.js         crop ranking, water cost, fertilizer optimizer, ROI, labor
    data.js              editable crop and fertilizer tables
    net.js               shared fetch helper, offline switch
  vendor/lp-solver.js    javascript-lp-solver (public domain), used by the fertilizer optimizer
server/api/              account + assistant server (a Neon function): app.mjs routes, index.mjs database
tests/                   node --test suite
render.yaml              Render hosting blueprint
```

## Beta testing

The yields and prices are typical figures, so the most valuable thing is real harvests. To run a beta: ask 10-20 growers to plan their beds, log what they pick in **Harvest log**, and at the end of the season tap **Season report for testers** and send the file. Each row is predicted vs. actual pounds for one crop, with sun hours, soil texture and pH, frost-free days and heat, and the location rounded to about 50 km. Comparing rows across gardens shows which crops' `yield_lb_per_sqft` in `public/js/data.js` need adjusting.

For the camera tools: on each test phone, open a bed's sun button, tap **Check compass with the sun** (the app knows exactly where the sun is, so this measures and corrects compass error), then sweep. For the strip reader, test with real kits in daylight and compare against the kit's chart by eye.

## Free and open

EcoAnalytics is free for anyone, with no account, ads or tracking, and the code is open under the [MIT licence](LICENSE). It costs nothing to run: a static site on GitHub Pages, using only free public data services. Corrections to prices, yields and the crop guide are especially welcome: everything lives in `public/js/data.js` and `public/js/guide.js`.

## Limits worth knowing

- Soil surveys describe **native** soil. Raised beds filled with bagged mix, or yards built on construction fill, can be very different. A $15-25 soil test from your state's extension office is the single best upgrade.
- Prices are typical US supermarket and garden-center values. Edit them to match yours.
- Soil is most detailed in the US (USDA soil survey); elsewhere it comes from global 250 m soil maps, so a soil test matters more. Prices are typical US prices.
- English and Spanish only; the per-crop growing details are English in both. Phones' built-in page translation covers other languages.
- Phone alerts work on Android only (an iPhone limit for web apps).
- The camera scan needs a phone that shares its compass with web pages (iPhone Safari and Android Chrome do). Elsewhere use the quick estimate.
- Good year / bad year varies the weather only. Pests, hail and a busy summer can also cost a harvest.
