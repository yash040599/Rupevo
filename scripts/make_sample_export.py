"""Write the synthetic Fidelity "View open lots" export used by the tests.

    python scripts/make_sample_export.py

Quantities are made up (5 shares per RSU vest, 0.5 per ESPP purchase); the
per-share values are Microsoft's public closing prices from
site/data/tax/msft.json (ESPP at 90% of the close, as in Microsoft's plan).
Never build this file from a real person's export.
"""

from __future__ import annotations

import datetime
import json
import os

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRICES = os.path.join(REPO_ROOT, "site", "data", "tax", "msft.json")
OUT = os.path.join(REPO_ROOT, "tests", "fixtures", "fidelity-msft-open-lots-sample.csv")

RSU_SHARES = 5.0
ESPP_SHARES = 0.5
# Vest dates: quarterly on the 15th, moved to the next trading day.
RSU_TARGETS = ["2024-11-15", "2025-02-15", "2025-05-15", "2025-08-15", "2025-11-15",
               "2026-02-15", "2026-05-15", "2026-08-15"]
# ESPP purchases: last trading day of each quarter; grant date = offering start.
ESPP_QUARTERS = [("2024-10-01", "2024-12-31"), ("2025-01-02", "2025-03-31"),
                 ("2025-04-01", "2025-06-30"), ("2025-07-01", "2025-09-30"),
                 ("2025-10-01", "2025-12-31"), ("2026-01-02", "2026-03-31"),
                 ("2026-04-01", "2026-06-30"), ("2026-07-01", "2026-09-30")]
HEADER = ("Date acquired,Quantity,Cost basis,Cost basis/share,Value,Gain/loss,Sale availability date,"
          "Transfer availability date,Grant date,Share source,Holding period")


def fidelity_date(iso: str) -> str:
    return datetime.date.fromisoformat(iso).strftime("%b-%d-%Y")


def main() -> int:
    with open(PRICES, encoding="utf-8") as fh:
        closes = dict(json.load(fh)["closes"])
    days = sorted(closes)
    last = days[-1]

    def on_or_after(target: str) -> str:
        return next(d for d in days if d >= target)

    def on_or_before(target: str) -> str:
        return max(d for d in days if d <= target)

    lots = []
    for target in RSU_TARGETS:
        day = on_or_after(target)
        lots.append((day, RSU_SHARES, closes[day], "-", "DO"))
    for start, end in ESPP_QUARTERS:
        day = on_or_before(end)
        lots.append((day, ESPP_SHARES, round(closes[day] * 0.9, 2), fidelity_date(start), "SP"))

    one_year_ago = (datetime.date.fromisoformat(last) - datetime.timedelta(days=365)).isoformat()
    lines = [HEADER]
    for day, qty, per_share, grant, source in sorted(lots, reverse=True):
        cost = round(qty * per_share, 2)
        value = round(qty * closes[last], 2)
        holding = "Long" if day <= one_year_ago else "Short"
        lines.append(f"{fidelity_date(day)},{qty:.4f},{cost:.2f},{per_share:.2f},{value:.2f},"
                     f"{value - cost:.2f},-,-,{grant},{source},{holding}")
    lines += [",", "The values are displayed in USD"]
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8-sig", newline="\n") as fh:
        fh.write("\n".join(lines) + "\n")
    print(f"wrote {OUT} ({len(lots)} lots)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
