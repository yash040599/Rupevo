"""Tests for the checked-in index universes and name cleanup."""

import unittest

from pipeline.universes import load
from pipeline.universes.refresh import clean_nasdaq_name
from pipeline.universes.sectors import SECTOR_LABELS, SECTOR_MAP


class UniverseFileTest(unittest.TestCase):
    def test_nifty100_shape(self):
        u = load("nifty100")
        self.assertEqual(len(u.symbols), 100)
        self.assertEqual(len(set(u.symbols)), 100)
        self.assertTrue(all(c.name for c in u.constituents))

    def test_nasdaq100_shape(self):
        u = load("nasdaq100")
        self.assertTrue(95 <= len(u.symbols) <= 110)
        self.assertEqual(len(set(u.symbols)), len(u.symbols))

    def test_every_nifty_constituent_has_a_sector_bucket(self):
        missing = [s for s in load("nifty100").symbols if s not in SECTOR_MAP]
        self.assertEqual(missing, [], "add these symbols to pipeline/universes/sectors.py")

    def test_every_bucket_has_a_label(self):
        self.assertFalse(set(SECTOR_MAP.values()) - set(SECTOR_LABELS))


class NameCleanupTest(unittest.TestCase):
    def test_share_class_suffixes_are_removed(self):
        cases = {
            "Apple Inc. Common Stock": "Apple Inc.",
            "Alphabet Inc. Class C Capital Stock": "Alphabet Inc.",
            "Copart, Inc. (DE) Common Stock": "Copart, Inc.",
            "Cisco Systems, Inc. Common Stock (DE)": "Cisco Systems, Inc.",
            "Strategy Inc Common Stock Class A": "Strategy Inc",
            "Seagate Technology Holdings PLC Ordinary Shares (Ireland)":
                "Seagate Technology Holdings PLC",
            "Shopify Inc. Class A Subordinate Voting Shares": "Shopify Inc.",
            "Arm Holdings plc American Depositary Shares": "Arm Holdings plc",
            "Monster Beverage Corporation": "Monster Beverage Corporation",
        }
        for raw, expected in cases.items():
            self.assertEqual(clean_nasdaq_name(raw), expected)


if __name__ == "__main__":
    unittest.main()
