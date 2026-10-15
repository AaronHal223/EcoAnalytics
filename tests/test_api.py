from pathlib import Path

from fastapi.testclient import TestClient

from backend.app import app

client = TestClient(app)
ROOT = Path(__file__).resolve().parent.parent


def test_health_and_dashboard():
    assert client.get("/api/health").json()["ok"]
    r = client.get("/")
    assert r.status_code == 200 and "EcoAnalytics" in r.text


def test_crops_list():
    ids = {c["id"] for c in client.get("/api/crops").json()}
    assert {"tomato", "lettuce", "basil"} <= ids


def test_full_flow(fake_net):
    loc = client.post("/api/locate", json={"method": "zip", "zip": "08031"}).json()
    assert loc["source"] == "zip"
    r = client.post("/api/analyze", json={"location": loc, "plan": [{"crop": "tomato", "sqft": 20}],
                                          "setup_cost": 80, "irrigation": "drip"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert set(d) == {"location", "soil", "climate", "ranking", "roi"}
    assert d["soil"]["values"]["ph"]["source"] == "ssurgo"
    assert d["roi"]["water"]["method"] == "drip"


def test_vpn_user_told_to_refine(fake_net):
    fake_net["ip"].update(hosting=True)
    loc = client.post("/api/locate", json={"method": "ip", "browser_timezone": "America/New_York"}).json()
    assert loc["vpn_suspected"] and loc["vpn_reasons"]


def test_offline_still_answers(monkeypatch):
    monkeypatch.setenv("ECO_OFFLINE", "1")
    loc = client.post("/api/locate", json={"method": "zip", "zip": "85001"}).json()
    assert loc["state"] == "AZ" and loc["source"] == "fallback"
    d = client.post("/api/analyze", json={"location": loc}).json()
    assert d["soil"]["values"]["ph"]["value"] > 7  # southwest soils are alkaline


def test_validation():
    loc = {"lat": 40, "lon": -75, "source": "zip", "precision_km": 3}
    assert client.post("/api/analyze", json={"location": loc, "plan": [{"crop": "eggs", "sqft": 5}]}).status_code == 422
    assert client.post("/api/locate", json={"method": "zip", "zip": "12"}).status_code == 422


def test_no_poultry_left_in_project():
    import re
    pattern = re.compile(r"\b(eggs?|poultry|chickens?|flocks?|hens?)\b")
    for path in list((ROOT / "backend").rglob("*.py")) + list((ROOT / "backend").rglob("*.json")) + \
            [ROOT / "dashboard" / "index.html"]:
        m = pattern.search(path.read_text().lower())
        assert m is None, f"{m.group(0)!r} found in {path}"
