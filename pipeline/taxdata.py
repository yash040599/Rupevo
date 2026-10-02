"""Reference data for the tax tools: SBI exchange rates, prices and dividends.

Published under site/data/tax/ and used in the browser by the RSU tools,
which compute Schedule FA values from a user's own broker export without
uploading it anywhere:

* sbi-tt-buy-usd.json: State Bank of India's telegraphic-transfer (TT) buying
  rate for USD, the rate the ITR instructions prescribe for Schedule FA,
  taken from the daily SBI forex card rates archived by
  github.com/sahilgupta/sbi-fx-ratekeeper (MIT). When SBI revises a rate
  during the day, the first rate of the day is kept.
* <symbol>.json: daily closing prices (Yahoo Finance, split-adjusted, not
  dividend-adjusted) and cash dividends with ex/record/payment dates
  (Nasdaq; Yahoo ex-dates as a fallback).

A source that fails, or returns less history than the published file
already has, leaves that file untouched.
"""

from __future__ import annotations

import csv
import datetime
import io
import json
import os
import re

import requests

from pipeline.clock import NEW_YORK, iso, now_ist
from pipeline.log import Logger
from pipeline.providers.yahoo import USER_AGENT, ProviderError, Session, YahooChart

SBI_USD_CSV = ("https://raw.githubusercontent.com/sahilgupta/sbi-fx-ratekeeper/"
               "main/csv_files/SBI_REFERENCE_RATES_USD.csv")
SBI_SOURCE_PAGE = "https://github.com/sahilgupta/sbi-fx-ratekeeper"
NASDAQ_DIVIDENDS = "https://api.nasdaq.com/api/quote/{symbol}/dividends?assetclass=stocks"
US_SESSION = Session(NEW_YORK, datetime.time(16, 0))
PRICE_RANGE = "10y"
MIN_RATE_ROWS = 1000
MIN_PRICE_ROWS = 1000

TAX_STOCKS: dict[str, dict] = {
    "MSFT": {"name": "Microsoft Corporation", "exchange": "NASDAQ"},
}

RATES_FILE = "sbi-tt-buy-usd.json"


class TaxDataError(RuntimeError):
    pass


def stock_file(symbol: str) -> str:
    return f"{symbol.lower()}.json"


# ── Parsing ─────────────────────────────────────────────────────

def parse_sbi_csv(text: str) -> list[list]:
    """[[ISO date, TT buying rate], ...] keeping SBI's first rate of each day.

    Rows without a TT rate (the archive has 0.00 on some early Saturdays)
    and implausible values are dropped.
    """
    first: dict[str, tuple[str, float]] = {}
    for row in csv.DictReader(io.StringIO(text.lstrip("\ufeff"))):
        stamp = (row.get("DATE") or "").strip()
        day = stamp[:10]
        try:
            datetime.date.fromisoformat(day)
            rate = float((row.get("TT BUY") or "0").strip())
        except ValueError:
            continue
        if not 40.0 <= rate <= 250.0:
            continue
        if day not in first or stamp < first[day][0]:
            first[day] = (stamp, rate)
    return [[day, round(first[day][1], 4)] for day in sorted(first)]


def _us_date(text: str) -> str | None:
    """'08/20/2026' -> '2026-08-20'; 'N/A' or junk -> None."""
    match = re.fullmatch(r"\s*(\d{1,2})/(\d{1,2})/(\d{4})\s*", text or "")
    if not match:
        return None
    month, day, year = (int(g) for g in match.groups())
    try:
        return datetime.date(year, month, day).isoformat()
    except ValueError:
        return None


def parse_nasdaq_dividends(payload: dict) -> list[dict]:
    rows = (((payload or {}).get("data") or {}).get("dividends") or {}).get("rows") or []
    out = []
    for row in rows:
        if str(row.get("type") or "").strip().lower() != "cash":
            continue
        try:
            amount = float(str(row.get("amount") or "").replace("$", "").replace(",", ""))
        except ValueError:
            continue
        ex = _us_date(row.get("exOrEffDate"))
        if not ex or amount <= 0:
            continue
        out.append({"ex": ex, "record": _us_date(row.get("recordDate")),
                    "pay": _us_date(row.get("paymentDate")),
                    "declared": _us_date(row.get("declarationDate")),
                    "amount": round(amount, 6)})
    return sorted(out, key=lambda d: d["ex"])


def merge_dividends(primary: list[dict], *fallbacks: list[dict]) -> list[dict]:
    """Primary rows win; fallback rows only add dividends the primary lacks.

    A fallback row within 3 days of an existing row with the same amount is
    the same dividend reported with a different ex-date, so it is skipped.
    """
    by_ex = {d["ex"]: dict(d) for d in primary}

    def known(ex: str, amount: float) -> bool:
        day = datetime.date.fromisoformat(ex)
        return any(abs((datetime.date.fromisoformat(k) - day).days) <= 3
                   and abs(v["amount"] - amount) < 0.005 for k, v in by_ex.items())

    for rows in fallbacks:
        for d in rows:
            if d["ex"] in by_ex or known(d["ex"], d["amount"]):
                continue
            by_ex[d["ex"]] = {"ex": d["ex"], "record": d.get("record"),
                              "pay": d.get("pay"), "declared": d.get("declared"),
                              "amount": d["amount"]}
    return [by_ex[k] for k in sorted(by_ex)]


# ── Output ──────────────────────────────────────────────────────

def dump_json(obj: dict, row_keys: tuple[str, ...]) -> str:
    """JSON with one list item per line for `row_keys`, so weekly updates
    show up in git as a few appended lines rather than one rewritten line."""
    items = list(obj.items())
    lines = ["{"]
    for i, (key, value) in enumerate(items):
        comma = "," if i < len(items) - 1 else ""
        if key in row_keys and isinstance(value, list):
            inner = ",\n".join("  " + json.dumps(v, separators=(",", ":"), ensure_ascii=False)
                               for v in value)
            lines.append(f" {json.dumps(key)}: [\n{inner}\n ]{comma}")
        else:
            lines.append(f" {json.dumps(key)}: {json.dumps(value, ensure_ascii=False)}{comma}")
    lines.append("}")
    return "\n".join(lines) + "\n"


def _write(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    os.replace(tmp, path)


def _load(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as fh:
            blob = json.load(fh)
        return blob if isinstance(blob, dict) else {}
    except (OSError, ValueError):
        return {}


# ── Builders ────────────────────────────────────────────────────

def build_rates(out_dir: str, log: Logger, http: requests.Session) -> dict:
    path = os.path.join(out_dir, RATES_FILE)
    resp = http.get(SBI_USD_CSV, timeout=30)
    resp.raise_for_status()
    rates = parse_sbi_csv(resp.text)
    previous = _load(path).get("rates") or []
    if len(rates) < MIN_RATE_ROWS:
        raise TaxDataError(f"only {len(rates)} SBI rate rows; refusing to publish")
    if previous and rates[-1][0] < previous[-1][0]:
        raise TaxDataError(f"SBI rates end {rates[-1][0]}, older than the published "
                           f"{previous[-1][0]}; keeping the published file")
    _write(path, dump_json({
        "currency": "USD",
        "rate": "SBI telegraphic transfer (TT) buying rate, INR per USD",
        "source": "State Bank of India forex card rates, archived by sbi-fx-ratekeeper (MIT)",
        "source_url": SBI_SOURCE_PAGE,
        "generated_at": iso(now_ist()),
        "first": rates[0][0],
        "last": rates[-1][0],
        "rates": rates,
    }, row_keys=("rates",)))
    log.info(f"SBI TT buying rates: {len(rates)} days, {rates[0][0]} to {rates[-1][0]}")
    return {"file": RATES_FILE, "rows": len(rates), "last": rates[-1][0]}


def fetch_nasdaq_dividends(symbol: str, http: requests.Session) -> list[dict]:
    resp = http.get(NASDAQ_DIVIDENDS.format(symbol=symbol), timeout=30, headers={
        "User-Agent": USER_AGENT,
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://www.nasdaq.com",
        "Referer": "https://www.nasdaq.com/",
    })
    resp.raise_for_status()
    return parse_nasdaq_dividends(resp.json())


def build_stock(symbol: str, out_dir: str, log: Logger, chart: YahooChart,
                http: requests.Session) -> dict:
    meta = TAX_STOCKS[symbol]
    path = os.path.join(out_dir, stock_file(symbol))
    previous = _load(path)

    candles = chart.daily_candles(symbol, PRICE_RANGE, US_SESSION)
    closes = [[c["date"].isoformat(), round(c["close"], 4)] for c in candles]
    if len(closes) < MIN_PRICE_ROWS:
        raise TaxDataError(f"{symbol}: only {len(closes)} daily closes; refusing to publish")
    old_closes = previous.get("closes") or []
    if old_closes and closes[-1][0] < old_closes[-1][0]:
        raise TaxDataError(f"{symbol}: prices end {closes[-1][0]}, older than the "
                           f"published {old_closes[-1][0]}")

    try:
        yahoo_divs = chart.dividends(symbol, PRICE_RANGE)
    except ProviderError as exc:
        log.warning(f"{symbol}: Yahoo dividends unavailable ({exc})")
        yahoo_divs = []
    previous_divs = previous.get("dividends") or []
    try:
        nasdaq_divs = fetch_nasdaq_dividends(symbol, http)
        merged = merge_dividends(nasdaq_divs, previous_divs)
        source = "Nasdaq"
    except (requests.RequestException, ValueError) as exc:
        log.warning(f"{symbol}: Nasdaq dividends unavailable ({exc}); using the "
                    "published list plus Yahoo ex-dates")
        merged = merge_dividends(previous_divs, yahoo_divs)
        source = "Nasdaq (earlier refresh) and Yahoo Finance"
    first_close = closes[0][0]
    dividends = [d for d in merged if d["ex"] >= first_close]
    if not dividends:
        raise TaxDataError(f"{symbol}: no dividend history")

    yahoo_by_ex = {d["ex"]: d["amount"] for d in yahoo_divs}
    for d in dividends:
        other = yahoo_by_ex.get(d["ex"])
        if other is not None and abs(other - d["amount"]) > 0.005:
            log.warning(f"{symbol}: dividend {d['ex']} is {d['amount']} on Nasdaq "
                        f"but {other} on Yahoo")

    _write(path, dump_json({
        "symbol": symbol,
        "name": meta["name"],
        "exchange": meta["exchange"],
        "currency": "USD",
        "generated_at": iso(now_ist()),
        "sources": {"prices": "Yahoo Finance daily close (split-adjusted)",
                    "dividends": source},
        "first": closes[0][0],
        "last": closes[-1][0],
        "closes": closes,
        "dividends": dividends,
    }, row_keys=("closes", "dividends")))
    log.info(f"{symbol}: {len(closes)} closes to {closes[-1][0]}, "
             f"{len(dividends)} dividends")
    return {"file": stock_file(symbol), "rows": len(closes), "last": closes[-1][0]}


def build_all(out_dir: str, log: Logger | None = None) -> list[dict]:
    """Refresh every tax data file; one failure does not stop the others."""
    log = log or Logger("tax-data")
    http = requests.Session()
    http.headers.update({"User-Agent": USER_AGENT})
    chart = YahooChart(Logger("yahoo"))
    jobs = [("SBI rates", lambda: build_rates(out_dir, log, http))]
    jobs += [(sym, (lambda s=sym: build_stock(s, out_dir, log, chart, http)))
             for sym in TAX_STOCKS]
    results = []
    for name, job in jobs:
        try:
            results.append({"name": name, "ok": True, **job()})
        except (TaxDataError, ProviderError, requests.RequestException, ValueError) as exc:
            log.error(f"{name}: not updated ({exc})")
            results.append({"name": name, "ok": False, "error": str(exc)[:300]})
    return results
