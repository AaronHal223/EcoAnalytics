"""Shared fixtures: canned responses shaped exactly like each real service,
routed by URL so no test ever touches the network."""
from __future__ import annotations

import datetime as dt
import math
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("ECO_OFFLINE", "0")

from backend import climate, geo, soil  # noqa: E402

SDA_HEADER = ["comppct_r", "compname", "hzdept_r", "hzdepb_r", "ph1to1h2o_r", "om_r",
              "cec7_r", "sandtotal_r", "silttotal_r", "claytotal_r"]


def sda_table(ph=6.0, om=3.0, cec=12.0, sand=40.0, silt=40.0, clay=20.0):
    """One map unit, two components (85% / 15%), two horizons each in 0-30 cm."""
    return {"Table": [
        SDA_HEADER,
        ["85", "Downer", "0", "20", str(ph), str(om), str(cec), str(sand), str(silt), str(clay)],
        ["85", "Downer", "20", "50", str(ph + 0.2), str(om / 3), str(cec), str(sand), str(silt), str(clay)],
        ["15", "Urban land", "0", "200", None, None, None, None, None, None],
    ]}


def soilgrids_payload(ph10=62, soc=180, nitrogen=210, clay=200, sand=400, silt=400, cec=150):
    def layer(name, d, mean):
        return {"name": name, "unit_measure": {"d_factor": d},
                "depths": [{"label": lab, "values": {"mean": mean}} for lab in ("0-5cm", "5-15cm", "15-30cm")]}
    return {"type": "Feature", "properties": {"layers": [
        layer("phh2o", 10, ph10), layer("soc", 10, soc), layer("nitrogen", 100, nitrogen),
        layer("clay", 10, clay), layer("sand", 10, sand), layer("silt", 10, silt), layer("cec", 10, cec)]}}


def open_meteo_daily(years=(2023, 2024, 2025), spring_frost_doy=105, fall_frost_doy=290):
    t, tmax, tmin, pr, et = [], [], [], [], []
    for y in years:
        d = dt.date(y, 1, 1)
        while d.year == y:
            doy = d.timetuple().tm_yday
            season = math.cos(2 * math.pi * (doy - 200) / 365)
            hi = 62 + 24 * season
            lo = 44 + 22 * season
            if doy == spring_frost_doy or doy == fall_frost_doy:
                lo = 30.0
            elif spring_frost_doy < doy < fall_frost_doy:
                lo = max(lo, 36.0)
            elif doy < spring_frost_doy or doy > fall_frost_doy:
                lo = min(lo, 31.0)
            t.append(d.isoformat()); tmax.append(hi); tmin.append(lo)
            pr.append(2.8)                                   # ~3.3 in / month
            et.append(max(0.4, 3.0 + 2.5 * season))          # mm/day, summer peak
            d += dt.timedelta(days=1)
    return {"daily": {"time": t, "temperature_2m_max": tmax, "temperature_2m_min": tmin,
                      "precipitation_sum": pr, "et0_fao_evapotranspiration": et}}


@pytest.fixture
def fake_net(monkeypatch):
    """Routes every outside call to canned data. Tests can tweak `state`."""
    state = {"sda": sda_table(), "soilgrids": soilgrids_payload(),
             "ip": {"status": "success", "query": "73.1.2.3", "country": "United States",
                    "countryCode": "US", "regionName": "New Jersey", "region": "NJ",
                    "city": "Bellmawr", "zip": "08031", "lat": 39.867, "lon": -75.094,
                    "timezone": "America/New_York", "proxy": False, "hosting": False, "mobile": False},
             "calls": []}

    def get_json(url, params=None, retries=1):
        state["calls"].append(url)
        if "ip-api.com" in url:
            return state["ip"]
        if "zippopotam" in url:
            return {"post code": "08031", "places": [{"place name": "Bellmawr", "state abbreviation": "NJ",
                                                       "latitude": "39.8673", "longitude": "-75.0946"}]}
        if "geocoding.geo.census.gov" in url:
            return {"result": {"addressMatches": [{
                "matchedAddress": "100 MAIN ST, BELLMAWR, NJ, 08031",
                "coordinates": {"x": -75.0941, "y": 39.8661},
                "addressComponents": {"zip": "08031", "state": "NJ"}}]}}
        if "soilgrids" in url:
            return state["soilgrids"]
        if "open-meteo" in url:
            return open_meteo_daily()
        raise AssertionError(f"unexpected GET {url}")

    def post_json(url, payload, retries=1):
        state["calls"].append(url)
        assert "sdmdataaccess" in url
        return state["sda"]

    monkeypatch.setenv("ECO_OFFLINE", "0")
    for mod in (geo, soil, climate):
        if hasattr(mod, "get_json"):
            monkeypatch.setattr(mod, "get_json", get_json)
        if hasattr(mod, "post_json"):
            monkeypatch.setattr(mod, "post_json", post_json)
    climate._fetch.cache_clear()
    return state


@pytest.fixture
def nj_address():
    return geo.Location(lat=39.8661, lon=-75.0941, source="address", precision_km=0.1,
                        label="100 Main St, Bellmawr, NJ", zip="08031", state="NJ")
