from backend import geo


def test_state_from_zip():
    assert geo.state_from_zip("08031") == "NJ"
    assert geo.state_from_zip("90210") == "CA"
    assert geo.state_from_zip("10001") == "NY"
    assert geo.state_from_zip("abc") is None


def test_fallback_is_marked_imprecise():
    loc = geo.fallback_location(zip_code="08031")
    assert loc.state == "NJ" and loc.source == "fallback"
    assert loc.precision_km >= 100 and loc.needs_better_location


def test_ip_location_home_connection(fake_net):
    loc = geo.locate_by_ip("127.0.0.1", "America/New_York")
    assert loc.source == "ip" and not loc.vpn_suspected
    assert abs(loc.lat - 39.867) < 1e-6
    # Local/private client IP -> look up the machine's own public IP (empty path).
    assert fake_net["calls"][0].endswith("/json/")


def test_vpn_flag_from_provider(fake_net):
    fake_net["ip"].update(proxy=True)
    loc = geo.locate_by_ip(None, "America/New_York")
    assert loc.vpn_suspected
    assert loc.precision_km == geo.PRECISION_KM["fallback"]  # never trusted for soil


def test_vpn_detected_by_timezone_mismatch(fake_net):
    fake_net["ip"].update(timezone="Europe/Amsterdam", city="Amsterdam")
    loc = geo.locate_by_ip(None, "America/New_York")
    assert loc.vpn_suspected
    assert any("clock" in r for r in loc.vpn_reasons)


def test_datacenter_ip_flagged():
    reasons = geo.detect_vpn({"hosting": True, "timezone": "America/New_York", "countryCode": "US"},
                             "America/New_York")
    assert reasons and "data centre" in reasons[0]


def test_zip_and_address(fake_net):
    z = geo.locate_by_zip("08031")
    assert z.source == "zip" and z.state == "NJ" and z.precision_km == 3.0
    a = geo.locate_by_address("100 Main St, Bellmawr NJ")
    assert a.source == "address" and a.precision_km < 1 and a.zip == "08031"


def test_address_rejects_garbage():
    import pytest
    with pytest.raises(ValueError):
        geo.locate_by_address("x")
