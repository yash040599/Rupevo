"""Download index constituents and rewrite the universe JSON.

NSE publishes index members as CSV; Nasdaq exposes the NASDAQ-100 through
the API behind nasdaq.com, and every NYSE listing (with market value and
country) through the API behind its stock screener, from which the NYSE top
100 is selected. Everything is validated before anything is written, so an
error page or a partial response can never shrink a universe.
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
NYSE_SCREENER_URL = ("https://api.nasdaq.com/api/screener/stocks"
                     "?tableonly=true&download=true&exchange=nyse")
_NASDAQ_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://www.nasdaq.com",
    "Referer": "https://www.nasdaq.com/",
}

# The NYSE top 100: the largest US companies listed on the NYSE by market value. So that
# companies near #100 do not swap in and out on every refresh, a member stays while it ranks
# within NYSE_KEEP_WITHIN, a newcomer joins at once within NYSE_JOIN_WITHIN, and any places
# left are filled in order of size.
NYSE_LIST_SIZE = 100
NYSE_KEEP_WITHIN = 120
NYSE_JOIN_WITHIN = 80
NYSE_MIN_ELIGIBLE = 300
NYSE_MIN_MARKET_CAP = 5e9
# Common stock, optionally one share class (BRK/B); preferreds (BAC^K), warrants (/WS),
# units (/U) and rights (/R) are left out.
_NYSE_SYMBOL = re.compile(r"^([A-Z]{1,6})(?:/([A-C]))?$")
# Exchange-listed notes, bonds and similar securities appear in the screener with the issuer's
# market value ("AT&T Inc. 5.350% Global Notes due 2066"); depositary shares are foreign
# companies' ADRs or preferreds. None of them is a company's common stock.
_NOT_COMMON_STOCK = re.compile(
    r"\d+(?:\.\d+)?\s*%|\b(?:notes?|debentures?|bonds?|zones|preferred|warrants?|strats)\b"
    r"|\bdue\s+(?:\w+\s+){0,2}\d{4}\b|depositary|exchangeable",
    re.IGNORECASE,
)

# Trailing share-class descriptors on Nasdaq company names, e.g.
# "Alphabet Inc. Class C Capital Stock" -> "Alphabet Inc.".
_NASDAQ_NAME_SUFFIX = re.compile(
    r"\s*(\(DE\)\s*)?((Class|Series) [A-Z]\s+)?"
    r"(Common Stock|Capital Stock|Common Shares|Ordinary Shares|"
    r"American Depositary Shares|New York Registry Shares|"
    r"Subordinate Voting Shares|"
    r"Common Units(?: Representing Limited Partner(?:ship)? Interests?)?)"
    r"(\s+Class [A-Z])?(\s*\((DE|Ireland|new)\))?\s*$",
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
    resp = requests.get(NASDAQ100_URL, timeout=30, headers=_NASDAQ_HEADERS)
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


def _amount(value) -> float:
    try:
        out = float(str(value or "").replace(",", "").replace("$", "").strip() or 0)
    except ValueError:
        return 0.0
    return out if out > 0 else 0.0


def select_nyse100(rows: list[dict], current: set[str] | None = None) -> list[dict]:
    """The NYSE top 100 from Nasdaq stock-screener rows (NYSE listings).

    US companies only, common stock only, one share class per company (the most
    traded), largest market value first, with the buffer described at
    NYSE_KEEP_WITHIN. `current` holds the members chosen last time.
    """
    by_company: dict[str, dict] = {}
    for rec in rows:
        if str(rec.get("country") or "").strip() != "United States":
            continue
        raw_name = str(rec.get("name") or "")
        if _NOT_COMMON_STOCK.search(raw_name):
            continue
        match = _NYSE_SYMBOL.match(str(rec.get("symbol") or "").strip().upper())
        cap = _amount(rec.get("marketCap"))
        name = clean_nasdaq_name(raw_name)
        if not match or not cap or not name:
            continue
        symbol = match.group(1) + (f".{match.group(2)}" if match.group(2) else "")
        row = {"symbol": symbol, "name": name, "industry": str(rec.get("sector") or "").strip(),
               "_cap": cap, "_volume": _amount(rec.get("volume"))}
        # Share classes of one company (BRK/A, BRK/B) carry the same market value: keep one.
        key = re.sub(r"[^a-z0-9]", "", name.lower())
        seen = by_company.get(key)
        if not seen or row["_volume"] > seen["_volume"]:
            by_company[key] = row
    eligible = sorted(by_company.values(), key=lambda r: (-r["_cap"], r["symbol"]))
    if len(eligible) < NYSE_MIN_ELIGIBLE:
        raise ValueError(f"the NYSE screener returned only {len(eligible)} eligible US companies; "
                         "refusing to write")

    position = {r["symbol"]: i for i, r in enumerate(eligible, 1)}
    current = set(current or ())
    if current:
        chosen = {r["symbol"] for r in eligible
                  if r["symbol"] not in current and position[r["symbol"]] <= NYSE_JOIN_WITHIN}
        for r in eligible:
            if len(chosen) >= NYSE_LIST_SIZE:
                break
            if r["symbol"] in current and position[r["symbol"]] <= NYSE_KEEP_WITHIN:
                chosen.add(r["symbol"])
    else:
        chosen = set()
    for r in eligible:
        if len(chosen) >= NYSE_LIST_SIZE:
            break
        chosen.add(r["symbol"])

    picked = [r for r in eligible if r["symbol"] in chosen]
    if len(picked) != NYSE_LIST_SIZE or picked[-1]["_cap"] < NYSE_MIN_MARKET_CAP:
        raise ValueError("the NYSE selection does not look right "
                         f"({len(picked)} companies); refusing to write")
    return sorted(({k: v for k, v in r.items() if not k.startswith("_")} for r in picked),
                  key=lambda r: r["symbol"])


def fetch_nyse100() -> list[dict]:
    resp = requests.get(NYSE_SCREENER_URL, timeout=60, headers=_NASDAQ_HEADERS)
    resp.raise_for_status()
    rows = (resp.json().get("data") or {}).get("rows") or []
    try:
        current = set(load("nyse100").symbols)
    except (OSError, ValueError, KeyError):
        current = set()
    return select_nyse100(rows, current)


_SPECS = {
    "nifty100": ("NIFTY 100", NSE_NIFTY100_URL, fetch_nifty100),
    "nasdaq100": ("NASDAQ-100", NASDAQ100_URL, fetch_nasdaq100),
    "nyse100": ("NYSE top 100", NYSE_SCREENER_URL, fetch_nyse100),
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
