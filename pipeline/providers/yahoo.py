"""End-of-day prices from Yahoo Finance's public chart endpoint.

Same endpoint the local tool used for US candles (it avoids yfinance's
cookie/crumb layer). Used for both markets on the public site: Zerodha
Kite Connect terms forbid displaying its market data — or works derived
from it — to the public, so Kite is deliberately not a source here.
"""

from __future__ import annotations

import datetime
import math
import time
from dataclasses import dataclass
from urllib.parse import quote
from zoneinfo import ZoneInfo

import requests

from pipeline.clock import iso, now_ist
from pipeline.log import Logger

CHART_HOSTS = ("https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com")
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
RETRYABLE_STATUS = {429, 500, 502, 503, 504}


class ProviderError(RuntimeError):
    pass


@dataclass(frozen=True)
class Session:
    """Exchange session used to drop a still-forming daily bar."""
    tz: ZoneInfo
    close: datetime.time
    settle_minutes: int = 15


def _finite_positive(*values: float) -> bool:
    return all(v is not None and math.isfinite(v) and v > 0 for v in values)


class YahooChart:
    def __init__(self, log: Logger | None = None, *, pause_s: float = 0.25,
                 retries: int = 4, timeout_s: float = 15.0) -> None:
        self.log = log or Logger("yahoo")
        self.pause_s = pause_s
        self.retries = retries
        self.timeout_s = timeout_s
        self.http = requests.Session()
        self.http.headers.update({"User-Agent": USER_AGENT,
                                  "Accept": "application/json,text/plain,*/*"})

    def _chart(self, symbol: str, range_: str) -> dict:
        path = "/v8/finance/chart/" + quote(symbol, safe="")
        params = {"range": range_, "interval": "1d", "events": "history",
                  "includePrePost": "false"}
        last_err = "no attempt made"
        for attempt in range(self.retries):
            host = CHART_HOSTS[attempt % len(CHART_HOSTS)]
            try:
                resp = self.http.get(host + path, params=params, timeout=self.timeout_s)
            except requests.RequestException as exc:
                last_err = f"{type(exc).__name__}: {exc}"
            else:
                if resp.status_code == 404:
                    raise ProviderError(f"{symbol}: not found on Yahoo")
                if resp.status_code in RETRYABLE_STATUS:
                    last_err = f"HTTP {resp.status_code}"
                else:
                    try:
                        resp.raise_for_status()
                        payload = resp.json()
                    except (requests.RequestException, ValueError) as exc:
                        raise ProviderError(f"{symbol}: {exc}") from exc
                    chart = payload.get("chart") or {}
                    if chart.get("error"):
                        err = chart["error"]
                        raise ProviderError(f"{symbol}: {err.get('description') or err}")
                    results = chart.get("result") or []
                    if not results:
                        raise ProviderError(f"{symbol}: empty chart response")
                    time.sleep(self.pause_s)
                    return results[0]
            time.sleep(min(20.0, 1.5 * (2 ** attempt)))
        raise ProviderError(f"{symbol}: gave up after {self.retries} attempts ({last_err})")

    def daily_candles(self, symbol: str, range_: str = "2y",
                      session: Session | None = None) -> list[dict]:
        """Oldest-first daily OHLCV candles with exchange-local dates.

        When `session` is given and the latest bar belongs to a session that
        has not settled yet, that partial bar is dropped so every indicator
        is computed on completed days only.
        """
        result = self._chart(symbol, range_)
        meta = result.get("meta") or {}
        offset = int(meta.get("gmtoffset") or 0)
        quote_rows = ((result.get("indicators") or {}).get("quote") or [{}])[0]
        opens = quote_rows.get("open") or []
        highs = quote_rows.get("high") or []
        lows = quote_rows.get("low") or []
        closes = quote_rows.get("close") or []
        volumes = quote_rows.get("volume") or []

        by_date: dict[datetime.date, dict] = {}
        for i, ts in enumerate(result.get("timestamp") or []):
            try:
                o, h, lo, c = (float(opens[i]), float(highs[i]),
                               float(lows[i]), float(closes[i]))
            except (IndexError, TypeError, ValueError):
                continue
            if not _finite_positive(o, h, lo, c):
                continue
            try:
                v = float(volumes[i] or 0.0)
            except (IndexError, TypeError, ValueError):
                v = 0.0
            day = datetime.datetime.fromtimestamp(
                int(ts) + offset, tz=datetime.timezone.utc).date()
            by_date[day] = {"date": day, "open": o, "high": max(h, o, c),
                            "low": min(lo, o, c), "close": c,
                            "volume": v if math.isfinite(v) and v > 0 else 0.0}

        candles = [by_date[d] for d in sorted(by_date)]
        if session and candles:
            local_now = datetime.datetime.now(session.tz)
            settled = (datetime.datetime.combine(local_now.date(), session.close)
                       + datetime.timedelta(minutes=session.settle_minutes)).time()
            if candles[-1]["date"] >= local_now.date() and local_now.time() < settled:
                candles = candles[:-1]
        return candles

    def usd_inr(self) -> dict:
        """Latest USD->INR rate, or a zero rate when Yahoo is unavailable."""
        try:
            result = self._chart("USDINR=X", "5d")
        except ProviderError as exc:
            self.log.warning(f"USD/INR unavailable: {exc}")
            return {"usd_inr": 0.0, "as_of": "", "source": "unavailable"}
        meta = result.get("meta") or {}
        rate = meta.get("regularMarketPrice")
        if not isinstance(rate, (int, float)) or not _finite_positive(float(rate)):
            closes = [c for c in (((result.get("indicators") or {}).get("quote")
                                   or [{}])[0].get("close") or [])
                      if isinstance(c, (int, float)) and _finite_positive(float(c))]
            rate = closes[-1] if closes else 0.0
        return {"usd_inr": round(float(rate), 4), "as_of": iso(now_ist()),
                "source": "Yahoo Finance (USDINR=X)"}
