"""Download official index constituents and rewrite the universe JSON.

NSE publishes index members as CSV; Nasdaq exposes the NASDAQ-100 through
the API behind nasdaq.com. Both are validated before anything is written,
so an error page or a partial response can never shrink a universe.
"""

from __future__ import annotations

import csv
import io
import json
import re

import requests

from pipeline.clock import now_ist
from pipeline.log import Logger
from pipeline.universes import load, path_for

USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
NSE_NIFTY100_URL = "https://nsearchives.nseindia.com/content/indices/ind_nifty100list.csv"
NASDAQ100_URL = "https://api.nasdaq.com/api/quote/list-type/nasdaq100"

# Trailing share-class descriptors on Nasdaq company names, e.g.
# "Alphabet Inc. Class C Capital Stock" -> "Alphabet Inc.".
_NASDAQ_NAME_SUFFIX = re.compile(
    r"\s*(\(DE\)\s*)?((Class|Series) [A-Z]\s+)?"
    r"(Common Stock|Capital Stock|Common Shares|Ordinary Shares|"
    r"American Depositary Shares|New York Registry Shares|"
    r"Subordinate Voting Shares)"
    r"(\s+Class [A-Z])?(\s*\((DE|Ireland)\))?\s*$",
    re.IGNORECASE,
)


def clean_nasdaq_name(raw: str) -> str:
    name = re.sub(r"\s+", " ", (raw or "").strip())
    return _NASDAQ_NAME_SUFFIX.sub("", name).strip() or name


def fetch_nifty100() -> list[dict]:
    resp = requests.get(NSE_NIFTY100_URL, headers={"User-Agent": USER_AGENT},
                        timeout=30)
    resp.raise_for_status()
    rows = []
    for rec in csv.DictReader(io.StringIO(resp.content.decode("utf-8-sig"))):
        symbol = (rec.get("Symbol") or "").strip().upper()
        series = (rec.get("Series") or "").strip().upper()
        if not symbol or symbol.startswith("DUMMY") or series not in ("EQ", "BE"):
            continue
        rows.append({"symbol": symbol,
                     "name": (rec.get("Company Name") or "").strip(),
                     "industry": (rec.get("Industry") or "").strip()})
    if not 95 <= len(rows) <= 105:
        raise ValueError(f"NSE returned {len(rows)} Nifty 100 rows; refusing to write")
    return sorted(rows, key=lambda r: r["symbol"])


def fetch_nasdaq100() -> list[dict]:
    resp = requests.get(NASDAQ100_URL, timeout=30, headers={
        "User-Agent": USER_AGENT,
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://www.nasdaq.com",
        "Referer": "https://www.nasdaq.com/",
    })
    resp.raise_for_status()
    data = ((resp.json().get("data") or {}).get("data") or {}).get("rows") or []
    rows = []
    for rec in data:
        symbol = str(rec.get("symbol") or "").strip().upper()
        if not symbol:
            continue
        rows.append({"symbol": symbol,
                     "name": clean_nasdaq_name(str(rec.get("companyName") or "")),
                     "industry": str(rec.get("sector") or "").strip()})
    if not 95 <= len(rows) <= 110:
        raise ValueError(f"Nasdaq returned {len(rows)} NASDAQ-100 rows; refusing to write")
    return sorted(rows, key=lambda r: r["symbol"])


_SPECS = {
    "nifty100": ("NIFTY 100", NSE_NIFTY100_URL, fetch_nifty100),
    "nasdaq100": ("NASDAQ-100", NASDAQ100_URL, fetch_nasdaq100),
}


def refresh(key: str, log: Logger | None = None) -> dict:
    """Refresh one universe; returns {"added": [...], "removed": [...], "written": bool}."""
    log = log or Logger("universe")
    name, source, fetcher = _SPECS[key]
    rows = fetcher()

    try:
        current = set(load(key).symbols)
    except (OSError, ValueError, KeyError):
        current = set()
    fresh = {r["symbol"] for r in rows}
    added, removed = sorted(fresh - current), sorted(current - fresh)

    if current and not added and not removed:
        log.info(f"{name}: unchanged ({len(fresh)} members)")
        return {"added": [], "removed": [], "written": False}

    blob = {"name": name, "source": source,
            "as_of": now_ist().date().isoformat(), "constituents": rows}
    with open(path_for(key), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(blob, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    log.info(f"{name}: wrote {len(rows)} members (+{len(added)} -{len(removed)})"
             + (f"; added {', '.join(added)}" if added and current else "")
             + (f"; removed {', '.join(removed)}" if removed else ""))
    return {"added": added, "removed": removed, "written": True}
