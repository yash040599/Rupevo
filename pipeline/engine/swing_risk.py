"""Swing risk geometry — stop, target and reward/risk for a setup.

Migrated from ai-portfolio-manager `modes/swing/risk.py`
(`compute_entry_risk`). The public site never shows these levels; they
are computed only because the model rejects a setup whose reward/risk,
capped near the 52-week high, falls below the minimum. Portfolio limits,
broker instructions and the earnings blackout are personal-book concerns
and were deliberately not migrated.
"""

from __future__ import annotations

from dataclasses import dataclass

DEFAULT_MIN_RR = 2.0
DEFAULT_ATR_STOP_MULT = 2.0


@dataclass
class RiskResult:
    entry_price: float = 0.0
    stop_price: float = 0.0
    target_price: float = 0.0
    risk_per_share: float = 0.0
    reward_per_share: float = 0.0
    rr_ratio: float = 0.0
    rejected: bool = False
    rejected_reason: str = ""


def compute_entry_risk(
    *,
    current_price: float,
    atr_14: float,
    high_52w: float,
    min_rr: float = DEFAULT_MIN_RR,
    atr_mult: float = DEFAULT_ATR_STOP_MULT,
) -> RiskResult:
    """Stop = tighter of (entry - 2xATR, 5% below entry), bounded to the
    2%-15% band; target = entry + min_rr x risk, capped at 110% of the
    52-week high when it would exceed 115% of it."""
    result = RiskResult(entry_price=current_price)

    if current_price <= 0 or atr_14 <= 0:
        result.rejected = True
        result.rejected_reason = "Invalid price or ATR"
        return result

    atr_stop = current_price - atr_mult * atr_14
    structural_stop = current_price * 0.95
    stop = max(atr_stop, structural_stop)
    if stop > current_price * 0.98:
        stop = current_price - atr_14
    if stop < current_price * 0.85:
        stop = current_price * 0.85

    result.stop_price = round(stop, 2)
    result.risk_per_share = round(current_price - stop, 2)
    if result.risk_per_share <= 0:
        result.rejected = True
        result.rejected_reason = "Zero or negative risk per share"
        return result

    target = current_price + min_rr * result.risk_per_share
    if high_52w > 0 and target > high_52w * 1.15:
        target = high_52w * 1.10

    result.target_price = round(target, 2)
    result.reward_per_share = round(target - current_price, 2)
    result.rr_ratio = round(result.reward_per_share / result.risk_per_share, 2)

    if result.rr_ratio < min_rr:
        result.rejected = True
        result.rejected_reason = (
            f"Limited headroom below the 52-week-high cap "
            f"(reward/risk {result.rr_ratio:.1f} < {min_rr:.1f})"
        )
    return result
