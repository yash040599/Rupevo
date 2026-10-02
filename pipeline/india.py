"""Indian Nifty 100 ranking — the public version of the local swing scan.

Pipeline (same order as ai-portfolio-manager `SwingManager.run`):
  1. Technical scan: best of four setup families per stock
     (`classify_setup`), graded for technical strength and risk.
     A setup whose reward/risk under the 52-week-high cap is below 2.0
     is filtered out, exactly like the local risk engine.
  2. 52-week-dip screen for every stock without an accepted setup:
     a close 10%+ below the rolling 252-day closing high.
  3. Sector-leader bonus (+0.5) for ranked names in the three sectors
     with the highest mean relative strength.
  4. One unified rank: technical setups first by score, then dips by
     depth.

Deliberate differences from the local tool, all for a public screener:
  * No entry / stop / target / quantity is published.
  * No per-ticket quantity filter (the local tool dropped stocks priced
    above its Rs.20,000 ticket).
  * Sector relative strength averages each stock once. The local scan
    averaged its raw candidate list, where no-setup rows carried RS 0
    and dip rows duplicated symbols, which diluted every sector mean.
"""

from __future__ import annotations

import datetime

from pipeline.clock import IST, iso, now_ist
from pipeline.engine.indicators import adx as compute_adx
from pipeline.engine.quant_metrics import profile as quant_profile
from pipeline.engine.swing_conviction import grade
from pipeline.engine.swing_risk import compute_entry_risk
from pipeline.engine.swing_signals import (
    SECTOR_LEADER_BONUS, classify_setup, compute_sector_rs,
    compute_swing_indicators, top_n_sectors_by_rs,
)
from pipeline.log import Logger
from pipeline.providers.yahoo import ProviderError, Session, YahooChart
from pipeline.snapshot import (
    SCHEMA_VERSION, SnapshotError, benchmark_context, change_1d_pct,
    inr_text, public_notes, quant_fields, rnd,
)
from pipeline.universes import Constituent, Universe
from pipeline.universes.sectors import sector_label, sector_of

SESSION = Session(IST, datetime.time(15, 30))
HISTORY_RANGE = "2y"
BENCHMARK_SYMBOL = "^NSEI"
BENCHMARK_NAME = "NIFTY 50"
RISK_FREE_PCT = 6.5
MIN_BARS = 50
DIP_PCT = 10.0
DIP_LOOKBACK_BARS = 252
MAX_FAILURE_SHARE = 0.2

SETUP_LABELS = {
    "BREAKOUT": "Breakout",
    "PULLBACK_UPTREND": "Pullback in uptrend",
    "TREND_CONTINUATION": "Trend continuation",
    "SUPPORT_REVERSAL": "Support reversal",
    "52W_DIP": "52-week dip",
}

MODEL = {
    "name": "Nifty 100 technical ranking",
    "horizon": "Weeks (swing)",
    "summary": ("Daily candles for every Nifty 100 stock are scanned for four "
                "technical setups (breakout, pullback in an uptrend, trend "
                "continuation, support reversal). Stocks with a setup are "
                "ranked by setup strength; stocks trading 10%+ below their "
                "52-week closing high are listed after them as 52-week dips."),
}


def yahoo_symbol(nse_symbol: str) -> str:
    return f"{nse_symbol}.NS"


def _base_row(con: Constituent) -> dict:
    bucket = sector_of(con.symbol)
    return {"symbol": con.symbol, "name": con.name, "industry": con.industry,
            "sector": bucket, "sector_label": sector_label(bucket),
            "rank": None, "status": "", "status_reason": "",
            "setup": None, "setup_label": None, "setup_score": None,
            "tech_score": None, "tech_grade": None,
            "risk_score": None, "risk_grade": None,
            "components": {}, "sector_leader": False,
            "reasons": [], "notes": [], "risk_notes": []}


def evaluate(con: Constituent, candles: list[dict], bench: list[dict]) -> dict:
    """Score one stock. Pure: candles in, public row out."""
    row = _base_row(con)
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

    quant = quant_profile(candles, bench, risk_free_pct=RISK_FREE_PCT)
    adx_val = (compute_adx(candles, period=14) or {}).get("adx")
    current = float(ind["current"])
    closes = ind["closes"]
    ref_window = closes[-DIP_LOOKBACK_BARS:] if len(closes) >= DIP_LOOKBACK_BARS else closes
    ref_high = max(ref_window) if ref_window else 0.0
    dip_pct = (ref_high - current) / ref_high * 100.0 if ref_high > 0 else 0.0

    row.update(
        change_1d_pct=rnd(change_1d_pct(candles)),
        high_52w=rnd(ind["high_52w"]), low_52w=rnd(ind["low_52w"]),
        ref_high_close=rnd(ref_high), below_52w_high_pct=rnd(dip_pct),
        rsi=rnd(ind["rsi"], 1), rs_vs_benchmark_pct=rnd(ind["rel_strength"]),
        volume_ratio=rnd(ind["vol_ratio"]), adx=rnd(adx_val, 1),
        ema_20=rnd(ind["ema_20"]), sma_50=rnd(ind["sma_50"]),
        sma_200=rnd(ind["sma_200"]), weekly_trend_up=bool(ind["weekly_trend_up"]),
        **quant_fields(quant),
    )

    enriched = dict(ind)
    if adx_val is not None:
        enriched["adx"] = float(adx_val)

    setup_type, setup_score, reasons = classify_setup(ind)
    accepted_technical = False
    if setup_type != "NONE":
        risk = compute_entry_risk(current_price=current, atr_14=float(ind["atr_14"]),
                                  high_52w=float(ind["high_52w"]))
        g = grade(enriched, setup_score=setup_score, setup_type=setup_type,
                  quant=quant, entry_price=risk.entry_price or current,
                  stop_price=risk.stop_price)
        row.update(setup=setup_type, setup_label=SETUP_LABELS[setup_type],
                   setup_score=rnd(setup_score),
                   tech_score=rnd(g.conviction, 1), tech_grade=g.conviction_grade,
                   risk_score=rnd(g.risk, 1), risk_grade=g.risk_grade,
                   components={k: rnd(v, 1) for k, v in g.components.items()},
                   reasons=[inr_text(r) for r in reasons],
                   notes=[n.replace(setup_type, SETUP_LABELS[setup_type])
                          for n in public_notes(g.notes)],
                   risk_notes=public_notes(g.risk_notes))
        if risk.rejected:
            row.update(status="filtered",
                       status_reason=f"{SETUP_LABELS[setup_type]} setup, but "
                                     f"{risk.rejected_reason[0].lower()}{risk.rejected_reason[1:]}")
        else:
            row["status"] = "ranked"
            accepted_technical = True

    if not accepted_technical and dip_pct >= DIP_PCT:
        # Dips are a mean-reversion screen, not a technical setup, so the
        # local tool never graded their technical strength; only risk is shown.
        g = grade(enriched, setup_score=0.0, setup_type="52W_DIP", quant=quant,
                  entry_price=current, stop_price=round(current * 0.90, 2))
        row.update(setup="52W_DIP", setup_label=SETUP_LABELS["52W_DIP"],
                   setup_score=rnd(dip_pct, 1), tech_score=None, tech_grade=None,
                   risk_score=rnd(g.risk, 1), risk_grade=g.risk_grade,
                   components={}, notes=[], risk_notes=public_notes(g.risk_notes),
                   reasons=[f"Trading {dip_pct:.1f}% below its 52-week closing "
                            f"high of ₹{ref_high:,.2f}"],
                   status="ranked", status_reason="")
    elif not row["status"]:
        row.update(status="no_setup", status_reason="No qualifying setup today",
                   reasons=[])
    return row


def _apply_sector_leaders(rows: list[dict]) -> list[dict]:
    evaluated = [r for r in rows if r.get("rs_vs_benchmark_pct") is not None]
    sector_rs = compute_sector_rs([{"sector": r["sector"],
                                    "relative_strength": r["rs_vs_benchmark_pct"]}
                                   for r in evaluated])
    leaders = top_n_sectors_by_rs(sector_rs)
    for r in rows:
        if r["status"] == "ranked" and r["sector"] in leaders:
            r["setup_score"] = rnd((r["setup_score"] or 0.0) + SECTOR_LEADER_BONUS)
            r["sector_leader"] = True
            r["reasons"] = list(r["reasons"]) + [
                f"Sector leader: {r['sector_label']} "
                f"(mean RS {sector_rs[r['sector']]:+.1f}% vs NIFTY 50)"]
    counts: dict[str, int] = {}
    for r in evaluated:
        counts[r["sector"]] = counts.get(r["sector"], 0) + 1
    return [{"sector": s, "label": sector_label(s), "mean_rs_pct": rnd(sector_rs[s]),
             "stocks": counts.get(s, 0), "leader": s in leaders}
            for s in sorted(sector_rs, key=lambda k: sector_rs[k], reverse=True)]


def build(universe: Universe, chart: YahooChart, log: Logger | None = None,
          *, limit: int | None = None) -> dict:
    log = log or Logger("india")
    started = now_ist()
    bench = chart.daily_candles(BENCHMARK_SYMBOL, HISTORY_RANGE, SESSION)
    if len(bench) < 200:
        raise SnapshotError(f"NIFTY 50 history too short ({len(bench)} bars)")
    data_through = bench[-1]["date"]

    constituents = universe.constituents[:limit] if limit else universe.constituents
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
        rows.append(evaluate(con, candles, bench))
        if i % 25 == 0:
            log.info(f"scanned {i}/{len(constituents)}")

    if len(errors) > MAX_FAILURE_SHARE * len(constituents):
        raise SnapshotError(f"{len(errors)} of {len(constituents)} stocks failed to "
                            "download; keeping the previous snapshot")

    sector_board = _apply_sector_leaders(rows)

    ranked = [r for r in rows if r["status"] == "ranked"]
    ranked.sort(key=lambda r: (1 if r["setup"] == "52W_DIP" else 0,
                               -(r["setup_score"] or 0.0), r["symbol"]))
    for rank, r in enumerate(ranked, 1):
        r["rank"] = rank
    others = sorted((r for r in rows if r["status"] != "ranked"),
                    key=lambda r: r["symbol"])

    by_setup: dict[str, int] = {}
    by_grade: dict[str, int] = {}
    for r in ranked:
        by_setup[r["setup_label"]] = by_setup.get(r["setup_label"], 0) + 1
        if r["tech_grade"]:
            by_grade[r["tech_grade"]] = by_grade.get(r["tech_grade"], 0) + 1

    log.info(f"ranked {len(ranked)} of {len(rows)} stocks "
             f"({len(errors)} download errors)")
    return {
        "schema": SCHEMA_VERSION,
        "market": "india",
        "title": "Nifty 100 Ranking",
        "currency": "INR",
        "generated_at": iso(now_ist()),
        "started_at": iso(started),
        "data_through": data_through.isoformat(),
        "universe": {"name": universe.name, "as_of": universe.as_of,
                     "source": "NSE India", "count": len(universe.constituents)},
        "data_source": {"prices": "Yahoo Finance (end-of-day)",
                        "constituents": "NSE India"},
        "benchmark": benchmark_context(BENCHMARK_SYMBOL, BENCHMARK_NAME, bench,
                                       RISK_FREE_PCT),
        "model": MODEL,
        "partial": bool(limit),
        "stats": {"scanned": len(constituents), "evaluated": len(rows),
                  "ranked": len(ranked), "not_ranked": len(others),
                  "errors": len(errors), "by_setup": by_setup, "by_grade": by_grade},
        "sector_strength": sector_board,
        "ranked": ranked,
        "others": others,
        "errors": errors,
    }
