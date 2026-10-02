"""Timezone helpers. Every timestamp the pipeline publishes is IST."""

from __future__ import annotations

import datetime
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
NEW_YORK = ZoneInfo("America/New_York")


def now_ist() -> datetime.datetime:
    return datetime.datetime.now(IST)


def iso(ts: datetime.datetime) -> str:
    return ts.isoformat(timespec="seconds")
