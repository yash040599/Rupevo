"""Index universes (constituent lists) checked into the repo as JSON.

Refreshed with `python -m pipeline universe`, which re-downloads the
official lists (NSE CSV, Nasdaq API) and rewrites a file only when the
membership actually changed.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

UNIVERSE_DIR = os.path.dirname(os.path.abspath(__file__))
UNIVERSES = ("nifty100", "nasdaq100")


@dataclass
class Constituent:
    symbol: str
    name: str
    industry: str = ""


@dataclass
class Universe:
    key: str
    name: str
    source: str
    as_of: str
    constituents: list[Constituent] = field(default_factory=list)

    @property
    def symbols(self) -> list[str]:
        return [c.symbol for c in self.constituents]

    def by_symbol(self) -> dict[str, Constituent]:
        return {c.symbol: c for c in self.constituents}


def path_for(key: str) -> str:
    if key not in UNIVERSES:
        raise ValueError(f"unknown universe {key!r}; expected one of {UNIVERSES}")
    return os.path.join(UNIVERSE_DIR, f"{key}.json")


def load(key: str) -> Universe:
    with open(path_for(key), encoding="utf-8") as fh:
        blob = json.load(fh)
    return Universe(
        key=key,
        name=blob["name"],
        source=blob["source"],
        as_of=blob["as_of"],
        constituents=[Constituent(symbol=row["symbol"], name=row.get("name", ""),
                                  industry=row.get("industry", ""))
                      for row in blob["constituents"]],
    )
