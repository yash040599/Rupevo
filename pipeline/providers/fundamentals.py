"""US company fundamentals for the long-term scorer, from yfinance.

Migrated from ai-portfolio-manager `modes/us/fundamentals.py`. The field
normalisation is unchanged so the scorecard sees the same inputs:
  * ratios like margins / ROE arrive as fractions -> stored as percent
  * `debtToEquity` arrives as a percentage -> stored as a plain ratio
  * anything missing or non-finite becomes ``None``, never 0.0

Differences from the local tool: the cache path is injectable (CI keeps it
in actions/cache), and a failed lookup is retried after a day instead of
being frozen for the full cache window — a throttled CI run must not blank
a company's fundamentals for two weeks.
"""

from __future__ import annotations

import datetime
import json
import math
import os
import time
from typing import Any

from pipeline.clock import now_ist
from pipeline.log import Logger

DEFAULT_MAX_AGE_DAYS = 14
UNAVAILABLE_RETRY_DAYS = 1


# ── Normalisation helpers ───────────────────────────────────────

def _num(value: Any) -> float | None:
    """Finite float or None. Zero is preserved; junk is dropped."""
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _pct_from_fraction(value: Any) -> float | None:
    """0.34 -> 34.0. Values already in percent are left alone."""
    v = _num(value)
    if v is None:
        return None
    return v * 100.0 if abs(v) <= 1.5 else v


def _dividend_yield_pct(value: Any) -> float | None:
    """yfinance has shipped this as both a fraction and a percent; anything
    at or below 0.25 is read as a fraction."""
    v = _num(value)
    if v is None or v < 0:
        return None
    pct = v * 100.0 if v <= 0.25 else v
    return min(pct, 25.0)


def _statement_value(frame, *labels: str) -> float | None:
    """Most recent value of the first matching row in a yfinance frame."""
    if frame is None:
        return None
    try:
        if frame.empty:
            return None
        for label in labels:
            if label in frame.index:
                return _num(frame.loc[label].iloc[0])
    except Exception:  # noqa: BLE001 — shape varies by ticker
        return None
    return None


def _free_cash_flow(ticker) -> tuple[float | None, float | None]:
    """(free cash flow, revenue) from the statements.

    `info["freeCashflow"]` is not trustworthy (it reported ~16.5bn for MSFT
    against a filed 67bn), so the statements win.
    """
    try:
        cashflow = ticker.cashflow
    except Exception:  # noqa: BLE001
        return None, None

    fcf = _statement_value(cashflow, "Free Cash Flow")
    if fcf is None:
        ocf = _statement_value(cashflow, "Operating Cash Flow",
                               "Total Cash From Operating Activities")
        capex = _statement_value(cashflow, "Capital Expenditure",
                                 "Capital Expenditures")
        if ocf is not None and capex is not None:
            fcf = ocf - abs(capex)

    try:
        revenue = _statement_value(ticker.financials, "Total Revenue")
    except Exception:  # noqa: BLE001
        revenue = None
    return fcf, revenue


def fetch(symbol: str) -> dict:
    """Pull one company's fundamentals. Returns {} on any failure."""
    sym = (symbol or "").strip().upper()
    if not sym:
        return {}
    try:
        import yfinance as yf
        ticker = yf.Ticker(sym)
        info = ticker.info or {}
    except Exception:  # noqa: BLE001 — a missing profile is not fatal
        return {}
    if not info or not (info.get("longName") or info.get("shortName")
                        or info.get("marketCap")):
        return {}

    debt_to_equity = _num(info.get("debtToEquity"))
    if debt_to_equity is not None:
        debt_to_equity = debt_to_equity / 100.0

    market_cap = _num(info.get("marketCap"))
    stmt_fcf, stmt_revenue = _free_cash_flow(ticker)
    fcf = stmt_fcf if stmt_fcf is not None else _num(info.get("freeCashflow"))
    revenue = stmt_revenue if stmt_revenue is not None else _num(info.get("totalRevenue"))

    return {
        "symbol": sym,
        "fetched_at": now_ist().isoformat(timespec="seconds"),
        "name": str(info.get("longName") or info.get("shortName") or ""),
        "sector": str(info.get("sector") or ""),
        "industry": str(info.get("industry") or ""),
        "trailing_pe": _num(info.get("trailingPE")),
        "forward_pe": _num(info.get("forwardPE")),
        "price_to_book": _num(info.get("priceToBook")),
        "ev_to_ebitda": _num(info.get("enterpriseToEbitda")),
        "fcf_yield_pct": (fcf / market_cap * 100.0)
                         if (fcf and market_cap and market_cap > 0) else None,
        "free_cash_flow": fcf,
        "fcf_source": "statement" if stmt_fcf is not None else "info",
        "dividend_yield_pct": _dividend_yield_pct(info.get("dividendYield")),
        "payout_ratio_pct": _pct_from_fraction(info.get("payoutRatio")),
        "roe_pct": _pct_from_fraction(info.get("returnOnEquity")),
        "roa_pct": _pct_from_fraction(info.get("returnOnAssets")),
        "gross_margin_pct": _pct_from_fraction(info.get("grossMargins")),
        "operating_margin_pct": _pct_from_fraction(info.get("operatingMargins")),
        "net_margin_pct": _pct_from_fraction(info.get("profitMargins")),
        "fcf_margin_pct": (fcf / revenue * 100.0)
                          if (fcf and revenue and revenue > 0) else None,
        "debt_to_equity": debt_to_equity,
        "current_ratio": _num(info.get("currentRatio")),
        "total_debt": _num(info.get("totalDebt")),
        "total_cash": _num(info.get("totalCash")),
        "revenue_growth_pct": _pct_from_fraction(info.get("revenueGrowth")),
        "earnings_growth_pct": _pct_from_fraction(info.get("earningsGrowth")),
        "market_cap": market_cap,
        "beta": _num(info.get("beta")),
    }


class FundamentalsStore:
    """JSON-file cache of `fetch()` results keyed by ticker."""

    def __init__(self, path: str, log: Logger | None = None) -> None:
        self.path = path
        self.log = log or Logger("fundamentals")
        self._data: dict[str, dict] | None = None

    def _load(self) -> dict[str, dict]:
        if self._data is None:
            try:
                with open(self.path, encoding="utf-8") as fh:
                    self._data = dict(json.load(fh).get("symbols") or {})
            except (OSError, ValueError):
                self._data = {}
        return self._data

    def _save(self) -> None:
        data = self._load()
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"updated_at": now_ist().isoformat(timespec="seconds"),
                       "count": len(data), "symbols": data},
                      fh, indent=1, default=str)
        os.replace(tmp, self.path)

    def get(self, symbol: str) -> dict:
        row = self._load().get((symbol or "").strip().upper(), {})
        return {} if row.get("unavailable") else row

    @staticmethod
    def _is_fresh(row: dict, max_age_days: int) -> bool:
        stamp = str(row.get("fetched_at") or "")
        if not stamp:
            return False
        try:
            fetched = datetime.datetime.fromisoformat(stamp).date()
        except ValueError:
            return False
        limit = UNAVAILABLE_RETRY_DAYS if row.get("unavailable") else max_age_days
        return (now_ist().date() - fetched).days <= limit

    def ensure(self, symbols: list[str], *,
               max_age_days: int = DEFAULT_MAX_AGE_DAYS,
               pause_s: float = 0.3) -> None:
        """Refresh stale symbols in place; failures are stamped so a delisted
        ticker is not retried on every run."""
        data = self._load()
        fetched = fresh = failed = 0
        for raw in symbols:
            sym = (raw or "").strip().upper()
            if not sym:
                continue
            if self._is_fresh(data.get(sym) or {}, max_age_days):
                fresh += 1
                continue
            row = fetch(sym)
            if row:
                data[sym] = row
                fetched += 1
            else:
                data[sym] = {"symbol": sym, "unavailable": True,
                             "fetched_at": now_ist().isoformat(timespec="seconds")}
                failed += 1
            time.sleep(pause_s)
        if fetched or failed:
            self._save()
        self.log.info(f"fundamentals: {fetched} fetched, {fresh} fresh, "
                      f"{failed} unavailable")
