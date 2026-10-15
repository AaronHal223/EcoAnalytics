"""Where is the garden?

Everything EcoAnalytics estimates (soil, rainfall, season length, water cost)
hangs off a latitude/longitude, so this module works out the best one it can
and, just as importantly, how *precise* that point is.

Resolution order, best first:

1. Device GPS (browser geolocation, user-approved)      ~0.1 km
2. Street address  -> US Census geocoder                 ~0.1 km
3. ZIP code        -> Zippopotam.us centroid             ~3 km
4. IP address      -> ip-api.com                         ~10-25 km
5. Offline ZIP-prefix -> state population centre         ~150 km

IP geolocation is the only one that needs nothing from the user, but it is
the one a VPN breaks. `detect_vpn` combines three independent signals so the
dashboard knows when to stop trusting it and ask for an address instead:

* ip-api's own `proxy` flag (known VPN/Tor exit),
* ip-api's `hosting` flag (data-centre IP: home internet is never hosted),
* the browser's timezone disagreeing with the IP's timezone (a VPN moves the
  IP but not the clock on the user's laptop).

`precision_km` feeds straight into soil.py: the less sure we are about the
point, the wider the ring of soil samples that gets averaged.
"""
from __future__ import annotations

import ipaddress
from dataclasses import asdict, dataclass, field
from typing import Optional

from .http import SourceUnavailable, get_json

IP_API = "http://ip-api.com/json/{ip}"  # free tier is HTTP-only, 45 req/min
IP_FIELDS = "status,message,query,country,countryCode,regionName,region,city,zip,lat,lon,timezone,proxy,hosting,mobile"
ZIPPOPOTAM = "https://api.zippopotam.us/us/{zip}"
CENSUS_GEOCODER = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"

PRECISION_KM = {"device": 0.1, "address": 0.1, "zip": 3.0, "ip": 15.0, "fallback": 150.0}


@dataclass
class Location:
    lat: float
    lon: float
    source: str                     # device | address | zip | ip | fallback
    precision_km: float
    label: str = ""
    zip: Optional[str] = None
    state: Optional[str] = None
    timezone: Optional[str] = None
    vpn_suspected: bool = False
    vpn_reasons: list[str] = field(default_factory=list)
    needs_better_location: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


# --------------------------------------------------------------------------
# Offline fallback: ZIP prefix ranges -> state, with each state's approximate
# population centre (more useful than the geographic centre for gardens).
# --------------------------------------------------------------------------
_ZIP3_RANGES: list[tuple[int, int, str]] = [
    (5, 5, "NY"), (10, 27, "MA"), (28, 29, "RI"), (30, 38, "NH"), (39, 49, "ME"),
    (50, 54, "VT"), (55, 55, "MA"), (56, 59, "VT"), (60, 69, "CT"), (70, 89, "NJ"),
    (100, 149, "NY"), (150, 196, "PA"), (197, 199, "DE"), (200, 205, "DC"),
    (206, 219, "MD"), (220, 246, "VA"), (247, 268, "WV"), (270, 289, "NC"),
    (290, 299, "SC"), (300, 319, "GA"), (320, 349, "FL"), (350, 369, "AL"),
    (370, 385, "TN"), (386, 397, "MS"), (398, 399, "GA"), (400, 427, "KY"),
    (430, 458, "OH"), (460, 479, "IN"), (480, 499, "MI"), (500, 528, "IA"),
    (530, 549, "WI"), (550, 567, "MN"), (569, 569, "DC"), (570, 577, "SD"),
    (580, 588, "ND"), (590, 599, "MT"), (600, 629, "IL"), (630, 658, "MO"),
    (660, 679, "KS"), (680, 693, "NE"), (700, 714, "LA"), (716, 729, "AR"),
    (730, 732, "OK"), (733, 733, "TX"), (734, 749, "OK"), (750, 799, "TX"),
    (800, 816, "CO"), (820, 831, "WY"), (832, 838, "ID"), (840, 847, "UT"),
    (850, 865, "AZ"), (870, 884, "NM"), (885, 885, "TX"), (889, 898, "NV"),
    (900, 961, "CA"), (967, 968, "HI"), (970, 979, "OR"), (980, 994, "WA"),
    (995, 999, "AK"),
]

STATE_CENTERS: dict[str, tuple[float, float, str]] = {
    "AL": (33.0, -86.8, "Alabama"), "AK": (61.4, -149.5, "Alaska"),
    "AZ": (33.4, -111.9, "Arizona"), "AR": (34.9, -92.4, "Arkansas"),
    "CA": (35.5, -119.4, "California"), "CO": (39.6, -105.0, "Colorado"),
    "CT": (41.6, -72.9, "Connecticut"), "DE": (39.4, -75.6, "Delaware"),
    "DC": (38.9, -77.0, "District of Columbia"), "FL": (27.8, -81.6, "Florida"),
    "GA": (33.6, -84.2, "Georgia"), "HI": (21.4, -157.9, "Hawaii"),
    "ID": (43.7, -115.7, "Idaho"), "IL": (41.3, -88.4, "Illinois"),
    "IN": (39.9, -86.3, "Indiana"), "IA": (41.9, -93.0, "Iowa"),
    "KS": (38.5, -96.8, "Kansas"), "KY": (37.8, -85.3, "Kentucky"),
    "LA": (30.7, -91.3, "Louisiana"), "ME": (44.3, -69.8, "Maine"),
    "MD": (39.1, -76.8, "Maryland"), "MA": (42.3, -71.4, "Massachusetts"),
    "MI": (42.9, -84.2, "Michigan"), "MN": (45.2, -93.6, "Minnesota"),
    "MS": (32.6, -89.6, "Mississippi"), "MO": (38.4, -92.2, "Missouri"),
    "MT": (46.7, -111.0, "Montana"), "NE": (41.2, -97.4, "Nebraska"),
    "NV": (36.6, -115.6, "Nevada"), "NH": (43.0, -71.5, "New Hampshire"),
    "NJ": (40.4, -74.4, "New Jersey"), "NM": (34.6, -106.4, "New Mexico"),
    "NY": (41.5, -74.6, "New York"), "NC": (35.6, -79.6, "North Carolina"),
    "ND": (47.4, -99.0, "North Dakota"), "OH": (40.5, -82.7, "Ohio"),
    "OK": (35.6, -97.0, "Oklahoma"), "OR": (44.7, -122.6, "Oregon"),
    "PA": (40.5, -77.0, "Pennsylvania"), "RI": (41.8, -71.4, "Rhode Island"),
    "SC": (34.0, -81.0, "South Carolina"), "SD": (44.0, -97.8, "South Dakota"),
    "TN": (35.8, -86.4, "Tennessee"), "TX": (31.0, -97.4, "Texas"),
    "UT": (40.4, -111.9, "Utah"), "VT": (44.1, -72.8, "Vermont"),
    "VA": (38.0, -77.8, "Virginia"), "WA": (47.3, -121.6, "Washington"),
    "WV": (38.8, -80.9, "West Virginia"), "WI": (43.7, -89.0, "Wisconsin"),
    "WY": (42.4, -106.8, "Wyoming"),
}


def state_from_zip(zip_code: str) -> Optional[str]:
    z = (zip_code or "").strip()[:5]
    if len(z) != 5 or not z.isdigit():
        return None
    p = int(z[:3])
    for lo, hi, st in _ZIP3_RANGES:
        if lo <= p <= hi:
            return st
    return None


def fallback_location(zip_code: Optional[str] = None, state: Optional[str] = None) -> Location:
    st = state or (state_from_zip(zip_code) if zip_code else None) or "PA"
    lat, lon, name = STATE_CENTERS.get(st, STATE_CENTERS["PA"])
    return Location(lat=lat, lon=lon, source="fallback", precision_km=PRECISION_KM["fallback"],
                    label=f"{name} (approximate, offline)", zip=zip_code, state=st,
                    needs_better_location=True)


# --------------------------------------------------------------------------
# IP + VPN detection
# --------------------------------------------------------------------------
def _is_public(ip: Optional[str]) -> bool:
    if not ip:
        return False
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return not (addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved)


def detect_vpn(ip_info: dict, browser_timezone: Optional[str]) -> list[str]:
    """Returns human-readable reasons to distrust the IP location (empty = trust it)."""
    reasons = []
    if ip_info.get("proxy"):
        reasons.append("This IP is a known VPN, proxy or Tor exit.")
    if ip_info.get("hosting"):
        reasons.append("This IP belongs to a data centre, not a home internet provider.")
    ip_tz = ip_info.get("timezone")
    if browser_timezone and ip_tz and browser_timezone != ip_tz:
        reasons.append(f"Your device clock is set to {browser_timezone}, but the IP "
                       f"looks like it's in {ip_tz}.")
    if ip_info.get("countryCode") and ip_info["countryCode"] != "US":
        reasons.append("The IP is outside the US; soil and price data here are US-only.")
    return reasons


def locate_by_ip(client_ip: Optional[str] = None, browser_timezone: Optional[str] = None) -> Location:
    """Locates by IP. A private/loopback client IP (running locally) looks up
    this machine's own public IP, which is the user's home connection."""
    ip = client_ip if _is_public(client_ip) else ""
    try:
        info = get_json(IP_API.format(ip=ip), params={"fields": IP_FIELDS})
    except SourceUnavailable:
        return fallback_location()
    if info.get("status") != "success":
        return fallback_location()

    reasons = detect_vpn(info, browser_timezone)
    loc = Location(
        lat=float(info["lat"]), lon=float(info["lon"]), source="ip",
        precision_km=PRECISION_KM["ip"],
        label=", ".join(x for x in [info.get("city"), info.get("region")] if x),
        zip=info.get("zip") or None, state=info.get("region") or None,
        timezone=info.get("timezone"),
        vpn_suspected=bool(reasons), vpn_reasons=reasons,
        needs_better_location=True,  # IP is never better than ~15 km; always invite refinement
    )
    if reasons:
        # Don't build a soil profile on a VPN server's city: mark it unusable.
        loc.precision_km = PRECISION_KM["fallback"]
    return loc


# --------------------------------------------------------------------------
# User-supplied refinements
# --------------------------------------------------------------------------
def locate_by_zip(zip_code: str) -> Location:
    z = (zip_code or "").strip()[:5]
    if not (len(z) == 5 and z.isdigit()):
        raise ValueError("ZIP code must be 5 digits.")
    try:
        data = get_json(ZIPPOPOTAM.format(zip=z))
        place = data["places"][0]
        return Location(lat=float(place["latitude"]), lon=float(place["longitude"]),
                        source="zip", precision_km=PRECISION_KM["zip"],
                        label=f"{place['place name']}, {place['state abbreviation']} {z}",
                        zip=z, state=place["state abbreviation"])
    except (SourceUnavailable, KeyError, IndexError, TypeError, ValueError):
        return fallback_location(zip_code=z)


def locate_by_address(address: str) -> Location:
    address = (address or "").strip()
    if len(address) < 6:
        raise ValueError("Enter a street address with city and state, or a ZIP code.")
    try:
        data = get_json(CENSUS_GEOCODER, params={
            "address": address, "benchmark": "Public_AR_Current", "format": "json"})
        matches = data["result"]["addressMatches"]
    except (SourceUnavailable, KeyError, TypeError):
        matches = []
    if matches:
        m = matches[0]
        comps = m.get("addressComponents", {})
        return Location(lat=float(m["coordinates"]["y"]), lon=float(m["coordinates"]["x"]),
                        source="address", precision_km=PRECISION_KM["address"],
                        label=m.get("matchedAddress", address),
                        zip=comps.get("zip"), state=comps.get("state"))
    # No street match: fall back to any ZIP in the text.
    import re
    zm = re.search(r"\b(\d{5})(?:-\d{4})?\b", address)
    if zm:
        return locate_by_zip(zm.group(1))
    raise ValueError("Couldn't find that address. Try adding the city and state, or just a ZIP code.")


def locate_by_device(lat: float, lon: float) -> Location:
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("Invalid coordinates.")
    return Location(lat=lat, lon=lon, source="device", precision_km=PRECISION_KM["device"],
                    label=f"Device location ({lat:.4f}, {lon:.4f})")
