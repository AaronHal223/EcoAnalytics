"""EcoAnalytics web API + dashboard.

Run:  uvicorn backend.app:app --reload   then open http://localhost:8000
"""
from __future__ import annotations

from dataclasses import asdict
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import __version__, economics, geo
from .climate import get_climate
from .soil import research_soil

DASHBOARD = Path(__file__).resolve().parent.parent / "dashboard" / "index.html"

app = FastAPI(title="EcoAnalytics", version=__version__,
              description="Soil-first, economics-first analytics for backyard growers.")


# --------------------------------------------------------------------------
# Schemas
# --------------------------------------------------------------------------
class LocateRequest(BaseModel):
    method: Literal["ip", "zip", "address", "device"] = "ip"
    browser_timezone: Optional[str] = None
    zip: Optional[str] = None
    address: Optional[str] = None
    lat: Optional[float] = None
    lon: Optional[float] = None


class LocationModel(BaseModel):
    lat: float
    lon: float
    source: str
    precision_km: float
    label: str = ""
    zip: Optional[str] = None
    state: Optional[str] = None
    timezone: Optional[str] = None
    vpn_suspected: bool = False
    vpn_reasons: list[str] = []
    needs_better_location: bool = False


class PlanItem(BaseModel):
    crop: str
    sqft: float = Field(gt=0, le=5000)


class SoilTest(BaseModel):
    ph: Optional[float] = Field(None, ge=3, le=10)
    organic_matter_pct: Optional[float] = Field(None, ge=0, le=60)
    p_ppm: Optional[float] = Field(None, ge=0, le=1000)
    k_ppm: Optional[float] = Field(None, ge=0, le=2000)
    cec: Optional[float] = Field(None, ge=0, le=100)


class AnalyzeRequest(BaseModel):
    location: LocationModel
    plan: list[PlanItem] = Field(default_factory=lambda: [
        PlanItem(crop="tomato", sqft=16), PlanItem(crop="lettuce", sqft=8),
        PlanItem(crop="basil", sqft=4), PlanItem(crop="pepper", sqft=4)])
    soil_test: Optional[SoilTest] = None
    water_rate: float = Field(economics.DEFAULT_WATER_RATE, ge=0, le=100)
    irrigation: Literal["drip", "hose", "sprinkler"] = "hose"
    setup_cost: float = Field(0.0, ge=0, le=100000)
    setup_years: int = Field(5, ge=1, le=30)
    organic_only: bool = False
    price_overrides: dict[str, float] = {}


# --------------------------------------------------------------------------
# Small cache so re-running the plan doesn't re-query every soil service
# --------------------------------------------------------------------------
_soil_cache: dict[tuple, object] = {}
_SOIL_CACHE_MAX = 200


def _soil_for(loc: geo.Location, soil_test: Optional[dict]):
    key = (round(loc.lat, 3), round(loc.lon, 3), loc.source, tuple(sorted((soil_test or {}).items())))
    if key not in _soil_cache:
        if len(_soil_cache) >= _SOIL_CACHE_MAX:
            _soil_cache.pop(next(iter(_soil_cache)))
        _soil_cache[key] = research_soil(loc, soil_test)
    return _soil_cache[key]


def _client_ip(request: Request) -> Optional[str]:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else None


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------
@app.get("/", include_in_schema=False)
def dashboard():
    return FileResponse(DASHBOARD)


@app.get("/api/health")
def health():
    return {"ok": True, "version": __version__}


@app.get("/api/crops")
def crops():
    return [{k: c[k] for k in ("id", "name", "season", "days", "price_per_lb", "ph")}
            for c in economics.load_crops().values()]


@app.post("/api/locate")
def locate(req: LocateRequest, request: Request):
    try:
        if req.method == "device":
            if req.lat is None or req.lon is None:
                raise ValueError("Device location needs lat and lon.")
            loc = geo.locate_by_device(req.lat, req.lon)
        elif req.method == "address":
            loc = geo.locate_by_address(req.address or "")
        elif req.method == "zip":
            loc = geo.locate_by_zip(req.zip or "")
        else:
            loc = geo.locate_by_ip(_client_ip(request), req.browser_timezone)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return loc.to_dict()


@app.post("/api/analyze")
def analyze(req: AnalyzeRequest):
    crop_ids = economics.load_crops()
    bad = [p.crop for p in req.plan if p.crop not in crop_ids]
    if bad:
        raise HTTPException(status_code=422, detail=f"Unknown crop(s): {', '.join(bad)}")

    loc = geo.Location(**req.location.model_dump())
    soil_test = {k: v for k, v in (req.soil_test.model_dump() if req.soil_test else {}).items()
                 if v is not None}
    soil = _soil_for(loc, soil_test or None)
    climate = get_climate(loc.lat, loc.lon)
    plan = [p.model_dump() for p in req.plan]

    ranking = economics.rank_crops(soil, climate, req.water_rate, req.irrigation,
                                   req.organic_only, req.price_overrides)
    roi = economics.garden_roi(plan, soil, climate, req.water_rate, req.irrigation,
                               req.setup_cost, req.setup_years, req.organic_only,
                               req.price_overrides)
    return {
        "location": loc.to_dict(),
        "soil": soil.to_dict(),
        "climate": climate.to_dict(),
        "ranking": [asdict(r) for r in ranking],
        "roi": roi,
    }
