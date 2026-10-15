"""Local climate from real weather history.

Pulls the last three complete years of daily weather for the garden's point
from the Open-Meteo historical archive (free, no key, ERA5-based) and turns
them into what a grower actually needs:

* frost-free season length (median of the 3 years, last spring / first fall
  32 F night),
* growing degree days (base 50 F) inside that season, for warm-season crops,
* cool-season growing days (days with mean temperature 40-75 F),
* monthly rainfall and reference evapotranspiration (ET0, how much water a
  well-watered crop loses), which drive the water-cost model.

Three years, not one: a single odd year (a late May frost) shouldn't decide
what someone plants.
"""
from __future__ import annotations

import datetime as dt
import math
import statistics
from dataclasses import asdict, dataclass, field
from functools import lru_cache
from typing import Optional

from .http import SourceUnavailable, get_json

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
MM_PER_IN = 25.4
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


@dataclass
class Climate:
    frost_free_days: int
    last_spring_frost: Optional[str]   # "Apr 18" (median), None if frost-free year-round
    first_fall_frost: Optional[str]
    season_gdd50: float
    cool_growing_days: int
    monthly_precip_in: list[float]
    monthly_et0_in: list[float]
    monthly_tmean_f: list[float]
    monthly_active_frac_warm: list[float]  # share of each month inside the frost-free window
    monthly_active_frac_cool: list[float]  # share of each month with cool-crop temperatures
    annual_precip_in: float
    years: list[int]
    source: str
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["months"] = MONTHS
        return d


def _doy_label(doy: float, year: int = 2023) -> str:
    d = dt.date(year, 1, 1) + dt.timedelta(days=int(round(doy)) - 1)
    return d.strftime("%b %d").replace(" 0", " ")


def summarize(daily: dict, years: list[int]) -> Climate:
    """Pure function over Open-Meteo `daily` arrays (Fahrenheit, mm)."""
    times = [dt.date.fromisoformat(t) for t in daily["time"]]
    tmax = daily["temperature_2m_max"]
    tmin = daily["temperature_2m_min"]
    prcp = daily["precipitation_sum"]
    et0 = daily["et0_fao_evapotranspiration"]

    springs, falls, seasons, gdds, cools = [], [], [], [], []
    m_prcp = [[0.0] * 12 for _ in years]
    m_et0 = [[0.0] * 12 for _ in years]
    m_temp: list[list[float]] = [[] for _ in range(12)]
    m_cool_days = [0] * 12
    m_days = [0] * 12

    for yi, y in enumerate(years):
        idx = [i for i, t in enumerate(times) if t.year == y]
        last_spring, first_fall = None, None
        for i in idx:
            t = times[i]
            lo, hi = tmin[i], tmax[i]
            if lo is None or hi is None:
                continue
            doy = t.timetuple().tm_yday
            if lo <= 32.0:
                if t.month < 7:
                    last_spring = doy
                elif first_fall is None:
                    first_fall = doy
            mean = (lo + hi) / 2
            m_temp[t.month - 1].append(mean)
            m_days[t.month - 1] += 1
            if 40.0 <= mean <= 75.0:
                m_cool_days[t.month - 1] += 1
            m_prcp[yi][t.month - 1] += (prcp[i] or 0.0)
            m_et0[yi][t.month - 1] += (et0[i] or 0.0)

        days_in_year = 366 if y % 4 == 0 else 365
        sp = last_spring or 0
        fa = first_fall or days_in_year + 1
        springs.append(sp)
        falls.append(fa)
        seasons.append(max(0, fa - sp - 1))
        g = c = 0
        for i in idx:
            if tmin[i] is None or tmax[i] is None:
                continue
            doy = times[i].timetuple().tm_yday
            mean = (tmin[i] + tmax[i]) / 2
            if sp < doy < fa:
                g += max(0.0, min(tmax[i], 86.0) / 2 + max(tmin[i], 50.0) / 2 - 50.0)
            if 40.0 <= mean <= 75.0:
                c += 1
        gdds.append(g)
        cools.append(c)

    ny = len(years)
    precip = [round(sum(m_prcp[y][m] for y in range(ny)) / ny / MM_PER_IN, 2) for m in range(12)]
    et0m = [round(sum(m_et0[y][m] for y in range(ny)) / ny / MM_PER_IN, 2) for m in range(12)]
    tmean = [round(statistics.fmean(v), 1) if v else float("nan") for v in m_temp]

    sp_med, fa_med = statistics.median(springs), statistics.median(falls)
    frost_free = int(statistics.median(seasons))
    warm_frac = _window_fraction(sp_med, fa_med)
    cool_frac = [round(m_cool_days[m] / m_days[m], 2) if m_days[m] else 0.0 for m in range(12)]

    return Climate(
        frost_free_days=frost_free,
        last_spring_frost=_doy_label(sp_med) if sp_med > 0 else None,
        first_fall_frost=_doy_label(fa_med) if fa_med <= 365 else None,
        season_gdd50=round(statistics.median(gdds)),
        cool_growing_days=int(statistics.median(cools)),
        monthly_precip_in=precip, monthly_et0_in=et0m, monthly_tmean_f=tmean,
        monthly_active_frac_warm=warm_frac, monthly_active_frac_cool=cool_frac,
        annual_precip_in=round(sum(precip), 1), years=years,
        source="Open-Meteo historical weather (ERA5), " + f"{years[0]}-{years[-1]}",
    )


def _window_fraction(start_doy: float, end_doy: float) -> list[float]:
    """Share of each month's days that fall strictly between two days of year."""
    out = []
    month_starts = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335, 366]
    for m in range(12):
        a, b = month_starts[m], month_starts[m + 1]  # [a, b)
        overlap = max(0.0, min(b, end_doy) - max(a, start_doy + 1))
        out.append(round(overlap / (b - a), 2))
    return out


@lru_cache(maxsize=256)
def _fetch(lat_r: float, lon_r: float, start: str, end: str) -> dict:
    return get_json(ARCHIVE_URL, params={
        "latitude": lat_r, "longitude": lon_r, "start_date": start, "end_date": end,
        "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum,et0_fao_evapotranspiration",
        "temperature_unit": "fahrenheit", "precipitation_unit": "mm", "timezone": "auto",
    })


def get_climate(lat: float, lon: float, today: Optional[dt.date] = None) -> Climate:
    today = today or dt.date.today()
    years = [today.year - 3, today.year - 2, today.year - 1]
    try:
        data = _fetch(round(lat, 2), round(lon, 2), f"{years[0]}-01-01", f"{years[-1]}-12-31")
        return summarize(data["daily"], years)
    except (SourceUnavailable, KeyError, TypeError, statistics.StatisticsError):
        return fallback_climate(lat, years)


def fallback_climate(lat: float, years: list[int]) -> Climate:
    """Latitude-only approximation, used when Open-Meteo can't be reached."""
    a = abs(lat)
    ffd = int(max(90, min(365, 365 - (a - 25) * 11.0)))
    # The frost-free window is centred a little after the solstice (mid-July).
    sp = max(0.0, 197 - ffd / 2)
    fa = min(366.0, 197 + ffd / 2)
    # ET0 and temperature follow a seasonal sine wave peaking mid-July.
    peak_et0 = 6.5 - (a - 30) * 0.05
    et0 = [round(max(0.6, peak_et0 * (0.55 + 0.45 * math.cos(2 * math.pi * (m - 6) / 12))), 2)
           for m in range(12)]
    temp = [round(75 - (a - 30) * 0.9 - (22 + (a - 30) * 0.5) * (1 - math.cos(2 * math.pi * (m - 6) / 12)) / 2, 1)
            for m in range(12)]
    cool = [1.0 if 40 <= t <= 75 else 0.0 for t in temp]
    return Climate(
        frost_free_days=ffd,
        last_spring_frost=_doy_label(sp) if sp > 0 else None,
        first_fall_frost=_doy_label(fa) if fa <= 365 else None,
        season_gdd50=round(ffd * max(5.0, 22 - (a - 30) * 0.5)),
        cool_growing_days=int(sum(c * 30.4 for c in cool)),
        monthly_precip_in=[3.3] * 12, monthly_et0_in=et0, monthly_tmean_f=temp,
        monthly_active_frac_warm=_window_fraction(sp, fa), monthly_active_frac_cool=cool,
        annual_precip_in=39.6, years=years, source="Latitude estimate (weather service unreachable)",
        notes=["Weather history couldn't be loaded; season and water numbers are rough estimates."],
    )
