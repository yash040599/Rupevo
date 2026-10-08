"""Mutual fund comparison maths: pure functions over NAV histories.

No network and no I/O. A NAV history is a list of (date, nav) pairs, oldest
first; returns are in percent.

Index funds that track the same index are scored on fixed scales (so a group
where every fund lags its index badly scores low across the board).
Actively managed funds are scored as percentiles within their category.
"""

from __future__ import annotations

import bisect
import datetime
import math
import statistics

INDEX_WEIGHTS = {"tracking": 50, "steadiness": 20, "cost": 20, "size": 10}
ACTIVE_WEIGHTS = {"consistency": 30, "returns": 20, "risk_adjusted": 20, "downside": 15, "cost": 15}

ROLLING_YEARS = 3
ROLLING_LOOKBACK_MONTHS = 60
MIN_ROLLING_WINDOWS = 24
NAV_GAP_DAYS = 10


class NavSeries:
    """A NAV history with lookups by date."""

    def __init__(self, history: list[tuple[datetime.date, float]]) -> None:
        self.dates = [d for d, _ in history]
        self.navs = [v for _, v in history]

    def __len__(self) -> int:
        return len(self.dates)

    @property
    def start(self) -> datetime.date | None:
        return self.dates[0] if self.dates else None

    @property
    def end(self) -> datetime.date | None:
        return self.dates[-1] if self.dates else None

    def on(self, day: datetime.date, max_gap_days: int = NAV_GAP_DAYS) -> float | None:
        """NAV on `day`, or the last one before it within `max_gap_days`."""
        i = bisect.bisect_right(self.dates, day) - 1
        if i < 0 or (day - self.dates[i]).days > max_gap_days:
            return None
        return self.navs[i]

    def between(self, start: datetime.date, end: datetime.date) -> list[float]:
        lo = bisect.bisect_left(self.dates, start)
        hi = bisect.bisect_right(self.dates, end)
        return self.navs[lo:hi]


# ── Dates ───────────────────────────────────────────────────────

def month_end(year: int, month: int) -> datetime.date:
    nxt = datetime.date(year + (month == 12), month % 12 + 1, 1)
    return nxt - datetime.timedelta(days=1)


def shift_month_end(day: datetime.date, months: int) -> datetime.date:
    """Month-end `months` months after (negative: before) the month of `day`."""
    index = day.year * 12 + (day.month - 1) + months
    return month_end(index // 12, index % 12 + 1)


def years_before(day: datetime.date, years: int) -> datetime.date:
    try:
        return day.replace(year=day.year - years)
    except ValueError:  # 29 February
        return day.replace(year=day.year - years, day=28)


def last_month_end(as_of: datetime.date) -> datetime.date:
    """The latest month-end on or before `as_of`."""
    end = month_end(as_of.year, as_of.month)
    return end if as_of >= end else shift_month_end(as_of, -1)


def rolling_ends(as_of: datetime.date, months: int = ROLLING_LOOKBACK_MONTHS) -> list[datetime.date]:
    """The last `months` month-ends up to `as_of`, oldest first."""
    last = last_month_end(as_of)
    return [shift_month_end(last, -k) for k in range(months - 1, -1, -1)]


# ── Returns and risk ────────────────────────────────────────────

def cagr(start: float | None, end: float | None, years: float) -> float | None:
    if not start or not end or start <= 0 or end <= 0 or years <= 0:
        return None
    return ((end / start) ** (1.0 / years) - 1.0) * 100.0


def trailing_cagr(series: NavSeries, as_of: datetime.date, years: int) -> float | None:
    return cagr(series.on(years_before(as_of, years)), series.on(as_of), years)


def rolling_cagrs(series: NavSeries, ends: list[datetime.date],
                  years: int = ROLLING_YEARS) -> dict[datetime.date, float]:
    """`years`-year CAGR ending at each month-end in `ends` where the fund has both NAVs."""
    out: dict[datetime.date, float] = {}
    for end in ends:
        value = cagr(series.on(shift_month_end(end, -12 * years)), series.on(end), years)
        if value is not None:
            out[end] = value
    return out


def window_medians(windows: dict[str, dict[datetime.date, float]],
                   min_funds: int = 3) -> dict[datetime.date, float]:
    """Category median of the rolling returns at each window end."""
    by_end: dict[datetime.date, list[float]] = {}
    for fund in windows.values():
        for end, value in fund.items():
            by_end.setdefault(end, []).append(value)
    return {end: statistics.median(values) for end, values in by_end.items() if len(values) >= min_funds}


def consistency(fund: dict[datetime.date, float],
                medians: dict[datetime.date, float]) -> tuple[int, int]:
    """(windows beating the category median, windows compared)."""
    compared = [end for end in fund if end in medians]
    return sum(1 for end in compared if fund[end] > medians[end]), len(compared)


def annual_volatility(series: NavSeries, ends: list[datetime.date], min_months: int = 24) -> float | None:
    """Standard deviation of monthly returns between consecutive month-ends, annualised."""
    navs = [series.on(end) for end in ends]
    returns = [b / a - 1.0 for a, b in zip(navs, navs[1:], strict=False) if a and b]
    if len(returns) < min_months:
        return None
    return statistics.stdev(returns) * math.sqrt(12) * 100.0


def max_drawdown(series: NavSeries, start: datetime.date, end: datetime.date,
                 min_points: int = 120) -> float | None:
    """Largest fall from a previous peak between two dates, in percent (negative)."""
    navs = series.between(start, end)
    if len(navs) < min_points:
        return None
    peak = navs[0]
    worst = 0.0
    for nav in navs:
        peak = max(peak, nav)
        worst = min(worst, nav / peak - 1.0)
    return worst * 100.0


# ── Scoring ─────────────────────────────────────────────────────

def percentile_scores(values: dict[str, float | None], higher_is_better: bool = True) -> dict[str, float]:
    """0-100: the share of the other funds this one beats (ties count half)."""
    items = [(k, v) for k, v in values.items() if v is not None and math.isfinite(v)]
    if not items:
        return {}
    if len(items) == 1:
        return {items[0][0]: 50.0}
    out = {}
    for key, value in items:
        better = sum(1 for _, other in items if (value > other if higher_is_better else value < other))
        ties = sum(1 for _, other in items if other == value) - 1
        out[key] = (better + 0.5 * ties) / (len(items) - 1) * 100.0
    return out


def scale(value: float | None, worst: float, best: float) -> float | None:
    """Linear 0-100 score: `worst` maps to 0, `best` to 100, clamped."""
    if value is None or not math.isfinite(value):
        return None
    return max(0.0, min(100.0, (value - worst) / (best - worst) * 100.0))


def tracking_score(tracking_difference: float | None) -> float | None:
    """Lagging the index by 1% a year or more scores 0; matching it scores 100."""
    return scale(tracking_difference, -1.0, 0.0)


def steadiness_score(tracking_error: float | None) -> float | None:
    """A tracking error of 0.5% or more scores 0; zero scores 100."""
    return scale(tracking_error, 0.5, 0.0)


def cost_score(ter: float | None) -> float | None:
    """An expense ratio of 1% or more scores 0; zero scores 100."""
    return scale(ter, 1.0, 0.0)


def size_score(aum_crore: float | None) -> float | None:
    """₹10 crore or less scores 0, ₹10,000 crore or more scores 100 (log scale)."""
    if aum_crore is None or aum_crore <= 0:
        return None
    return scale(math.log10(aum_crore), 1.0, 4.0)


def weighted_score(components: dict[str, float | None], weights: dict[str, float]) -> tuple[float | None, float]:
    """Weighted average of the components that have a value, and the share of the weight
    they carry (missing components are dropped and the rest re-weighted)."""
    used = {k: w for k, w in weights.items() if components.get(k) is not None}
    total = sum(used.values())
    if not total:
        return None, 0.0
    return sum(components[k] * w for k, w in used.items()) / total, total / sum(weights.values())


def median(values) -> float | None:
    clean = [v for v in values if v is not None and math.isfinite(v)]
    return statistics.median(clean) if clean else None
