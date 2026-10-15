import pytest

from backend import geo, soil
from tests.conftest import sda_table, soilgrids_payload


def test_sda_depth_and_component_weighting():
    vals = soil.parse_sda_rows(sda_table(ph=6.0, om=3.0)["Table"])
    # 0-20 cm at pH 6.0 and 20-30 cm at pH 6.2 -> 6.0*2/3 + 6.2*1/3
    assert vals["ph"] == pytest.approx(6.0667, abs=1e-3)
    # OM 3.0 then 1.0 -> 2.333; the "Urban land" component (all nulls) is ignored
    assert vals["organic_matter_pct"] == pytest.approx(2.333, abs=1e-3)
    assert vals["clay_pct"] == pytest.approx(20.0)


def test_soilgrids_unit_conversion():
    v = soil.parse_soilgrids(soilgrids_payload(ph10=62, soc=180, nitrogen=210, clay=200, cec=150))
    assert v["ph"] == pytest.approx(6.2)
    assert v["total_n_gkg"] == pytest.approx(2.1)
    assert v["clay_pct"] == pytest.approx(20.0)
    assert v["cec"] == pytest.approx(15.0)
    assert v["organic_matter_pct"] == pytest.approx(18.0 * 1.72 / 10)


@pytest.mark.parametrize("sand,silt,clay,expected", [
    (40, 40, 20, "loam"), (20, 65, 15, "silt loam"), (85, 10, 5, "loamy sand"),
    (95, 3, 2, "sand"), (20, 20, 60, "clay"), (65, 25, 10, "sandy loam"),
    (35, 30, 35, "clay loam"), (5, 55, 40, "silty clay"),
])
def test_texture_triangle(sand, silt, clay, expected):
    assert soil.texture_class(sand, silt, clay) == expected


def test_ring_shrinks_with_better_location():
    assert soil.ring_radius_km(geo.Location(0, 0, "address", 0.1)) < \
        soil.ring_radius_km(geo.Location(0, 0, "zip", 3)) < \
        soil.ring_radius_km(geo.Location(0, 0, "ip", 15))
    pts = soil.sample_points(40, -75, 2.0)
    assert len(pts) == 7 and pts[0][2] == 2.0


def test_research_averages_ring_with_high_confidence(fake_net, nj_address):
    rep = soil.research_soil(nj_address)
    assert rep.points_with_data == 7
    ph = rep.values["ph"]
    assert ph.source == "ssurgo" and ph.confidence == "high"
    assert ph.status == "low"  # 6.07 is under the 6.2 vegetable ideal
    assert rep.values["total_n_gkg"].source == "soilgrids"
    assert rep.values["p_ppm"].confidence == "low"  # P can never be mapped
    assert rep.texture_class == "loam"
    assert rep.n_mineralized_lb_per_100sqft > 0


def test_disagreeing_points_lower_confidence(fake_net, nj_address, monkeypatch):
    phs = iter([5.0, 7.5, 5.2, 7.2, 5.5, 7.8, 6.0])
    monkeypatch.setattr(soil, "fetch_ssurgo_point",
                        lambda lat, lon: soil.parse_sda_rows(sda_table(ph=next(phs))["Table"]))
    rep = soil.research_soil(nj_address, max_workers=1)
    assert rep.values["ph"].confidence != "high"
    assert rep.values["ph"].low < 5.5 < 7.5 < rep.values["ph"].high


def test_soil_test_overrides_estimates(fake_net, nj_address):
    rep = soil.research_soil(nj_address, soil_test={"ph": 6.5, "p_ppm": 80, "k_ppm": 90})
    assert rep.values["ph"].value == 6.5 and rep.values["ph"].source == "soil_test"
    assert rep.values["p_ppm"].status == "high" and rep.values["k_ppm"].status == "low"
    assert "Your soil test" in rep.sources


def test_soilgrids_fills_in_when_survey_empty(fake_net, nj_address):
    fake_net["sda"] = {"Table": [sda_table()["Table"][0]]}  # header only (e.g. urban land)
    rep = soil.research_soil(nj_address)
    assert rep.points_with_data == 0
    assert rep.values["ph"].source == "soilgrids"


def test_offline_falls_back_to_region(monkeypatch, nj_address):
    monkeypatch.setenv("ECO_OFFLINE", "1")
    rep = soil.research_soil(nj_address)
    assert rep.values["ph"].source == "regional"
    assert any("couldn't be reached" in n for n in rep.notes)
