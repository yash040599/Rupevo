"""Tests for the checked-in index universes, name cleanup and the NYSE selection."""

import re
import unittest

from pipeline.universes import load
from pipeline.universes.refresh import (
    NYSE_JOIN_WITHIN, NYSE_KEEP_WITHIN, NYSE_LIST_SIZE, clean_nasdaq_name, select_nyse100,
)
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

    def test_nyse100_shape(self):
        u = load("nyse100")
        self.assertEqual(len(u.symbols), NYSE_LIST_SIZE)
        self.assertEqual(len(set(u.symbols)), NYSE_LIST_SIZE)
        self.assertTrue(all(c.name for c in u.constituents))
        self.assertTrue(all(re.fullmatch(r"[A-Z]{1,6}(\.[A-C])?", s) for s in u.symbols), u.symbols)
        # A company is listed on one exchange, so the two US lists never overlap.
        self.assertEqual(set(u.symbols) & set(load("nasdaq100").symbols), set())

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
            "MPLX LP Common Units Representing Limited Partner Interests": "MPLX LP",
            "Merck & Company Inc. Common Stock (new)": "Merck & Company Inc.",
        }
        for raw, expected in cases.items():
            self.assertEqual(clean_nasdaq_name(raw), expected)


def tick(i: int) -> str:
    """Letter-only ticker for synthetic company number i: 1 -> XAAA, 2 -> XAAB, ..."""
    a, rest = divmod(i - 1, 26 * 26)
    b, c = divmod(rest, 26)
    return "X" + "".join(chr(65 + n) for n in (a, b, c))


def screener_rows(n: int, *, cap_top: float = 400e9, step: float = 1e9) -> list[dict]:
    """n synthetic US NYSE listings, largest first: tick(1) at $400B, tick(2), ... (made-up companies)."""
    return [{"symbol": tick(i), "name": f"Company {tick(i)} Inc. Common Stock",
             "country": "United States", "sector": "Industrials",
             "marketCap": f"{cap_top - (i - 1) * step:.2f}", "volume": "1000000"}
            for i in range(1, n + 1)]


class NyseSelectionTest(unittest.TestCase):
    def test_largest_us_common_stocks_one_class_each(self):
        rows = screener_rows(400)
        rows += [
            {"symbol": "ABRD", "name": "Abroad plc", "country": "United Kingdom",
             "marketCap": "900000000000", "volume": "5"},
            {"symbol": tick(1) + "^A", "name": f"Company {tick(1)} Inc. Preferred", "country": "United States",
             "marketCap": "800000000000", "volume": "5"},
            {"symbol": tick(2) + "/WS", "name": f"Company {tick(2)} Warrants", "country": "United States",
             "marketCap": "800000000000", "volume": "5"},
            {"symbol": "BRK/A", "name": "Berkshire Hathaway Inc.", "country": "United States",
             "marketCap": "1000000000000", "volume": "900"},
            {"symbol": "BRK/B", "name": "Berkshire Hathaway Inc.", "country": "United States",
             "marketCap": "1000000000000", "volume": "4000000"},
            # Listed debt carries the issuer's market value in the screener.
            {"symbol": "XNTS", "name": "Example Corp 5.350% Global Notes due 2066",
             "country": "United States", "marketCap": "700000000000", "volume": "150000"},
            {"symbol": "XZON", "name": "Example Holdings ZONES", "country": "United States",
             "marketCap": "700000000000", "volume": "16"},
            {"symbol": "XDEB", "name": "Example Energy 5.625% Junior Subordinated Debentures due 2078",
             "country": "United States", "marketCap": "700000000000", "volume": "90000"},
        ]
        picked = select_nyse100(rows)
        symbols = [r["symbol"] for r in picked]
        self.assertEqual(len(picked), NYSE_LIST_SIZE)
        self.assertIn("BRK.B", symbols)
        self.assertNotIn("BRK.A", symbols)
        self.assertFalse({"ABRD", tick(1) + "^A", tick(2) + "/WS", "XNTS", "XZON", "XDEB"} & set(symbols))
        # Berkshire plus the 99 largest synthetic companies.
        self.assertEqual(sorted(symbols), sorted(["BRK.B"] + [tick(i) for i in range(1, 100)]))
        self.assertEqual(picked[0], {"symbol": "BRK.B", "name": "Berkshire Hathaway Inc.", "industry": ""})
        self.assertEqual(next(r for r in picked if r["symbol"] == tick(1))["name"], f"Company {tick(1)} Inc.")

    def test_buffer_keeps_members_near_the_cut_and_admits_big_newcomers(self):
        rows = screener_rows(400)
        current = {tick(i) for i in range(1, 101)}

        def ranked_as(number: int, position: int) -> list[dict]:
            # Move company `number` to about `position` in the size order by giving it a market
            # value just above the company currently there.
            out = [dict(r) for r in rows]
            target = next(r for r in out if r["symbol"] == tick(position))
            mover = next(r for r in out if r["symbol"] == tick(number))
            mover["marketCap"] = f"{float(target['marketCap']) + 0.5e9:.2f}"
            return out

        # A member slipping to #110 stays; the non-member it overtook in size does not join.
        kept = {r["symbol"] for r in select_nyse100(ranked_as(50, 110), current)}
        self.assertIn(tick(50), kept)
        self.assertEqual(kept, current)
        # A member falling below #120 leaves, and the largest non-member takes its place.
        gone = {r["symbol"] for r in select_nyse100(ranked_as(50, NYSE_KEEP_WITHIN + 10), current)}
        self.assertNotIn(tick(50), gone)
        self.assertIn(tick(101), gone)
        # A non-member reaching the top 80 joins at once, pushing out the smallest member.
        joined = {r["symbol"] for r in select_nyse100(ranked_as(150, NYSE_JOIN_WITHIN - 10), current)}
        self.assertIn(tick(150), joined)
        self.assertNotIn(tick(100), joined)
        self.assertEqual(len(joined), NYSE_LIST_SIZE)

    def test_a_short_or_broken_download_is_refused(self):
        with self.assertRaises(ValueError):
            select_nyse100(screener_rows(250))
        # Market values that small mean the download is not the real NYSE list.
        with self.assertRaises(ValueError):
            select_nyse100(screener_rows(400, cap_top=5.5e9, step=0.01e9))


if __name__ == "__main__":
    unittest.main()
