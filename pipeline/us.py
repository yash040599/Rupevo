"""US rankings — the public version of the local US long-term scan.

Two lists are ranked the same way, each into its own snapshot: the
NASDAQ-100 (site/data/us.json) and the NYSE top 100, the 100 largest US
companies listed on the NYSE (site/data/us-nyse.json); the US page shows
them together or one exchange at a time.

Every constituent is scored by the six-pillar long-term scorecard
(`engine/us_longterm.py`: quality, valuation vs sector, growth, 12-1
momentum, financial strength, risk) and ranked in the local tool's order:
rating tier first (after the thin-coverage cap), then composite score.

Deliberate differences from the local tool, all for a public screener:
  * The universes are the actual NASDAQ-100 and a rule-based NYSE list,
    not the local "US100" list of the largest US companies across exchanges.
  * Every constituent is ranked; the local tool hid the AVOID tail.
  * Rating bands are published under neutral labels (Excellent … Poor)
    and no accumulate/avoid action, ticket size or price level is emitted.
"""

from __future__ import annotations

import datetime
import math
import os

from pipeline.clock import NEW_YORK, iso, now_ist
from pipeline.engine.quant_metrics import profile as quant_profile
from pipeline.engine.swing_signals import compute_swing_indicators
from pipeline.engine.us_longterm import score_long_term
from pipeline.log import Logger
from pipeline.providers.fundamentals import FundamentalsStore
from pipeline.providers.yahoo import ProviderError, Session, YahooChart
from pipeline.snapshot import (
    SCHEMA_VERSION, SnapshotError, benchmark_context, change_1d_pct,
    quant_fields, rnd,
)
from pipeline.universes import Constituent, Universe

SESSION = Session(NEW_YORK, datetime.time(16, 0))
HISTORY_RANGE = "5y"
BENCHMARK_SYMBOL = "SPY"
BENCHMARK_NAME = "S&P 500 (SPY)"
RISK_FREE_PCT = 4.5
MIN_BARS = 60
MAX_FAILURE_SHARE = 0.2

BAND_LABELS = {
    "HIGH CONVICTION": "Excellent",
    "ACCUMULATE": "Strong",
    "NEUTRAL": "Average",
    "WEAK": "Weak",
    "AVOID": "Poor",
}
# Rank tiers reproduce the local tool's action-first ordering for names
# that are not owned (ACCUMULATE, then WATCH, then AVOID).
_TIER = {"HIGH CONVICTION": 0, "ACCUMULATE": 0, "NEUTRAL": 1, "WEAK": 1, "AVOID": 2}
VALUATION_LABELS = {
    "CHEAP vs sector": "P/E below sector",
    "FAIR vs sector": "P/E near sector",
    "RICH vs sector": "P/E above sector",
    "EXPENSIVE vs sector": "P/E far above sector",
    "UNKNOWN": "P/E unavailable",
}
FUNDAMENTAL_FIELDS = (
    "sector", "industry", "market_cap", "trailing_pe", "forward_pe",
    "price_to_book", "ev_to_ebitda", "fcf_yield_pct", "dividend_yield_pct",
    "roe_pct", "roa_pct", "gross_margin_pct", "operating_margin_pct",
    "net_margin_pct", "fcf_margin_pct", "debt_to_equity", "current_ratio",
    "revenue_growth_pct", "earnings_growth_pct", "beta", "fetched_at",
)

def model_for(list_name: str) -> dict:
    return {
        "name": f"{list_name} long-term scorecard",
        "horizon": "Years (buy-and-hold)",
        "summary": (f"Each {list_name} company is scored 0-100 on six pillars: quality "
                    "and profitability (24), valuation against its sector (18), "
                    "growth (17), 12-1 month momentum (16), financial strength (13) "
                    "and risk and drawdown (12). Pillars without data are dropped "
                    "and the rest re-weighted; low coverage caps the band."),
    }


def yahoo_symbol(symbol: str) -> str:
    return symbol.replace(".", "-").strip().upper()


def _whole(x: float) -> int:
    """Round like the site does: the published 1-dp value, half up."""
    return int(math.floor(round(float(x), 1) + 0.5))


def _public_summary(lt, band_label: str) -> str:
    covered = [p for p in lt.pillars if p.covered]
    top = max(covered, key=lambda p: p.score, default=None)
    weak = min(covered, key=lambda p: p.score, default=None)
    bits = []
    if top:
        bits.append(f"strongest on {top.name.lower()} ({_whole(top.score)})")
    if weak and weak is not top:
        bits.append(f"weakest on {weak.name.lower()} ({_whole(weak.score)})")
    return (f"{band_label} at {_whole(lt.composite)}/100"
            + (" — " + ", ".join(bits) if bits else ""))


def _fundamentals_view(f: dict) -> dict:
    out = {}
    for key in FUNDAMENTAL_FIELDS:
        value = f.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            value = rnd(value, 0 if key == "market_cap" else 2)
        out[key] = value
    return out


def evaluate(con: Constituent, candles: list[dict], bench: list[dict],
             fundamentals: dict) -> dict:
    """Score one company. Pure: candles + fundamentals in, public row out."""
    row = {"symbol": con.symbol, "name": con.name or fundamentals.get("name", ""),
           "sector": fundamentals.get("sector") or con.industry or "",
           "industry": fundamentals.get("industry", ""),
           "rank": None, "status": "", "status_reason": ""}
    if candles:
        row.update(close=rnd(candles[-1]["close"]),
                   last_date=candles[-1]["date"].isoformat())
    if len(candles) < MIN_BARS:
        row.update(status="insufficient_data",
                   status_reason=f"Only {len(candles)} trading days of history "
                                 f"(the model needs {MIN_BARS})")
        return row
    ind = compute_swing_indicators(candles, bench)
    if not ind.get("valid"):
        row.update(status="insufficient_data",
                   status_reason=ind.get("reason") or "Indicators not computable")
        return row

    closes = [float(c["close"]) for c in candles]
    bench_closes = [float(c["close"]) for c in bench]
    lt = score_long_term(fundamentals, closes, bench_closes or None)
    quant = quant_profile(candles, bench, risk_free_pct=RISK_FREE_PCT)
    band_label = BAND_LABELS.get(lt.rating, lt.rating.title())
    h52 = float(ind.get("high_52w") or 0.0)
    current = float(ind["current"])

    row.update(
        status="ranked",
        score=rnd(lt.composite, 1),
        band=lt.rating.lower().replace(" ", "-"),
        band_label=band_label,
        coverage_pct=rnd(lt.coverage_pct, 0),
        valuation=VALUATION_LABELS.get(lt.valuation_band, lt.valuation_band),
        risk_score=rnd(lt.risk_score, 1),
        risk_grade=lt.risk_grade,
        pillars=[{"name": p.name, "score": rnd(p.score, 1) if p.covered else None,
                  "weight": p.weight, "covered": p.covered, "drivers": p.drivers}
                 for p in lt.pillars],
        risk_drivers=list(lt.risk_drivers),
        summary=_public_summary(lt, band_label),
        fundamentals=_fundamentals_view(fundamentals),
        has_fundamentals=bool(fundamentals),
        change_1d_pct=rnd(change_1d_pct(candles)),
        high_52w=rnd(h52), low_52w=rnd(ind.get("low_52w")),
        below_52w_high_pct=rnd((h52 - current) / h52 * 100.0 if h52 > 0 else None),
        rsi=rnd(ind.get("rsi"), 1),
        ema_20=rnd(ind.get("ema_20")), sma_50=rnd(ind.get("sma_50")),
        sma_200=rnd(ind.get("sma_200")),
        **quant_fields(quant),
    )
    row["_tier"] = _TIER.get(lt.rating, 3)
    return row


def build(universe: Universe, chart: YahooChart, cache_dir: str,
          log: Logger | None = None, *, limit: int | None = None,
          market: str = "us", exchange: str = "NASDAQ",
          constituents_source: str = "Nasdaq") -> dict:
    """Rank one list. `market` names the snapshot (us, us-nyse) and `exchange` is
    stamped on it and on every row, so the site can show both lists together."""
    log = log or Logger(market)
    started = now_ist()
    bench = chart.daily_candles(BENCHMARK_SYMBOL, HISTORY_RANGE, SESSION)
    if len(bench) < 260:
        raise SnapshotError(f"SPY history too short ({len(bench)} bars)")
    data_through = bench[-1]["date"]

    constituents = universe.constituents[:limit] if limit else universe.constituents
    store = FundamentalsStore(os.path.join(cache_dir, "us_fundamentals.json"), log)
    store.ensure([yahoo_symbol(c.symbol) for c in constituents])

    rows: list[dict] = []
    errors: list[dict] = []
    for i, con in enumerate(constituents, 1):
        try:
            candles = chart.daily_candles(yahoo_symbol(con.symbol), HISTORY_RANGE, SESSION)
        except ProviderError as exc:
            errors.append({"symbol": con.symbol, "error": str(exc)[:200]})
            log.warning(f"{con.symbol}: {exc}")
            continue
        candles = [c for c in candles if c["date"] <= data_through]
        row = evaluate(con, candles, bench, store.get(yahoo_symbol(con.symbol)))
        row["exchange"] = exchange
        rows.append(row)
        if i % 25 == 0:
            log.info(f"scanned {i}/{len(constituents)}")

    if len(errors) > MAX_FAILURE_SHARE * len(constituents):
        raise SnapshotError(f"{len(errors)} of {len(constituents)} stocks failed to "
                            "download; keeping the previous snapshot")

    ranked = [r for r in rows if r["status"] == "ranked"]
    ranked.sort(key=lambda r: (r["_tier"], -(r["score"] or 0.0),
                               -(r["coverage_pct"] or 0.0), r["symbol"]))
    for rank, r in enumerate(ranked, 1):
        r["rank"] = rank
        del r["_tier"]
    others = sorted((r for r in rows if r["status"] != "ranked"),
                    key=lambda r: r["symbol"])

    by_band: dict[str, int] = {}
    for r in ranked:
        by_band[r["band_label"]] = by_band.get(r["band_label"], 0) + 1
    no_fundamentals = sum(1 for r in ranked if not r["has_fundamentals"])

    log.info(f"ranked {len(ranked)} of {len(rows)} companies "
             f"({len(errors)} download errors, {no_fundamentals} without fundamentals)")
    return {
        "schema": SCHEMA_VERSION,
        "market": market,
        "exchange": exchange,
        "title": f"{universe.name} Ranking",
        "currency": "USD",
        "generated_at": iso(now_ist()),
        "started_at": iso(started),
        "data_through": data_through.isoformat(),
        "universe": {"name": universe.name, "as_of": universe.as_of,
                     "source": constituents_source, "count": len(universe.constituents)},
        "data_source": {"prices": "Yahoo Finance (end-of-day)",
                        "fundamentals": "Yahoo Finance",
                        "constituents": constituents_source},
        "benchmark": benchmark_context(BENCHMARK_SYMBOL, BENCHMARK_NAME, bench,
                                       RISK_FREE_PCT),
        "model": model_for(universe.name),
        "partial": bool(limit),
        "stats": {"scanned": len(constituents), "evaluated": len(rows),
                  "ranked": len(ranked), "not_ranked": len(others),
                  "errors": len(errors), "by_band": by_band,
                  "without_fundamentals": no_fundamentals},
        "ranked": ranked,
        "others": others,
        "errors": errors,
    }
