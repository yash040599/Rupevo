"""Tests for Yahoo chart parsing (offline — the HTTP call is stubbed)."""

import datetime
import unittest
from zoneinfo import ZoneInfo

from pipeline.providers.yahoo import Session, YahooChart

IST = ZoneInfo("Asia/Kolkata")


def _ts(day: datetime.date, hour: int, minute: int, tz: ZoneInfo) -> int:
    return int(datetime.datetime.combine(day, datetime.time(hour, minute), tz).timestamp())


class StubChart(YahooChart):
    def __init__(self, payload):
        super().__init__(pause_s=0)
        self.payload = payload

    def _chart(self, symbol, range_):
        return self.payload


def payload(days: list[datetime.date], closes: list) -> dict:
    return {
        "meta": {"gmtoffset": 19800},
        "timestamp": [_ts(d, 9, 15, IST) for d in days],
        "indicators": {"quote": [{
            "open": closes, "high": [c and c * 1.01 for c in closes],
            "low": [c and c * 0.99 for c in closes], "close": closes,
            "volume": [1000] * len(closes)}]},
    }


class ParseTest(unittest.TestCase):
    def test_dates_are_exchange_local_and_bad_rows_dropped(self):
        days = [datetime.date(2026, 9, 28), datetime.date(2026, 9, 29),
                datetime.date(2026, 9, 30)]
        chart = StubChart(payload(days, [100.0, None, 102.0]))
        candles = chart.daily_candles("X.NS", "2y")
        self.assertEqual([c["date"] for c in candles], [days[0], days[2]])
        self.assertEqual(candles[-1]["close"], 102.0)

    def test_unsettled_session_bar_is_dropped(self):
        today = datetime.datetime.now(IST).date()
        yesterday = today - datetime.timedelta(days=1)
        chart = StubChart(payload([yesterday, today], [100.0, 101.0]))
        always_open = Session(IST, datetime.time(23, 59), settle_minutes=0)
        self.assertEqual(chart.daily_candles("X.NS", "2y", always_open)[-1]["date"],
                         yesterday)
        already_closed = Session(IST, datetime.time(0, 0), settle_minutes=0)
        self.assertEqual(chart.daily_candles("X.NS", "2y", already_closed)[-1]["date"],
                         today)


if __name__ == "__main__":
    unittest.main()
