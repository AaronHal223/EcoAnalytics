"""Shared HTTP helper.

Every outside data source EcoAnalytics uses is free and keyless, but they are
also all "best effort" public services. Every call goes through `get_json` /
`post_json` so timeouts, retries and error handling are identical everywhere,
and so tests can patch one place.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Optional

import httpx

log = logging.getLogger("ecoanalytics.http")

DEFAULT_TIMEOUT = httpx.Timeout(12.0, connect=6.0)
USER_AGENT = "EcoAnalytics/2.0 (+https://github.com/AaronHal223/EcoAnalytics)"


class SourceUnavailable(RuntimeError):
    """Raised when an outside data source can't be reached or returns junk."""


def _client() -> httpx.Client:
    return httpx.Client(timeout=DEFAULT_TIMEOUT, headers={"User-Agent": USER_AGENT},
                        follow_redirects=True)


def offline() -> bool:
    """ECO_OFFLINE=1 skips every outside call (demo mode, tests, no internet)."""
    return os.environ.get("ECO_OFFLINE", "").lower() in ("1", "true", "yes")


def get_json(url: str, params: Optional[dict] = None, retries: int = 1) -> Any:
    if offline():
        raise SourceUnavailable("offline mode")
    last: Optional[Exception] = None
    for _ in range(retries + 1):
        try:
            with _client() as c:
                r = c.get(url, params=params)
                r.raise_for_status()
                return r.json()
        except (httpx.HTTPError, ValueError) as exc:
            last = exc
            log.warning("GET %s failed: %s", url, exc)
    raise SourceUnavailable(f"{url}: {last}")


def post_json(url: str, payload: dict, retries: int = 1) -> Any:
    if offline():
        raise SourceUnavailable("offline mode")
    last: Optional[Exception] = None
    for _ in range(retries + 1):
        try:
            with _client() as c:
                r = c.post(url, json=payload)
                r.raise_for_status()
                return r.json()
        except (httpx.HTTPError, ValueError) as exc:
            last = exc
            log.warning("POST %s failed: %s", url, exc)
    raise SourceUnavailable(f"{url}: {last}")
