"""Tests for the migrated swing engine (signals, conviction, risk)."""

import unittest
from types import SimpleNamespace

from pipeline.engine.swing_conviction import grade
from pipeline.engine.swing_risk import compute_entry_risk
from pipeline.engine.swing_signals import (
    classify_setup, compute_sector_rs, compute_swing_indicators, top_n_sectors_by_rs,
)
from tests.fixtures import make_candles, path, uptrend_with_pullback

SETUPS = {"BREAKOUT", "PULLBACK_UPTREND", "TREND_CONTINUATION", "SUPPORT_REVERSAL"}


class SignalTest(unittest.TestCase):
    def setUp(self):
        self.bench = make_candles(path(100.0, 320, 0.0005))

    def test_uptrend_produces_a_setup(self):
        ind = compute_swing_indicators(make_candles(uptrend_with_pullback()), self.bench)
        setup, score, reasons = classify_setup(ind)
        self.assertIn(setup, SETUPS)
        self.assertGreaterEqual(score, 2.0)
        self.assertTrue(reasons)

    def test_steady_downtrend_has_no_setup(self):
        ind = compute_swing_indicators(make_candles(path(100.0, 320, -0.003)), self.bench)
        setup, score, _ = classify_setup(ind)
        self.assertEqual(setup, "NONE")
        self.assertEqual(score, 0.0)

    def test_short_history_is_invalid(self):
        ind = compute_swing_indicators(make_candles(path(100.0, 20, 0.001)), self.bench)
        self.assertFalse(ind["valid"])

    def test_relative_strength_sign(self):
        strong = compute_swing_indicators(make_candles(path(100.0, 320, 0.003)), self.bench)
        weak = compute_swing_indicators(make_candles(path(100.0, 320, -0.001)), self.bench)
        self.assertGreater(strong["rel_strength"], 0)
        self.assertLess(weak["rel_strength"], 0)


class ConvictionTest(unittest.TestCase):
    def test_grades_stay_in_range(self):
        bench = make_candles(path(100.0, 320, 0.0005))
        for closes in (uptrend_with_pullback(), path(100.0, 320, -0.002),
                       path(100.0, 320, 0.0)):
            ind = compute_swing_indicators(make_candles(closes), bench)
            g = grade(ind, setup_score=5.0, setup_type="BREAKOUT")
            self.assertGreaterEqual(g.conviction, 0.0)
            self.assertLessEqual(g.conviction, 100.0)
            self.assertGreaterEqual(g.risk, 0.0)
            self.assertLessEqual(g.risk, 100.0)
            self.assertIn(g.conviction_grade, {"A", "B", "C", "D"})
            self.assertIn(g.risk_grade, {"LOW", "MODERATE", "HIGH", "VERY HIGH"})

    def test_stronger_setup_scores_higher(self):
        ind = compute_swing_indicators(make_candles(uptrend_with_pullback()),
                                       make_candles(path(100.0, 320, 0.0005)))
        weak = grade(ind, setup_score=2.0, setup_type="BREAKOUT")
        strong = grade(ind, setup_score=8.0, setup_type="BREAKOUT")
        self.assertGreater(strong.conviction, weak.conviction)


class RiskGeometryTest(unittest.TestCase):
    def test_normal_setup_meets_minimum_reward_risk(self):
        r = compute_entry_risk(current_price=100.0, atr_14=2.0, high_52w=150.0)
        self.assertFalse(r.rejected)
        self.assertAlmostEqual(r.stop_price, 96.0)
        self.assertAlmostEqual(r.rr_ratio, 2.0)

    def test_stop_is_never_wider_than_the_structural_5_percent(self):
        r = compute_entry_risk(current_price=100.0, atr_14=12.0, high_52w=200.0)
        self.assertAlmostEqual(r.stop_price, 95.0)

    def test_target_capped_near_52w_high_is_filtered(self):
        r = compute_entry_risk(current_price=100.0, atr_14=2.5, high_52w=95.0)
        self.assertTrue(r.rejected)
        self.assertIn("headroom", r.rejected_reason)

    def test_invalid_inputs_are_rejected(self):
        self.assertTrue(compute_entry_risk(current_price=100.0, atr_14=0.0,
                                           high_52w=120.0).rejected)


class SectorStrengthTest(unittest.TestCase):
    def test_accepts_dicts_and_objects_and_skips_thin_or_other(self):
        rows = [
            {"sector": "IT", "relative_strength": 4.0},
            SimpleNamespace(sector="IT", relative_strength=6.0),
            {"sector": "AUTO", "relative_strength": -2.0},
            {"sector": "AUTO", "relative_strength": 0.0},
            {"sector": "METALS", "relative_strength": 9.0},
            {"sector": "OTHER", "relative_strength": 50.0},
            {"sector": "OTHER", "relative_strength": 50.0},
        ]
        rs = compute_sector_rs(rows)
        self.assertEqual(rs, {"IT": 5.0, "AUTO": -1.0})
        self.assertEqual(top_n_sectors_by_rs(rs, 1), ["IT"])


if __name__ == "__main__":
    unittest.main()
