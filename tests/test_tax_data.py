"""Checks on the tax reference data published under site/data/tax/.

The RSU tools convert every value with these rates and prices, so a gap,
a bad row or a stale file would silently produce wrong Schedule FA figures.
"""

import datetime
import itertools
import json
import os
import unittest

from pipeline.taxdata import (
    TAX_STOCKS, merge_dividends, parse_nasdaq_dividends, parse_sbi_csv, stock_file,
)

TAX_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "site", "data", "tax")


def _load(name: str):
    path = os.path.join(TAX_DIR, name)
    if not os.path.exists(path):
        raise unittest.SkipTest(f"{name} not published yet")
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _dates_ok(test: unittest.TestCase, rows: list, label: str) -> None:
    dates = [r[0] for r in rows]
    test.assertEqual(dates, sorted(set(dates)), f"{label}: dates must be unique and sorted")
    for d in (dates[0], dates[-1]):
        datetime.date.fromisoformat(d)


class PublishedRatesTest(unittest.TestCase):
    def test_rates(self):
        blob = _load("sbi-tt-buy-usd.json")
        rates = blob["rates"]
        self.assertGreater(len(rates), 1000)
        _dates_ok(self, rates, "rates")
        self.assertTrue(all(40 <= r[1] <= 250 for r in rates), "implausible TT rate")
        self.assertEqual(blob["first"], rates[0][0])
        self.assertEqual(blob["last"], rates[-1][0])
        gaps = [(a[0], b[0]) for a, b in itertools.pairwise(rates)
                if (datetime.date.fromisoformat(b[0]) - datetime.date.fromisoformat(a[0])).days > 10
                and a[0] >= "2022-01-01"]
        self.assertEqual(gaps, [], "SBI rates have gaps longer than 10 days since 2022")


class PublishedStocksTest(unittest.TestCase):
    def test_stocks(self):
        for symbol in TAX_STOCKS:
            with self.subTest(symbol=symbol):
                blob = _load(stock_file(symbol))
                self.assertEqual(blob["symbol"], symbol)
                closes = blob["closes"]
                self.assertGreater(len(closes), 1000)
                _dates_ok(self, closes, f"{symbol} closes")
                self.assertTrue(all(c[1] > 0 for c in closes))
                divs = blob["dividends"]
                self.assertTrue(divs)
                exes = [d["ex"] for d in divs]
                self.assertEqual(exes, sorted(set(exes)))
                for d in divs:
                    self.assertGreater(d["amount"], 0)
                    if d.get("pay"):
                        self.assertGreaterEqual(d["pay"], d["ex"])


class ParserTest(unittest.TestCase):
    def test_sbi_csv_keeps_first_rate_and_drops_blanks(self):
        text = ("\ufeffDATE,PDF FILE,TT BUY,TT SELL\n"
                "2025-01-04 09:00,x,0.00,0.00\n"
                "2025-01-06 15:40,x,86.00,87\n"
                "2025-01-06 09:15,x,86.15,87\n"
                "2025-01-07 09:10,x,85.90,86.8\n"
                "bad,x,85,86\n")
        self.assertEqual(parse_sbi_csv(text), [["2025-01-06", 86.15], ["2025-01-07", 85.9]])

    def test_nasdaq_dividends(self):
        payload = {"data": {"dividends": {"rows": [
            {"exOrEffDate": "08/20/2026", "type": "Cash", "amount": "$0.91",
             "declarationDate": "06/10/2026", "recordDate": "08/20/2026",
             "paymentDate": "09/10/2026"},
            {"exOrEffDate": "03/01/2026", "type": "Stock", "amount": "2.0",
             "declarationDate": "N/A", "recordDate": "N/A", "paymentDate": "N/A"},
        ]}}}
        self.assertEqual(parse_nasdaq_dividends(payload), [
            {"ex": "2026-08-20", "record": "2026-08-20", "pay": "2026-09-10",
             "declared": "2026-06-10", "amount": 0.91}])

    def test_merge_skips_same_dividend_with_shifted_date(self):
        primary = [{"ex": "2026-08-20", "pay": "2026-09-10", "amount": 0.91}]
        fallback = [{"ex": "2026-08-19", "amount": 0.91},   # same dividend, shifted
                    {"ex": "2026-11-19", "amount": 0.98}]   # genuinely new
        merged = merge_dividends(primary, fallback)
        self.assertEqual([d["ex"] for d in merged], ["2026-08-20", "2026-11-19"])
        self.assertIsNone(merged[1]["pay"])


if __name__ == "__main__":
    unittest.main()
