"""Daily-candle indicators used by the swing engine.

Migrated from ai-portfolio-manager `shared/technical_indicators.py` (EMA,
RSI, ADX) and `modes/swing/signals.py` (Wilder ATR). Formulas are
unchanged so rankings stay comparable with the local tool.

Candles are dicts with open/high/low/close/volume keys, oldest first.
"""

from __future__ import annotations


def ema(candles: list[dict], period: int, field: str = "close") -> list[float]:
    """EMA seeded with an SMA of the first `period` values (TradingView /
    Kite convention). Returns a list the same length as `candles`."""
    values = [c[field] for c in candles]
    if len(values) < period:
        return values[:]

    result = [0.0] * len(values)
    result[period - 1] = sum(values[:period]) / period

    multiplier = 2 / (period + 1)
    for i in range(period, len(values)):
        result[i] = (values[i] - result[i - 1]) * multiplier + result[i - 1]

    for i in range(period - 1):
        result[i] = sum(values[:i + 1]) / (i + 1)

    return result


def rsi(candles: list[dict], period: int = 14) -> float:
    """Wilder RSI (0-100). Returns -1 when there is not enough data."""
    if len(candles) < period + 1:
        return -1

    closes = [c["close"] for c in candles]
    changes = [closes[i] - closes[i - 1] for i in range(1, len(closes))]

    avg_gain = sum(max(0, c) for c in changes[:period]) / period
    avg_loss = sum(max(0, -c) for c in changes[:period]) / period

    for c in changes[period:]:
        avg_gain = (avg_gain * (period - 1) + max(0, c)) / period
        avg_loss = (avg_loss * (period - 1) + max(0, -c)) / period

    if avg_loss == 0:
        return 100.0

    rs = avg_gain / avg_loss
    return round(100 - (100 / (1 + rs)), 2)


def adx(candles: list[dict], period: int = 14) -> dict:
    """Average Directional Index with Wilder smoothing.

    Returns ``{adx, plus_di, minus_di, trend_strength}``; ADX < 20 is a
    range-bound tape, > 30 a strong trend.
    """
    weak = {"adx": 0, "plus_di": 0, "minus_di": 0, "trend_strength": "WEAK"}
    n = len(candles)
    if n < period + 2:
        return weak

    tr_list: list[float] = []
    plus_dm_list: list[float] = []
    minus_dm_list: list[float] = []
    for i in range(1, n):
        high = candles[i]["high"]
        low = candles[i]["low"]
        prev_close = candles[i - 1]["close"]
        prev_high = candles[i - 1]["high"]
        prev_low = candles[i - 1]["low"]

        tr_list.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
        up_move = high - prev_high
        down_move = prev_low - low
        plus_dm_list.append(up_move if (up_move > down_move and up_move > 0) else 0)
        minus_dm_list.append(down_move if (down_move > up_move and down_move > 0) else 0)

    if len(tr_list) < period:
        return weak

    atr_smooth = sum(tr_list[:period])
    pdm_smooth = sum(plus_dm_list[:period])
    mdm_smooth = sum(minus_dm_list[:period])

    dx_list: list[float] = []
    for i in range(period, len(tr_list)):
        atr_smooth = atr_smooth - atr_smooth / period + tr_list[i]
        pdm_smooth = pdm_smooth - pdm_smooth / period + plus_dm_list[i]
        mdm_smooth = mdm_smooth - mdm_smooth / period + minus_dm_list[i]

        plus_di = (pdm_smooth / atr_smooth * 100) if atr_smooth > 0 else 0
        minus_di = (mdm_smooth / atr_smooth * 100) if atr_smooth > 0 else 0
        di_sum = plus_di + minus_di
        dx_list.append(abs(plus_di - minus_di) / di_sum * 100 if di_sum > 0 else 0)

    if len(dx_list) < period:
        return weak

    adx_val = sum(dx_list[:period]) / period
    for i in range(period, len(dx_list)):
        adx_val = (adx_val * (period - 1) + dx_list[i]) / period

    cur_plus_di = (pdm_smooth / atr_smooth * 100) if atr_smooth > 0 else 0
    cur_minus_di = (mdm_smooth / atr_smooth * 100) if atr_smooth > 0 else 0

    if adx_val >= 30:
        strength = "STRONG"
    elif adx_val >= 20:
        strength = "MODERATE"
    else:
        strength = "WEAK"

    return {
        "adx": round(adx_val, 1),
        "plus_di": round(cur_plus_di, 1),
        "minus_di": round(cur_minus_di, 1),
        "trend_strength": strength,
    }


def wilder_atr(candles: list[dict], period: int = 14) -> float:
    """Wilder-smoothed Average True Range over daily candles."""
    if len(candles) < 2:
        return 0.0
    trs: list[float] = []
    for i in range(1, len(candles)):
        h = candles[i]["high"]
        lo = candles[i]["low"]
        pc = candles[i - 1]["close"]
        trs.append(max(h - lo, abs(h - pc), abs(lo - pc)))
    if not trs:
        return 0.0
    atr_val = sum(trs[:period]) / period
    for tr in trs[period:]:
        atr_val = (atr_val * (period - 1) + tr) / period
    return atr_val
