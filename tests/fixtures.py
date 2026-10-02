"""Deterministic synthetic candles for tests (no network, no randomness)."""

from __future__ import annotations

import datetime


def make_candles(closes: list[float], *, start: datetime.date = datetime.date(2024, 1, 1),
                 spread: float = 0.01, volume: float = 1_000_000.0) -> list[dict]:
    out = []
    day = start
    for i, close in enumerate(closes):
        while day.weekday() >= 5:
            day += datetime.timedelta(days=1)
        prev = closes[i - 1] if i else close
        out.append({"date": day, "open": prev, "high": max(prev, close) * (1 + spread),
                    "low": min(prev, close) * (1 - spread), "close": close,
                    "volume": volume})
        day += datetime.timedelta(days=1)
    return out


def path(start: float, n: int, daily: float) -> list[float]:
    out = [start]
    for _ in range(n - 1):
        out.append(out[-1] * (1 + daily))
    return out


def uptrend_with_pullback(n: int = 320) -> list[float]:
    """Steady rise, then a shallow 3% pullback over the last few bars."""
    closes = path(100.0, n - 6, 0.0025)
    top = closes[-1]
    closes += [top * (1 - 0.005 * k) for k in range(1, 7)]
    return closes
