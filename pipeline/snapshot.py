"""Helpers shared by the Indian and US snapshot builders."""

from __future__ import annotations

import math
import re
from typing import Any

from pipeline.engine.quant_metrics import profile as quant_profile

SCHEMA_VERSION = 1
RANK_MOVE_THRESHOLD = 3

# Trade-construction language never reaches the public site (SEBI treats
# entry/stop/target calls as research services). These patterns drop any
# engine note that would read like one.
_TRADE_NOTE = re.compile(r"\b(stop|target|entry|buy|sell)\b", re.IGNORECASE)


class SnapshotError(RuntimeError):
    """A market snapshot is not safe to publish (e.g. too many fetch failures)."""


def rnd(value: Any, digits: int = 2) -> float | None:
    """Round finite numbers; anything else (None, NaN, junk) becomes None."""
    if value is None or isinstance(value, bool):
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f):
        return None
    return round(f, digits)


def public_notes(notes: list[str] | None) -> list[str]:
    return [n for n in (notes or []) if n and not _TRADE_NOTE.search(n)]


def inr_text(text: str) -> str:
    return text.replace("Rs.", "₹")


def change_1d_pct(candles: list[dict]) -> float | None:
    if len(candles) < 2 or not candles[-2]["close"]:
        return None
    return (candles[-1]["close"] / candles[-2]["close"] - 1.0) * 100.0


def benchmark_context(symbol: str, name: str, candles: list[dict],
                      risk_free_pct: float) -> dict:
    q = quant_profile(candles, None, risk_free_pct=risk_free_pct)
    return {
        "symbol": symbol,
        "name": name,
        "close": rnd(candles[-1]["close"]),
        "date": candles[-1]["date"].isoformat(),
        "change_1d_pct": rnd(change_1d_pct(candles)),
        "return_1m_pct": rnd(q.get("return_1m_pct")),
        "return_3m_pct": rnd(q.get("return_3m_pct")),
        "return_12m_pct": rnd(q.get("return_12m_pct")),
        "above_sma_200": q.get("above_sma_200"),
        "trend_state": q.get("trend_state"),
    }


def quant_fields(q: dict) -> dict:
    """The quant-profile subset the site renders, rounded."""
    return {
        "return_1m_pct": rnd(q.get("return_1m_pct")),
        "return_3m_pct": rnd(q.get("return_3m_pct")),
        "return_6m_pct": rnd(q.get("return_6m_pct")),
        "return_12m_pct": rnd(q.get("return_12m_pct")),
        "momentum_12_1_pct": rnd(q.get("momentum_12_1_pct")),
        "rs_3m_pct": rnd(q.get("rs_3m_pct")),
        "rs_6m_pct": rnd(q.get("rs_6m_pct")),
        "rs_12m_pct": rnd(q.get("rs_12m_pct")),
        "volatility_90d_pct": rnd(q.get("volatility_90d_pct")),
        "max_drawdown_1y_pct": rnd(q.get("max_drawdown_1y_pct")),
        "sharpe_1y": rnd(q.get("sharpe_1y")),
        "beta": rnd(q.get("beta")),
        "range_position_pct": rnd(q.get("range_position_pct"), 1),
        "atr_pct": rnd(q.get("atr_pct")),
        "avg_turnover": rnd(q.get("avg_turnover"), 0),
        "trend_state": q.get("trend_state"),
    }


# ── What changed since the previous trading day ─────────────────

def _ranks(snapshot: dict) -> dict[str, int]:
    return {r["symbol"]: int(r["rank"]) for r in snapshot.get("ranked") or []
            if r.get("rank")}


def _bands(snapshot: dict) -> dict[str, str]:
    return {r["symbol"]: r.get("band_label") or "" for r in snapshot.get("ranked") or []
            if r.get("band_label")}


def compute_changes(new: dict, previous: dict | None) -> tuple[dict, dict | None]:
    """Diff `new` against the last snapshot from an earlier trading day.

    Returns (changes, base). Re-running a refresh on the same trading day
    compares against the same base again (carried in `changes_base`), so a
    second same-day run cannot wipe out the real day-over-day changes.
    """
    if not previous or not previous.get("ranked"):
        return {"summary": "First snapshot — changes appear after the next refresh.",
                "new_entries": [], "dropped": [], "rank_movers": [],
                "band_changes": []}, None

    if previous.get("data_through") == new.get("data_through") and previous.get("changes_base"):
        base = previous["changes_base"]
    else:
        base = {"generated_at": previous.get("generated_at"),
                "data_through": previous.get("data_through"),
                "ranks": _ranks(previous),
                "bands": _bands(previous)}

    base_ranks: dict[str, int] = {k: int(v) for k, v in (base.get("ranks") or {}).items()}
    base_bands: dict[str, str] = dict(base.get("bands") or {})
    rows = {r["symbol"]: r for r in (new.get("ranked") or []) + (new.get("others") or [])}
    new_ranks = _ranks(new)

    new_entries = sorted(
        ({"symbol": s, "name": rows[s].get("name", ""), "rank": rk,
          "label": rows[s].get("setup_label") or rows[s].get("band_label") or ""}
         for s, rk in new_ranks.items() if s not in base_ranks),
        key=lambda d: d["rank"])
    dropped = sorted(
        ({"symbol": s, "name": (rows.get(s) or {}).get("name", ""),
          "previous_rank": rk,
          "now": (rows.get(s) or {}).get("status_reason") or "No longer in the ranking"}
         for s, rk in base_ranks.items() if s not in new_ranks),
        key=lambda d: d["previous_rank"])
    movers = sorted(
        ({"symbol": s, "name": rows[s].get("name", ""), "previous_rank": base_ranks[s],
          "rank": rk, "delta": base_ranks[s] - rk}
         for s, rk in new_ranks.items()
         if s in base_ranks and abs(base_ranks[s] - rk) >= RANK_MOVE_THRESHOLD),
        key=lambda d: (-abs(d["delta"]), d["rank"]))
    band_changes = sorted(
        ({"symbol": s, "name": rows[s].get("name", ""), "previous": base_bands[s],
          "now": rows[s].get("band_label"), "rank": new_ranks.get(s)}
         for s in new_ranks
         if s in base_bands and rows[s].get("band_label")
         and rows[s].get("band_label") != base_bands[s]),
        key=lambda d: d["rank"] or 9999)

    bits = []
    if new_entries:
        bits.append(f"{len(new_entries)} new")
    if dropped:
        bits.append(f"{len(dropped)} dropped")
    if movers:
        bits.append(f"{len(movers)} rank mover" + ("s" if len(movers) != 1 else ""))
    if band_changes:
        bits.append(f"{len(band_changes)} band change" + ("s" if len(band_changes) != 1 else ""))
    changes = {
        "compared_to": {"generated_at": base.get("generated_at"),
                        "data_through": base.get("data_through")},
        "summary": " · ".join(bits) if bits else "No notable changes",
        "new_entries": new_entries,
        "dropped": dropped,
        "rank_movers": movers,
        "band_changes": band_changes,
    }
    return changes, base
