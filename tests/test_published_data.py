"""Safety checks on the snapshots actually committed under site/data/.

The site is public, so these run on every push: a published snapshot must
be well-formed and must never contain trade-call fields or buy/sell
language (SEBI treats entry/stop/target calls as research services). The
mutual fund comparison (mf.json) is held to the same wording rules.
"""

import datetime
import json
import os
import re
import unittest

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "site", "data")
FORBIDDEN_KEYS = {"entry_price", "stop_price", "target_price", "suggested_qty",
                  "rr_ratio", "risk_rupees", "broker_instruction",
                  "broker_instruction_json", "action"}
TEXT_KEYS = {"reasons", "notes", "risk_notes", "status_reason", "summary",
             "risk_drivers", "drivers"}
FORBIDDEN_WORDS = re.compile(
    r"\b(buy|sell|accumulate|avoid|target|stop[- ]?loss|entry|trim)\b", re.IGNORECASE)


def _walk(obj, parent_key=""):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k, v, parent_key
            yield from _walk(v, k)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk(v, parent_key)


def _texts(obj):
    for key, value, parent in _walk(obj):
        if key in TEXT_KEYS or parent in TEXT_KEYS:
            if isinstance(value, str):
                yield value
            elif isinstance(value, list):
                yield from (v for v in value if isinstance(v, str))


class PublishedSnapshotTest(unittest.TestCase):
    def _snapshots(self):
        found = []
        for market in ("india", "us", "us-nyse"):
            path = os.path.join(DATA_DIR, f"{market}.json")
            if os.path.exists(path):
                with open(path, encoding="utf-8") as fh:
                    found.append((market, json.load(fh)))
        if not found:
            self.skipTest("no published snapshots yet")
        return found

    def test_us_lists_name_their_exchange(self):
        expected = {"us": "NASDAQ", "us-nyse": "NYSE"}
        for market, snap in self._snapshots():
            if market not in expected:
                continue
            with self.subTest(market=market):
                self.assertEqual(snap["exchange"], expected[market])
                rows = snap["ranked"] + snap["others"]
                self.assertTrue(all(r["exchange"] == expected[market] for r in rows))

    def test_schema(self):
        for market, snap in self._snapshots():
            with self.subTest(market=market):
                self.assertEqual(snap["market"], market)
                self.assertFalse(snap.get("partial"), "partial snapshot published")
                datetime.datetime.fromisoformat(snap["generated_at"])
                datetime.date.fromisoformat(snap["data_through"])
                ranks = [r["rank"] for r in snap["ranked"]]
                self.assertEqual(ranks, list(range(1, len(ranks) + 1)))
                self.assertTrue(all(r["rank"] is None for r in snap["others"]))
                self.assertIn("usd_inr", snap["fx"])
                self.assertIn("summary", snap["changes"])

    def test_no_trade_fields(self):
        for market, snap in self._snapshots():
            keys = {k for k, _, _ in _walk(snap)}
            self.assertFalse(FORBIDDEN_KEYS & keys, f"{market}: trade fields published")

    def test_no_buy_sell_language(self):
        for market, snap in self._snapshots():
            hits = [t for t in _texts(snap) if FORBIDDEN_WORDS.search(t)]
            self.assertEqual(hits, [], f"{market}: recommendation wording published")


class PublishedFundsTest(unittest.TestCase):
    """site/data/mf.json, the mutual fund comparison."""

    def _snapshot(self) -> dict:
        path = os.path.join(DATA_DIR, "mf.json")
        if not os.path.exists(path):
            self.skipTest("no fund comparison published yet")
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)

    def test_schema(self):
        snap = self._snapshot()
        self.assertEqual(snap["market"], "mf")
        self.assertFalse(snap.get("partial"), "partial snapshot published")
        datetime.datetime.fromisoformat(snap["generated_at"])
        datetime.date.fromisoformat(snap["data_through"])
        self.assertTrue(snap["groups"])
        for group in snap["groups"]:
            with self.subTest(group=group["key"]):
                self.assertIn(group["kind"], ("index", "active"))
                ranks = [f["rank"] for f in group["funds"] if f["rank"] is not None]
                self.assertEqual(ranks, list(range(1, len(ranks) + 1)), "ranked funds come first, in order")
                self.assertEqual(group["stats"]["ranked"], len(ranks))
                for fund in group["funds"]:
                    self.assertIsInstance(fund["code"], int)
                    self.assertEqual(fund["rank"] is None, fund["status"] != "ranked")
                    if fund["rank"]:
                        self.assertTrue(fund["reasons"], f"{fund['name']}: ranked without reasons")

    def test_no_trade_fields_or_buy_sell_language(self):
        snap = self._snapshot()
        self.assertFalse(FORBIDDEN_KEYS & {k for k, _, _ in _walk(snap)}, "trade fields published")
        hits = [t for t in _texts(snap) if FORBIDDEN_WORDS.search(t)]
        self.assertEqual(hits, [], "recommendation wording published")


if __name__ == "__main__":
    unittest.main()
