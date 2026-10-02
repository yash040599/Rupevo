"""Tests for the market row builders and the change diff."""

import datetime
import unittest

from pipeline import india, us
from pipeline.snapshot import compute_changes, public_notes, rnd
from pipeline.universes import Constituent
from tests.fixtures import make_candles, path, uptrend_with_pullback

# Trade-construction fields must never appear in a published row.
FORBIDDEN_KEYS = {"entry_price", "stop_price", "target_price", "suggested_qty",
                  "rr_ratio", "risk_rupees", "broker_instruction", "action"}


def all_keys(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k
            yield from all_keys(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from all_keys(v)


class IndiaRowTest(unittest.TestCase):
    def setUp(self):
        self.bench = make_candles(path(100.0, 320, 0.0005))
        self.con = Constituent("TESTCO", "Test Company Ltd.", "Capital Goods")

    def test_short_history_is_not_ranked(self):
        row = india.evaluate(self.con, make_candles(path(100.0, 30, 0.001)), self.bench)
        self.assertEqual(row["status"], "insufficient_data")
        self.assertIsNone(row["rank"])

    def test_deep_drawdown_is_a_52_week_dip_without_technical_grade(self):
        closes = path(100.0, 200, 0.002) + path(150.0, 120, -0.003)
        row = india.evaluate(self.con, make_candles(closes), self.bench)
        self.assertEqual(row["status"], "ranked")
        self.assertEqual(row["setup"], "52W_DIP")
        self.assertIsNone(row["tech_score"])
        self.assertIsNotNone(row["risk_grade"])
        self.assertGreaterEqual(row["below_52w_high_pct"], india.DIP_PCT)
        self.assertIn("below its 52-week closing high", row["reasons"][0])

    def test_uptrend_gets_a_graded_setup(self):
        row = india.evaluate(self.con, make_candles(uptrend_with_pullback()), self.bench)
        self.assertIn(row["status"], {"ranked", "filtered"})
        self.assertIn(row["setup"], india.SETUP_LABELS)
        self.assertIsNotNone(row["tech_grade"])

    def test_rows_carry_no_trade_levels(self):
        for closes in (uptrend_with_pullback(), path(100.0, 320, -0.002),
                       path(100.0, 320, 0.0)):
            row = india.evaluate(self.con, make_candles(closes), self.bench)
            self.assertFalse(FORBIDDEN_KEYS & set(all_keys(row)))


class UsRowTest(unittest.TestCase):
    def test_band_labels_are_neutral_and_rows_have_no_actions(self):
        bench = make_candles(path(100.0, 600, 0.0005))
        con = Constituent("TEST", "Test Inc.", "")
        fundamentals = {"sector": "Technology", "trailing_pe": 25.0, "roe_pct": 30.0,
                        "gross_margin_pct": 60.0, "revenue_growth_pct": 12.0}
        row = us.evaluate(con, make_candles(path(100.0, 600, 0.001)), bench, fundamentals)
        self.assertEqual(row["status"], "ranked")
        self.assertIn(row["band_label"], set(us.BAND_LABELS.values()))
        self.assertNotIn("ACCUMULATE", row["summary"].upper())
        self.assertFalse(FORBIDDEN_KEYS & set(all_keys(row)))

    def test_new_listing_is_not_ranked(self):
        row = us.evaluate(Constituent("NEW", "New Co", ""),
                          make_candles(path(10.0, 40, 0.0)),
                          make_candles(path(100.0, 600, 0.0005)), {})
        self.assertEqual(row["status"], "insufficient_data")


def snap(day: str, ranks: dict[str, int], generated: str = "t") -> dict:
    return {"data_through": day, "generated_at": generated,
            "ranked": [{"symbol": s, "name": s, "rank": r, "setup_label": "Breakout"}
                       for s, r in ranks.items()],
            "others": []}


class ChangesTest(unittest.TestCase):
    def test_first_snapshot(self):
        changes, base = compute_changes(snap("2026-10-01", {"A": 1}), None)
        self.assertIsNone(base)
        self.assertTrue(changes["summary"].startswith("First snapshot"))

    def test_new_dropped_and_movers(self):
        prev = snap("2026-09-30", {"A": 1, "B": 2, "C": 3, "D": 4, "E": 5})
        new = snap("2026-10-01", {"E": 1, "A": 2, "B": 3, "C": 4, "F": 5})
        changes, base = compute_changes(new, prev)
        self.assertEqual([d["symbol"] for d in changes["new_entries"]], ["F"])
        self.assertEqual([d["symbol"] for d in changes["dropped"]], ["D"])
        self.assertEqual([(d["symbol"], d["delta"]) for d in changes["rank_movers"]],
                         [("E", 4)])
        self.assertEqual(base["data_through"], "2026-09-30")

    def test_same_day_rerun_keeps_the_previous_day_as_base(self):
        day1 = snap("2026-09-30", {"A": 1, "B": 2})
        day2 = snap("2026-10-01", {"B": 1, "C": 2}, generated="first")
        changes, base = compute_changes(day2, day1)
        day2["changes"], day2["changes_base"] = changes, base
        rerun = snap("2026-10-01", {"B": 1, "C": 2}, generated="second")
        changes2, base2 = compute_changes(rerun, day2)
        self.assertEqual(base2["data_through"], "2026-09-30")
        self.assertEqual([d["symbol"] for d in changes2["new_entries"]], ["C"])


class HelperTest(unittest.TestCase):
    def test_public_notes_drop_trade_language(self):
        notes = ["ADX 28 — trending", "Stop is 12.1% away", "Volume 1.6x"]
        self.assertEqual(public_notes(notes), ["ADX 28 — trending", "Volume 1.6x"])

    def test_rnd_rejects_non_finite(self):
        self.assertIsNone(rnd(float("nan")))
        self.assertIsNone(rnd(float("inf")))
        self.assertIsNone(rnd(None))
        self.assertIsNone(rnd(True))
        self.assertEqual(rnd(1.23456, 2), 1.23)
        self.assertEqual(rnd(datetime.date(2026, 1, 1).year, 0), 2026.0)


if __name__ == "__main__":
    unittest.main()
