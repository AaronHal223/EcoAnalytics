import datetime as dt

import pytest

from backend import climate, economics as eco, soil
from tests.conftest import open_meteo_daily, sda_table


@pytest.fixture
def cl():
    return climate.summarize(open_meteo_daily()["daily"], [2023, 2024, 2025])


@pytest.fixture
def nj_soil(fake_net, nj_address):
    return soil.research_soil(nj_address)


def test_climate_frost_dates(cl):
    assert cl.last_spring_frost == "Apr 15"
    assert 180 <= cl.frost_free_days <= 186
    assert cl.season_gdd50 > 1000
    assert sum(cl.monthly_precip_in) == pytest.approx(cl.annual_precip_in, abs=0.1)
    assert max(cl.monthly_et0_in) > min(cl.monthly_et0_in)  # summer peak


def test_climate_falls_back_offline(monkeypatch):
    monkeypatch.setenv("ECO_OFFLINE", "1")
    climate._fetch.cache_clear()
    c = climate.get_climate(39.9, -75.1, today=dt.date(2026, 10, 15))
    assert c.years == [2023, 2024, 2025] and "unreachable" in c.source


def test_ph_factor():
    tom = eco.load_crops()["tomato"]
    assert eco.ph_factor(tom, 6.5) == 1.0
    assert eco.ph_factor(tom, 6.1) == 1.0   # within tolerance
    assert eco.ph_factor(tom, 5.2) == 0.8
    assert eco.ph_factor(tom, 3.0) == 0.5  # floor


def test_short_season_penalises_warm_crops(cl):
    import dataclasses
    short = dataclasses.replace(cl, frost_free_days=70, season_gdd50=700)
    fit = eco.season_fit(eco.load_crops()["sweet_corn"], short)
    assert fit.fraction < 0.6 and "too short" in fit.note


def test_ranking_sorted_and_complete(nj_soil, cl):
    r = eco.rank_crops(nj_soil, cl)
    assert len(r) == len(eco.load_crops())
    assert [x.net_per_sqft for x in r] == sorted((x.net_per_sqft for x in r), reverse=True)
    assert all(x.water_gal_per_sqft >= 0 for x in r)


def test_price_override_moves_ranking(nj_soil, cl):
    base = {x.id: x for x in eco.rank_crops(nj_soil, cl)}
    bumped = {x.id: x for x in eco.rank_crops(nj_soil, cl, price_overrides={"carrot": 10.0})}
    assert bumped["carrot"].net_per_sqft > base["carrot"].net_per_sqft


def test_water_scales_with_area_and_method(nj_soil, cl):
    small = eco.water_plan([{"crop": "tomato", "sqft": 10}], nj_soil, cl)
    big = eco.water_plan([{"crop": "tomato", "sqft": 20}], nj_soil, cl)
    drip = eco.water_plan([{"crop": "tomato", "sqft": 20}], nj_soil, cl, method="drip")
    assert big["total_gallons"] == pytest.approx(2 * small["total_gallons"], rel=0.02)
    assert drip["total_gallons"] < big["total_gallons"]
    assert big["drip_savings"] > 0
    assert sum(big["monthly_gallons"][:2]) == 0  # nothing planted in Jan/Feb


def test_fertilizer_meets_needs_with_whole_bags(nj_soil, cl):
    plan = [{"crop": "sweet_corn", "sqft": 60}, {"crop": "kale", "sqft": 40}]
    f = eco.optimize_fertilizer(plan, nj_soil, cl)
    for k in ("N", "P2O5", "K2O"):
        assert f.supplied_lb[k] >= f.need_lb[k] - 1e-6
    for p in f.purchases:
        assert p.bags >= 1 and p.lbs_to_apply <= p.bags * p.bag_lb + 1e-6
    assert f.upfront_cost >= f.season_cost - 1e-6 or f.compost_action


def test_organic_only(nj_soil, cl):
    f = eco.optimize_fertilizer([{"crop": "spinach", "sqft": 50}], nj_soil, cl, organic_only=True)
    organic = {x["name"] for x in eco.load_amendments()["fertilizers"] if x["organic"]}
    assert f.purchases and all(p.name in organic for p in f.purchases)


def test_acid_soil_gets_lime_alkaline_gets_sulfur(fake_net, nj_address, cl):
    fake_net["sda"] = sda_table(ph=5.2)
    acid = soil.research_soil(nj_address)
    assert eco.ph_adjustment(acid, 100)["product"] == "Pelletized limestone"
    fake_net["sda"] = sda_table(ph=8.0)
    alk = soil.research_soil(nj_address)
    assert eco.ph_adjustment(alk, 100)["product"] == "Elemental sulfur"


def test_rich_soil_needs_no_compost(fake_net, nj_address):
    fake_net["sda"] = sda_table(om=9.0)
    rich = soil.research_soil(nj_address)
    assert eco.compost_adjustment(rich, 100) is None


def test_roi_adds_up(nj_soil, cl):
    plan = [{"crop": "tomato", "sqft": 16}, {"crop": "basil", "sqft": 4}]
    r = eco.garden_roi(plan, nj_soil, cl, setup_cost=100, setup_years=5)
    c = r["costs"]
    assert r["total_cost"] == pytest.approx(sum(c.values()), abs=0.02)
    assert r["net"] == pytest.approx(r["harvest_value"] - r["total_cost"], abs=0.02)
    assert c["setup_per_year"] == 20.0
    assert r["harvest_value"] == pytest.approx(sum(x["value"] for x in r["rows"]), abs=0.02)
