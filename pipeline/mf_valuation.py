"""Index valuations for the mutual fund page's lump-sum check.

Each index's latest P/E is placed against its own month-end P/E since April
2021: NSE computes index P/E from consolidated profits since 31 March 2021
(the Nifty 50's P/E fell from 40.4 to 33.2 that day while the index barely
moved), so earlier month-ends are not comparable.

Month-end values already in the previous snapshot are reused; only missing
months and the latest day are downloaded. When NSE cannot be reached the
previous values stay, marked with their date.
"""

from __future__ import annotations

import datetime

from pipeline.engine.mf_scoring import median, month_end, shift_month_end
from pipeline.log import Logger
from pipeline.providers.amfi import MfDataError, index_key
from pipeline.snapshot import rnd

START_MONTH = datetime.date(2021, 4, 1)
MIN_POINTS = 24
LOW_BELOW = 30.0
HIGH_ABOVE = 70.0

# (key, NSE index name, label shown on the page)
INDICES = (
    ("nifty50", "Nifty 50", "Nifty 50"),
    ("next50", "Nifty Next 50", "Nifty Next 50"),
    ("nifty100", "Nifty 100", "Nifty 100"),
    ("nifty100ew", "Nifty100 Equal Weight", "Nifty 100 Equal Weight"),
    ("nifty50ew", "NIFTY50 Equal Weight", "Nifty 50 Equal Weight"),
    ("largemid250", "NIFTY LargeMidcap 250", "Nifty LargeMidcap 250"),
    ("midcap150", "Nifty Midcap 150", "Nifty Midcap 150"),
    ("smallcap250", "Nifty Smallcap 250", "Nifty Smallcap 250"),
    ("nifty500", "Nifty 500", "Nifty 500"),
    ("totalmarket", "Nifty Total Market", "Nifty Total Market"),
)
# Factor indices (momentum, low volatility, alpha) are left out: they swap most of their
# stocks at each rebalance, so their P/E jumps and its history says little.

ZONES = {"low": "Cheaper than usual", "mid": "Around usual", "high": "More expensive than usual"}


def months_between(start: datetime.date, end: datetime.date) -> list[str]:
    """'YYYY-MM' for every month from `start` to `end` inclusive."""
    out = []
    day = start.replace(day=1)
    while day <= end:
        out.append(day.strftime("%Y-%m"))
        day = (day + datetime.timedelta(days=32)).replace(day=1)
    return out


def percentile_of(value: float, history: list[float]) -> float | None:
    """Share of `history` below `value` (ties count half), 0-100."""
    if not history:
        return None
    below = sum(1 for v in history if v < value)
    ties = sum(1 for v in history if v == value)
    return (below + 0.5 * ties) / len(history) * 100.0


def zone_of(percentile: float | None, points: int) -> str | None:
    if percentile is None or points < MIN_POINTS:
        return None
    if percentile < LOW_BELOW:
        return "low"
    if percentile > HIGH_ABOVE:
        return "high"
    return "mid"


def _previous_state(previous: dict | None) -> tuple[set[str], dict[str, dict[str, list]], dict[str, dict]]:
    """(months already fetched, {key: {month: [date, pe]}}, {key: latest entry}) from a snapshot."""
    block = (previous or {}).get("valuation") or {}
    fetched = set(block.get("months_fetched") or [])
    history: dict[str, dict[str, list]] = {}
    latest: dict[str, dict] = {}
    for entry in block.get("indices") or []:
        points = {}
        for day, pe in entry.get("history") or []:
            if isinstance(day, str) and len(day) >= 7 and isinstance(pe, (int, float)):
                points[day[:7]] = [day, pe]
        history[entry.get("key")] = points
        latest[entry.get("key")] = entry
    return fetched, history, latest


def build(nse, previous: dict | None, today: datetime.date, log: Logger | None = None) -> tuple[dict, list[dict]]:
    """The snapshot's `valuation` block and any errors."""
    log = log or Logger("valuation")
    errors: list[dict] = []
    fetched, history, previous_latest = _previous_state(previous)
    last_complete = shift_month_end(today, -1)
    wanted = months_between(START_MONTH, last_complete)
    keys = {key: index_key(nse_name) for key, nse_name, _ in INDICES}

    reachable = True
    for month in wanted:
        if month in fetched:
            continue
        year, mon = int(month[:4]), int(month[5:])
        try:
            rows = nse.last_on_or_before(month_end(year, mon))
        except MfDataError as exc:
            errors.append({"source": "NSE indices", "error": str(exc)[:200]})
            log.warning(f"NSE index file for {month}: {exc}")
            reachable = False
            break
        if not rows:
            continue
        for key, nse_key in keys.items():
            row = rows.get(nse_key)
            if row:
                history.setdefault(key, {})[month] = [row["date"].isoformat(), round(row["pe"], 2)]
        fetched.add(month)

    latest_rows = None
    if reachable:
        try:
            latest_rows = nse.last_on_or_before(today, days_back=10)
        except MfDataError as exc:
            errors.append({"source": "NSE indices", "error": str(exc)[:200]})
            log.warning(f"NSE latest index file: {exc}")

    indices = []
    for key, nse_name, label in INDICES:
        row = (latest_rows or {}).get(keys[key])
        points = sorted(history.get(key, {}).values())
        if row:
            latest = {"pe": row["pe"], "pb": row["pb"], "dy": row["dy"], "date": row["date"].isoformat()}
        elif previous_latest.get(key, {}).get("pe"):
            prev = previous_latest[key]
            latest = {"pe": prev["pe"], "pb": prev.get("pb"), "dy": prev.get("dy"), "date": prev.get("date")}
        else:
            continue
        values = [pe for _, pe in points]
        pct = percentile_of(latest["pe"], values)
        zone = zone_of(pct, len(values))
        indices.append({
            "key": key, "name": label, "nse_name": nse_name,
            "pe": rnd(latest["pe"]), "pb": rnd(latest["pb"]), "dy": rnd(latest["dy"]),
            "date": latest["date"], "percentile": rnd(pct, 0), "zone": zone, "zone_label": ZONES.get(zone),
            "points": len(values), "since": points[0][0] if points else None,
            "min": rnd(min(values)) if values else None,
            "median": rnd(median(values)) if values else None,
            "max": rnd(max(values)) if values else None,
            "history": [[d, pe] for d, pe in points],
        })

    block = {"source": "NSE India (daily index file: P/E from consolidated profits)",
             "start": START_MONTH.isoformat(),
             "months_fetched": sorted(fetched),
             "as_of": max((i["date"] for i in indices if i.get("date")), default=None),
             "indices": indices}
    return block, errors
