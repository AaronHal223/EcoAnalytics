# EcoAnalytics

**Your soil, your season, your dollars.** Soil-first, economics-first analytics for backyard growers.

EcoAnalytics figures out what's in your soil without you typing a single number, then answers the money questions every backyard grower has: which crops actually pay off in *this* yard, what watering really costs, the cheapest way to fix your soil, and whether the garden is earning its keep.

It deliberately does **not** track livestock or egg counts. Those depend on daily manual logging that's rarely complete; everything here comes from published soil surveys, real local weather history and store prices.

---

## What it does

| Tab | What you get |
|---|---|
| **Soil** | pH, organic matter, nutrient-holding capacity (CEC), texture, estimated phosphorus and potassium. Each number shows its ideal range for vegetables, the spread across nearby survey points, and a high/medium/low confidence rating. |
| **Crop value** | All 19 crops ranked by **net dollars per square foot per year** in your soil and season, after seeds/plants, water and nitrogen. One click adds a crop to your plan. |
| **Garden ROI** | Build a bed-by-bed plan and see harvest value at store prices, yearly cost, net savings, return %, cost per pound grown, and payback time on setup costs. |
| **Water cost** | Month-by-month irrigation you'll need beyond rainfall, in gallons and dollars on your water rate, plus what switching to drip would save. |
| **Fertilizer plan** | The cheapest **whole-bag** shopping list that meets your plan's N-P-K needs (solved as a mixed-integer program), plus lime or sulfur for pH and compost for organic matter. Organic-only mode included. |

## How the soil gets researched

You never enter soil numbers (unless you want to). The app:

1. **Finds the garden.** It starts from your internet connection's location. If that looks like a VPN, it says so and asks for an address instead. Three independent signals trigger this:
   - the IP is a known VPN, proxy or Tor exit,
   - the IP belongs to a data centre (home internet never does),
   - your device's clock timezone doesn't match the IP's timezone (a VPN moves your IP, not your laptop's clock).

   You can always refine with a **street address** (US Census geocoder), a **ZIP code**, or **device GPS**.

2. **Samples a ring of points and averages them.** One map point is a guess, so it queries the USDA soil survey at the centre plus six points around it. The ring is sized to how sure the location is:

   | Location from | Ring radius |
   |---|---|
   | Device GPS or street address | 0.3 km |
   | ZIP code | 2 km |
   | IP address | 6 km |

   Values are averaged depth-weighted over the top 30 cm (the root zone), weighted by each soil component's share of the map unit, with the centre counting double. How much the points disagree lowers the confidence score.

3. **Is honest about what can't be mapped.** Plant-available phosphorus and potassium depend on what's been spread on your yard in past years, so they're estimated from texture, organic matter and CEC and always marked low-confidence. Enter a real soil test and those numbers take over everywhere.

### Data sources (all free, no API keys)

| Source | Used for |
|---|---|
| [USDA NRCS Soil Data Access (SSURGO)](https://sdmdataaccess.sc.egov.usda.gov) | pH, organic matter, CEC, sand/silt/clay |
| [ISRIC SoilGrids 2.0](https://soilgrids.org) | Total nitrogen; backup for everything where the survey has no data (e.g. "Urban land") |
| [Open-Meteo historical weather](https://open-meteo.com) | 3 years of daily temperature, rain and evapotranspiration: frost dates, growing degree days, irrigation needs |
| [US Census geocoder](https://geocoding.geo.census.gov) | Street address to coordinates |
| [Zippopotam.us](https://zippopotam.us) | ZIP code to coordinates |
| [ip-api.com](https://ip-api.com) | IP location and VPN/data-centre flags |

If any service is down, the app falls back gracefully (SoilGrids, then regional soil averages; latitude-based climate) and tells you it did.

## Run it

Requires Python 3.10+.

```bash
git clone https://github.com/AaronHal223/EcoAnalytics.git
cd EcoAnalytics
pip install -r requirements.txt
uvicorn backend.app:app --reload
```

Open **http://localhost:8000**. Running it on your own computer means the IP lookup sees your real home connection.

No internet, or just want to look around? `ECO_OFFLINE=1 uvicorn backend.app:app` runs on built-in regional estimates.

### Tests

```bash
pytest
```

43 tests cover location and VPN detection, soil parsing and averaging, the texture triangle, climate summaries, every economics tool, and the API. All outside services are replaced with realistic canned responses, so tests never touch the network.

## Make it yours

Every price and yield is plain JSON you can edit:

- `backend/data/crops.json`: yield per sq ft, store price per lb, seed/plant cost, water use, pH range and season for each crop
- `backend/data/amendments.json`: fertilizer analyses and bag prices, lime, sulfur, compost

Your water rate (check your bill, it's listed per 1,000 gallons or per CCF; 1 CCF = 748 gallons), watering method, setup cost and plan are set in the dashboard and remembered in your browser.

## API

| Endpoint | Purpose |
|---|---|
| `POST /api/locate` | `{"method": "ip" \| "zip" \| "address" \| "device", ...}` returns a location with precision and VPN flags |
| `POST /api/analyze` | Location + plan + settings returns soil, climate, crop ranking and ROI (with water and fertilizer plans) |
| `GET /api/crops` | Crop list |
| `GET /docs` | Interactive API docs |

## Project layout

```
backend/
  app.py          FastAPI routes, serves the dashboard
  geo.py          IP / ZIP / address / GPS location, VPN detection
  soil.py         Soil research: SSURGO + SoilGrids, ring averaging, confidence
  climate.py      Frost dates, growing degree days, rain and ET from weather history
  economics.py    Crop ranking, water cost, fertilizer optimizer, ROI
  http.py         Shared HTTP client, offline switch
  data/           Editable crop and amendment tables
dashboard/
  index.html      Single-page dashboard (no build step)
tests/            pytest suite
```

## Limits worth knowing

- Soil surveys describe **native** soil. Raised beds filled with bagged mix, or yards built on construction fill, can be very different. A $15-25 soil test from your state's extension office is the single best upgrade.
- Prices are typical US supermarket and garden-center values. Edit them to match yours.
- US only (USDA soil survey, Census geocoder).
