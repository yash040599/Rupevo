"""Mutual fund comparison: parsers, name matching, scoring maths and a full build.

Offline: the AMFI, mfapi.in and NSE clients are replaced by fakes fed with
synthetic funds (made-up names and NAVs).
"""

import datetime
import json
import math
import os
import tempfile
import unittest
from unittest import mock

from pipeline import mf, mf_valuation
from pipeline.engine import mf_scoring as ms
from pipeline.providers.amfi import (
    MfDataError, index_key, latest_ter, parse_mfapi, parse_nav_all, parse_nse_indices,
)
from tests.test_published_data import FORBIDDEN_WORDS

D = datetime.date

NAV_ALL = """Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date

Open Ended Schemes(Equity Scheme - Large Cap Fund)

Alpha Mutual Fund

2001;INF000A01AA1;-;Alpha Large Cap Fund;Direct Plan;Growth Option;55.1234;08-Oct-2026
2101;INF000A01AA2;-;Alpha Large Cap Fund;Regular Plan;Growth Option;50.0000;08-Oct-2026
2201;INF000A01AA3;INF000A01AA4;Alpha Large Cap Fund;Direct Plan;IDCW Option;20.0000;08-Oct-2026

Open Ended Schemes(Other Scheme - Index Funds)

Beta Mutual Fund

1002;INF000B01BB1;-;Beta Nifty 50 Index Fund;Direct Plan;Cumulative;31.5000;08-Oct-2026
1003;INF000B01BB2;-;Beta Sensex Index Fund;Direct Plan;;40.0000;08-Oct-2026
1004;INF000B01BB3;-;Beta Old Index Fund - Direct Plan - Growth;;;12.0000;08-Oct-2026
1005;INF000B01BB4;-;Beta Value Fund;;;N.A.;08-Oct-2026

Close Ended Schemes(Income)

Alpha Mutual Fund

9001;INF000A01ZZ1;-;Alpha Fixed Term Plan;;;10.5;08-Oct-2026
"""


class ParserTest(unittest.TestCase):
    def test_nav_all(self):
        rows = {r["code"]: r for r in parse_nav_all(NAV_ALL)}
        self.assertNotIn(9001, rows, "close-ended schemes are skipped")
        self.assertTrue(rows[2001]["direct"] and rows[2001]["growth"] and rows[2001]["labelled"])
        self.assertEqual(rows[2001]["amc"], "Alpha Mutual Fund")
        self.assertEqual(rows[2001]["category"], "Equity Scheme - Large Cap Fund")
        self.assertEqual(rows[2001]["date"], D(2026, 10, 8))
        self.assertFalse(rows[2101]["direct"])
        self.assertFalse(rows[2201]["growth"])
        self.assertTrue(rows[1002]["growth"], "'Cumulative' is the growth option")
        self.assertFalse(rows[1003]["labelled"], "a direct plan with a blank option is not labelled")
        self.assertTrue(rows[1004]["direct"] and rows[1004]["growth"], "old rows carry plan and option in the name")
        self.assertIsNone(rows[1005]["nav"])

    def test_mfapi(self):
        payload = {"status": "SUCCESS", "data": [
            {"date": "08-10-2026", "nav": "12.50"}, {"date": "07-10-2026", "nav": "12.40"},
            {"date": "bad", "nav": "1"}, {"date": "06-10-2026", "nav": "0"}]}
        self.assertEqual(parse_mfapi(payload), [(D(2026, 10, 7), 12.4), (D(2026, 10, 8), 12.5)])

    def test_nse_indices(self):
        text = ("Index Name,Index Date,Open Index Value,High Index Value,Low Index Value,Closing Index Value,"
                "Points Change,Change(%),Volume,Turnover (Rs. Cr.),P/E,P/B,Div Yield\n"
                "Nifty 50,07-10-2026,1,2,1,22603.05,-1,-1,1,1,19.34,2.78,1.22\n"
                "Nifty100 Equal Weight,07-10-2026,1,2,1,100,1,1,1,1,19.2,3.09,1.1\n"
                "Nifty 50 Futures Index,07-10-2026,1,2,1,100,1,1,1,1,-,-,-\n")
        rows = parse_nse_indices(text)
        self.assertEqual(set(rows), {"nifty50", "nifty100equalweight"})
        self.assertEqual(rows["nifty50"]["pe"], 19.34)
        self.assertEqual(rows["nifty50"]["date"], D(2026, 10, 7))
        self.assertEqual(index_key("NIFTY 100 Equal Weight"), "nifty100equalweight")

    def test_latest_ter_keeps_each_schemes_latest_day(self):
        rows = [{"Scheme_Name": "UTI - Flexi Cap Fund.", "TER_Date": "2026-10-01T00:00:00.000Z", "D_TER": "0.9", "R_TER": "1.7"},
                {"Scheme_Name": "UTI - Flexi Cap Fund.", "TER_Date": "2026-10-07T00:00:00.000Z", "D_TER": "0.85", "R_TER": "1.7"},
                {"Scheme_Name": "UTI Nifty 50 Index Fund", "TER_Date": "2026-10-07T00:00:00.000Z", "D_TER": "0.0000"}]
        out = {r["name"]: r for r in latest_ter(rows)}
        self.assertEqual(out["UTI - Flexi Cap Fund."]["ter_direct"], 0.85)
        self.assertEqual(out["UTI - Flexi Cap Fund."]["date"], "2026-10-07")
        self.assertIsNone(out["UTI Nifty 50 Index Fund"]["ter_direct"], "a zero TER is treated as missing")


class NameMatchingTest(unittest.TestCase):
    def test_name_key(self):
        self.assertEqual(mf.name_key("UTI - Flexi Cap Fund."), mf.name_key("UTI Flexi Cap Fund"))
        self.assertEqual(mf.name_key("Axis Nifty50 Equal Weight Index Fund"), "axis nifty 50 equal weight")
        self.assertEqual(mf.name_key("Sundaram Nifty 100 Equal Weight Fund (Formerly Known as Principal X)"),
                         "sundaram nifty 100 equal weight")
        self.assertEqual(mf.name_key("Nippon India Index Fund - Nifty 50 Plan"), "nippon india nifty 50")

    def test_benchmark_key(self):
        self.assertEqual(mf.benchmark_key("Nifty200 Momentum 30 TRI"), "nifty 200 momentum 30")
        self.assertEqual(mf.benchmark_key("NIFTY 100 Equal Weighted TRI"), "nifty 100 equal weight")
        self.assertEqual(mf.benchmark_key("S&P BSE Sensex TRI"), "bse sensex")
        self.assertEqual(mf.benchmark_key("Nifty Alpha Low -Volatility 30 TRI"), "nifty alpha low volatility 30")

    def test_close_matches_need_the_same_numbers(self):
        self.assertEqual(mf.similarity("uti nifty 50", "uti nifty 500"), 0.0)
        self.assertEqual(mf.closest("uti nifty 50", ["uti nifty 500", "uti nifty next 50"], 0.8), None)
        self.assertEqual(mf.closest("hdfc flexicap", ["hdfc flexicap", "hdfc focused"], 0.8), "hdfc flexicap")
        self.assertEqual(mf.closest("kotak nifty 50", ["kotak nifty 50 tracker", "kotak nifty 50 etf"], 0.7), None,
                         "two equally close names are ambiguous")

    def test_index_group_from_name(self):
        self.assertEqual(mf.index_group_by_name("Kotak NIFTY 100 Low Volatility 30 Index Fund").key, "lowvol30")
        self.assertEqual(mf.index_group_by_name("Axis Nifty50 Equal Weight Index Fund").key, "nifty50ew")
        self.assertEqual(mf.index_group_by_name("UTI Nifty Next 50 Index Fund").key, "next50")
        self.assertEqual(mf.index_group_by_name("Motilal Oswal Nifty 500 Index Fund (MOFNIFTY500)").key, "nifty500")
        self.assertEqual(mf.index_group_by_name("Kotak Nifty SmallCap 250 Index Fund").key, "smallcap250")
        self.assertIsNone(mf.index_group_by_name("SBI Nifty Index Fund"))
        for other in ("Nippon India Nifty 500 Momentum 50 Index Fund", "ICICI Prudential Nifty50 Value 20 Index Fund",
                      "Axis Nifty Midcap 50 Index Fund", "Kotak Nifty Smallcap 50 Index Fund"):
            self.assertIsNone(mf.index_group_by_name(other), f"{other}: a different index")

    def test_mislabelled_benchmark_follows_the_name_when_returns_agree(self):
        def rec(name, benchmark, own, index):
            return {"schemeName": name, "benchmark": benchmark, "return1YearDirect": own,
                    "return1YearBenchmark": index}
        records = [rec("Jio Nifty 50 Index Fund", "Nifty 500 TRI", -9.1, -4.0),
                   rec("SBI Nifty Index Fund", "Nifty 50 TRI", -9.2, -9.0),
                   rec("Axis Nifty 500 Index Fund", "Nifty 500 TRI", -4.2, -4.1),
                   rec("Kotak Nifty SmallCap 250 Index Fund", "NIFTY Smallcap 50 TRI", 5.1, 9.9),
                   rec("Axis Nifty Smallcap 250 Index Fund", "Nifty Smallcap 250 TRI", 5.3, 5.7),
                   rec("Odd Nifty 50 Index Fund", "Nifty 100 TRI", -2.0, -7.0),
                   rec("Some Gold Fund", "Gold Index", 20.0, 21.0)]
        groups, skipped = mf.assign_index_records(records)
        self.assertEqual([(r["schemeName"], moved) for r, moved in groups["nifty50"]],
                         [("SBI Nifty Index Fund", None), ("Jio Nifty 50 Index Fund", "Nifty 500 TRI")])
        self.assertEqual([r["schemeName"] for r, _ in groups["smallcap250"]],
                         ["Axis Nifty Smallcap 250 Index Fund", "Kotak Nifty SmallCap 250 Index Fund"],
                         "a label outside our indices does not drop the fund")
        self.assertEqual(len(groups["nifty500"]), 1)
        self.assertEqual(skipped, ["Odd Nifty 50 Index Fund"], "its return is far from the Nifty 50's")
        ref = mf.index_reference(groups["nifty50"])
        self.assertEqual(ref["1y"], -9.0, "regrouped funds do not set the index return")

    def test_scheme_index(self):
        schemes = parse_nav_all(NAV_ALL)
        index = mf.SchemeIndex(schemes)
        self.assertEqual(index.find("Alpha Large Cap Fund", 55.0)["code"], 2001)
        self.assertEqual(index.find("Beta Nifty 50 Index Fund", 31.4)["code"], 1002)
        self.assertEqual(index.find("Beta Sensex Index Fund", 40.1)["code"], 1003,
                         "an unlabelled direct row is used when its NAV matches")
        self.assertIsNone(index.find("Beta Sensex Index Fund", 30.0), "...and only then")

    def test_indian_number(self):
        self.assertEqual(mf.indian_number(12345678), "1,23,45,678")
        self.assertEqual(mf.indian_number(999), "999")
        self.assertEqual(mf.crore(3911.7), "₹3,912 crore")


def business_days(start: datetime.date, end: datetime.date):
    day = start
    while day <= end:
        if day.weekday() < 5:
            yield day
        day += datetime.timedelta(days=1)


def nav_series(start, end, annual, wiggle=0.0, phase=0):
    """Synthetic NAVs on every weekday, growing `annual` a year with a sine wiggle (drawdowns, volatility)."""
    daily = (1 + annual) ** (1 / 260.9) - 1
    nav, out = 10.0, []
    for i, day in enumerate(business_days(start, end)):
        nav *= 1 + daily + wiggle * math.sin((i + phase) / 23.0) * 0.0005
        out.append((day, round(nav, 4)))
    return out


class ScoringMathsTest(unittest.TestCase):
    def test_dates(self):
        self.assertEqual(ms.month_end(2024, 2), D(2024, 2, 29))
        self.assertEqual(ms.shift_month_end(D(2026, 9, 30), -36), D(2023, 9, 30))
        self.assertEqual(ms.last_month_end(D(2026, 10, 7)), D(2026, 9, 30))
        self.assertEqual(ms.last_month_end(D(2026, 9, 30)), D(2026, 9, 30))
        ends = ms.rolling_ends(D(2026, 10, 7))
        self.assertEqual((len(ends), ends[0], ends[-1]), (60, D(2021, 10, 31), D(2026, 9, 30)))
        self.assertEqual(ms.years_before(D(2024, 2, 29), 1), D(2023, 2, 28))

    def test_returns_and_risk(self):
        series = ms.NavSeries(nav_series(D(2016, 1, 1), D(2026, 10, 7), 0.12))
        self.assertAlmostEqual(ms.trailing_cagr(series, D(2026, 10, 7), 5), 12.0, delta=0.3)
        self.assertIsNone(ms.trailing_cagr(series, D(2026, 10, 7), 20), "no NAV 20 years back")
        windows = ms.rolling_cagrs(series, ms.rolling_ends(D(2026, 10, 7)))
        self.assertEqual(len(windows), 60)
        self.assertTrue(all(abs(v - 12.0) < 0.5 for v in windows.values()))
        self.assertAlmostEqual(ms.max_drawdown(series, D(2021, 10, 7), D(2026, 10, 7)), 0.0, places=6)
        wavy = ms.NavSeries(nav_series(D(2016, 1, 1), D(2026, 10, 7), 0.12, wiggle=6))
        self.assertLess(ms.max_drawdown(wavy, D(2021, 10, 7), D(2026, 10, 7)), -5)
        self.assertGreater(ms.annual_volatility(wavy, ms.rolling_ends(D(2026, 10, 7), 61)), 5)
        young = ms.NavSeries(nav_series(D(2025, 1, 1), D(2026, 10, 7), 0.12))
        self.assertIsNone(ms.annual_volatility(young, ms.rolling_ends(D(2026, 10, 7), 61)))

    def test_consistency_against_the_median(self):
        ends = [D(2026, 7, 31), D(2026, 8, 31), D(2026, 9, 30)]
        windows = {"a": dict.fromkeys(ends, 15.0), "b": dict.fromkeys(ends, 12.0),
                   "c": {ends[0]: 9.0, ends[1]: 13.0, ends[2]: 9.0}}
        medians = ms.window_medians(windows)
        self.assertEqual(medians, {ends[0]: 12.0, ends[1]: 13.0, ends[2]: 12.0})
        self.assertEqual(ms.consistency(windows["a"], medians), (3, 3))
        self.assertEqual(ms.consistency(windows["b"], medians), (0, 3), "equal to the median is not above it")
        self.assertEqual(ms.window_medians({"a": windows["a"], "b": windows["b"]}), {}, "needs 3 funds")

    def test_percentiles_and_scales(self):
        self.assertEqual(ms.percentile_scores({"a": 1, "b": 2, "c": 3}), {"a": 0.0, "b": 50.0, "c": 100.0})
        self.assertEqual(ms.percentile_scores({"a": 1, "b": 2, "c": 3}, higher_is_better=False)["a"], 100.0)
        self.assertEqual(ms.percentile_scores({"a": 2, "b": 2, "c": None}), {"a": 50.0, "b": 50.0})
        self.assertEqual(ms.tracking_score(-0.25), 75.0)
        self.assertEqual(ms.tracking_score(-1.5), 0.0)
        self.assertEqual(ms.cost_score(0.1), 90.0)
        self.assertEqual(ms.steadiness_score(0.05), 90.0)
        self.assertAlmostEqual(ms.size_score(1000), 200 / 3)
        score, share = ms.weighted_score({"a": 80, "b": None, "c": 40}, {"a": 50, "b": 25, "c": 25})
        self.assertAlmostEqual(score, (80 * 50 + 40 * 25) / 75)
        self.assertEqual(share, 0.75)

    def test_index_scores_count_a_gap_either_way_and_shrink_young_funds(self):
        def fund(code, td1, td3):
            return {"code": code, "status": "ranked", "ter": 0.2, "aum_cr": 1000.0, "tracking_error": 0.05,
                    "tracking_difference": {"1y": td1, "3y": td3}}
        funds = [fund(1, -0.2, -0.2), fund(2, 0.2, 0.2), fund(3, -0.1, None), fund(4, -0.6, -0.6)]
        mf.score_index(funds)
        by = {f["code"]: f["components"]["tracking"] for f in funds}
        self.assertEqual(by[1], by[2], "ahead of the index counts like behind it")
        self.assertEqual(by[3], (90 + 80) / 2, "a 1-year record is pulled halfway to the typical fund")
        self.assertLess(by[4], by[1])


class FakeAmfi:
    """AMFI with three active large-cap funds, a young one, and Nifty 50 index funds."""

    def __init__(self, as_of):
        self.as_of = as_of
        self.calls = []
        mk = self._scheme
        self.schemes = [mk(2001, "Alpha Large Cap Fund", "Alpha", "Equity Scheme - Large Cap Fund"),
                        mk(2002, "Beta Large Cap Fund", "Beta", "Equity Scheme - Large Cap Fund"),
                        mk(2003, "Gamma Large Cap Fund", "Gamma", "Equity Scheme - Large Cap Fund"),
                        mk(2004, "Delta Large Cap Fund", "Delta", "Equity Scheme - Large Cap Fund"),
                        mk(1001, "Alpha Nifty 50 Index Fund", "Alpha", "Other Scheme - Index Funds"),
                        mk(1002, "Beta Nifty 50 Index Fund", "Beta", "Other Scheme - Index Funds"),
                        mk(1003, "Gamma Nifty 50 Index Fund", "Gamma", "Other Scheme - Index Funds"),
                        mk(1004, "Delta Nifty 50 Index Fund", "Delta", "Other Scheme - Index Funds")]

    @staticmethod
    def _scheme(code, name, amc, category):
        return {"code": code, "isin": f"INF{code}", "name": name, "plan": "Direct Plan", "option": "Growth",
                "labelled": True, "direct": True, "growth": True, "nav": 10.0, "date": D(2026, 10, 8),
                "amc": f"{amc} Mutual Fund", "category": category}

    def nav_all(self):
        return self.schemes

    def performance_date(self, latest):
        return self.as_of

    @staticmethod
    def _record(name, benchmark, aum, returns, bench):
        rec = {"schemeName": name, "benchmark": benchmark, "navDirect": 10.0, "dailyAUM": aum,
               "riskometerScheme": "Very High"}
        for (period, value), b in zip(returns.items(), bench, strict=True):
            rec[f"return{period}Direct"] = value
            rec[f"return{period}Benchmark"] = b
        return rec

    def performance(self, category, subcategory, report_date):
        self.calls.append((category, subcategory))
        bench = (-9.0, 6.0, 6.2, 11.3)
        if (category, subcategory) == (5, 38):
            r = self._record
            return [r("Alpha Nifty 50 Index Fund", "Nifty 50 TRI", 4000, {"1Year": -9.1, "3Year": 5.8, "5Year": 6.0, "10Year": None}, bench),
                    r("Beta Nifty 50 Index Fund", "Nifty 50 TRI", 900, {"1Year": -9.4, "3Year": 5.6, "5Year": 5.8, "10Year": None}, bench),
                    r("Gamma Nifty 50 Index Fund", "Nifty 50 TRI", 20, {"1Year": None, "3Year": None, "5Year": None, "10Year": None}, bench),
                    r("Delta Nifty 50 Index Fund", "Nifty 500 TRI", 300, {"1Year": -9.2, "3Year": None, "5Year": None, "10Year": None},
                      (-4.0, 9.5, 8.7, None)),
                    {**r("Alpha Nifty 50 ETF", "Nifty 50 TRI", 9000, {"1Year": -9.0, "3Year": 6.0, "5Year": 6.2, "10Year": None}, bench),
                     "navDirect": None}]
        if (category, subcategory) == (1, 1):
            r = self._record
            b = (-7.0, 7.7, 6.8, None)
            return [r("Alpha Large Cap Fund", "Nifty 100 TRI", 50000, {"1Year": -5.0, "3Year": 13.0, "5Year": 14.0, "10Year": None}, b),
                    r("Beta Large Cap Fund", "Nifty 100 TRI", 20000, {"1Year": -7.0, "3Year": 10.0, "5Year": 11.0, "10Year": None}, b),
                    r("Gamma Large Cap Fund", "Nifty 100 TRI", 300, {"1Year": -9.0, "3Year": 7.0, "5Year": 8.0, "10Year": None}, b),
                    r("Delta Large Cap Fund", "Nifty 100 TRI", 800, {"1Year": -6.0, "3Year": 12.0, "5Year": None, "10Year": None}, b)]
        return []

    def amcs(self):
        return [{"id": str(i), "name": f"{n} Mutual Fund"} for i, n in enumerate(("Alpha", "Beta", "Gamma", "Delta"), 1)]

    def latest_ter(self, amc_id, today):
        ters = {"1": [("Alpha Large Cap Fund", 0.6), ("Alpha - Nifty 50 Index Fund.", 0.1)],
                "2": [("Beta Large Cap Fund", 0.9), ("Beta Nifty 50 Index Fund", 0.3)],
                "3": [("Gamma Large Cap Fund", 1.2), ("Gamma Nifty 50 Index Fund", 0.2)],
                "4": [("Delta Large Cap Fund", 0.7), ("Delta Nifty 50 Index Fund", 0.25)]}
        return [{"name": n, "category": "", "date": "2026-10-07", "ter_direct": t, "ter_regular": None}
                for n, t in ters[amc_id]]

    def latest_tracking_error(self, today):
        return [{"Scheme_Name": n, "DirectPercent": te, "as_of": "2026-10-07"} for n, te in
                (("Alpha Nifty 50 Index Fund", 0.03), ("Beta Nifty 50 Index Fund", 0.08),
                 ("Delta Nifty 50 Index Fund", 0.06), ("Alpha Nifty 50 ETF", 0.01))]


class FakeMfApi:
    def __init__(self, as_of):
        end = as_of
        self.histories = {
            # Wiggles small enough to keep the order in every 3-year window: Alpha > Beta > Gamma.
            2001: nav_series(D(2015, 1, 1), end, 0.15, wiggle=2, phase=0),
            2002: nav_series(D(2015, 1, 1), end, 0.12, wiggle=1, phase=7),
            2003: nav_series(D(2015, 1, 1), end, 0.08, wiggle=2, phase=13),
            2004: nav_series(D(2023, 6, 1), end, 0.13, wiggle=1),
            1001: nav_series(D(2016, 1, 1), end, 0.11, wiggle=2),
            1002: nav_series(D(2019, 1, 1), end, 0.11, wiggle=2),
            1003: nav_series(D(2026, 3, 1), end, 0.11, wiggle=2),
            1004: nav_series(D(2025, 6, 1), end, 0.11, wiggle=2),
        }

    def history(self, code):
        if code not in self.histories:
            raise MfDataError(f"no history for {code}")
        return self.histories[code]


class FakeNse:
    """Nifty 50 P/E drifting between 20 and 29 at month-ends, 18.5 today."""

    def __init__(self):
        self.calls = 0

    def last_on_or_before(self, day, days_back=7):
        self.calls += 1
        pe = 18.5 if day >= D(2026, 10, 1) else 20 + (day.year * 12 + day.month) % 10
        return {index_key(n): {"name": n, "date": day, "close": 100.0, "pe": pe, "pb": 3.0, "dy": 1.2}
                for n in ("Nifty 50", "Nifty 100", "Nifty 500")}


class BuildTest(unittest.TestCase):
    TODAY = D(2026, 10, 9)
    AS_OF = D(2026, 10, 7)

    def build(self, previous=None):
        with mock.patch.object(mf, "MIN_RANKED", 1):
            return mf.build(FakeAmfi(self.AS_OF), FakeMfApi(self.AS_OF), FakeNse(), previous=previous,
                            today=self.TODAY)

    @classmethod
    def setUpClass(cls):
        with mock.patch.object(mf, "MIN_RANKED", 1):
            cls.snap = mf.build(FakeAmfi(cls.AS_OF), FakeMfApi(cls.AS_OF), FakeNse(), today=cls.TODAY)
        cls.groups = {g["key"]: g for g in cls.snap["groups"]}

    def test_shape(self):
        s = self.snap
        self.assertEqual((s["market"], s["data_through"]), ("mf", "2026-10-07"))
        self.assertEqual(set(self.groups), {"nifty50", "largecap"})
        self.assertEqual(s["stats"]["funds"], 8, "the ETF (no direct plan) is left out")
        json.dumps(s, ensure_ascii=False)

    def test_index_group(self):
        g = self.groups["nifty50"]
        funds = {f["name"]: f for f in g["funds"]}
        self.assertEqual(g["funds"][0]["name"], "Alpha Nifty 50 Index Fund")
        self.assertEqual([f["rank"] for f in g["funds"] if f["rank"]], [1, 2, 3])
        alpha = funds["Alpha Nifty 50 Index Fund"]
        self.assertEqual(alpha["tracking_difference"]["1y"], -0.1)
        self.assertEqual(alpha["tracking_difference"]["3y"], -0.2)
        self.assertEqual(alpha["ter"], 0.1, "TER matched through a differently punctuated name")
        self.assertEqual(alpha["tracking_error"], 0.03)
        delta = funds["Delta Nifty 50 Index Fund"]
        self.assertEqual(delta["tracking_difference"]["1y"], -0.2, "regrouped fund measured against the Nifty 50")
        self.assertEqual(delta["benchmark"], "Nifty 50 TRI")
        self.assertTrue(any("Grouped by its name" in n for n in delta["notes"]))
        gamma = funds["Gamma Nifty 50 Index Fund"]
        self.assertEqual((gamma["status"], gamma["rank"]), ("too_new", None))
        self.assertTrue(any("Small fund" in n for n in gamma["notes"]))
        self.assertEqual(g["stats"]["index_return"]["1y"], -9.0)

    def test_active_group(self):
        g = self.groups["largecap"]
        funds = {f["name"]: f for f in g["funds"]}
        self.assertEqual([f["name"] for f in g["funds"] if f["rank"]],
                         ["Alpha Large Cap Fund", "Beta Large Cap Fund", "Gamma Large Cap Fund"])
        alpha = funds["Alpha Large Cap Fund"]
        self.assertEqual(alpha["consistency"]["of"], 60)
        self.assertEqual(alpha["consistency"]["beat"], 60)
        self.assertIsNotNone(alpha["volatility"])
        self.assertLess(alpha["max_drawdown"], 0)
        self.assertEqual(set(alpha["components"]), set(ms.ACTIVE_WEIGHTS))
        delta = funds["Delta Large Cap Fund"]
        self.assertEqual(delta["status"], "too_new")
        self.assertIn("5", delta["status_reason"])
        check = g["index_check"]
        self.assertEqual(check["name"], "Alpha Nifty 50 Index Fund")
        self.assertEqual(check["of"], 4)
        self.assertEqual(g["stats"]["beat_benchmark_5y"], {"beat": 3, "of": 3})

    def test_reasons_are_neutral(self):
        texts = [t for g in self.snap["groups"] for f in g["funds"]
                 for t in f["reasons"] + f["notes"] + [f["status_reason"] or ""]]
        self.assertTrue(texts)
        self.assertEqual([t for t in texts if FORBIDDEN_WORDS.search(t)], [])

    def test_unreachable_fund_house_keeps_previous_expense_ratios(self):
        class FlakyAmfi(FakeAmfi):
            def latest_ter(self, amc_id, today):
                if amc_id == "2":
                    raise MfDataError("throttled")
                return super().latest_ter(amc_id, today)
        with mock.patch.object(mf, "MIN_RANKED", 1):
            with self.assertRaises(mf.SnapshotError, msg="2 of 8 funds without a TER is too many to publish"):
                mf.build(FlakyAmfi(self.AS_OF), FakeMfApi(self.AS_OF), FakeNse(), today=self.TODAY)
            snap = mf.build(FlakyAmfi(self.AS_OF), FakeMfApi(self.AS_OF), FakeNse(), previous=self.snap,
                            today=self.TODAY)
        funds = {f["name"]: f for g in snap["groups"] for f in g["funds"]}
        self.assertEqual(funds["Beta Large Cap Fund"]["ter"], 0.9)
        self.assertEqual(funds["Beta Nifty 50 Index Fund"]["ter"], 0.3)
        self.assertFalse(any("Expense ratio" in n for f in funds.values() for n in f["notes"]))
        self.assertTrue(any(e["source"] == "AMFI expense ratios" for e in snap["errors"]))

    def test_valuation_reuses_months_already_fetched(self):
        v = self.snap["valuation"]
        n50 = next(i for i in v["indices"] if i["key"] == "nifty50")
        self.assertEqual((n50["pe"], n50["zone"], n50["percentile"]), (18.5, "low", 0.0))
        self.assertEqual(n50["since"][:7], "2021-04")
        nse = FakeNse()
        with mock.patch.object(mf, "MIN_RANKED", 1):
            mf.build(FakeAmfi(self.AS_OF), FakeMfApi(self.AS_OF), nse, previous=self.snap, today=self.TODAY)
        self.assertEqual(nse.calls, 1, "only the latest day is downloaded again")


class ValuationTest(unittest.TestCase):
    def test_helpers(self):
        self.assertEqual(mf_valuation.months_between(D(2021, 11, 5), D(2022, 2, 1)),
                         ["2021-11", "2021-12", "2022-01", "2022-02"])
        self.assertEqual(mf_valuation.percentile_of(20, [10, 20, 30, 40]), 37.5)
        self.assertEqual(mf_valuation.zone_of(10, 30), "low")
        self.assertEqual(mf_valuation.zone_of(50, 30), "mid")
        self.assertEqual(mf_valuation.zone_of(90, 30), "high")
        self.assertIsNone(mf_valuation.zone_of(10, 5), "too little history")

    def test_unreachable_nse_keeps_previous_values(self):
        class DownNse:
            def last_on_or_before(self, day, days_back=7):
                raise MfDataError("blocked")
        previous = {"valuation": {"months_fetched": ["2021-04"], "indices": [
            {"key": "nifty50", "pe": 21.0, "pb": 3.0, "dy": 1.2, "date": "2026-09-30",
             "history": [["2021-04-30", 30.0]]}]}}
        block, errors = mf_valuation.build(DownNse(), previous, D(2026, 10, 9))
        self.assertTrue(errors)
        n50 = next(i for i in block["indices"] if i["key"] == "nifty50")
        self.assertEqual((n50["pe"], n50["date"]), (21.0, "2026-09-30"))


class PublishTest(unittest.TestCase):
    def test_failure_keeps_the_published_file(self):
        class DownAmfi(FakeAmfi):
            def nav_all(self):
                raise MfDataError("AMFI unreachable")
        with tempfile.TemporaryDirectory() as out:
            path = os.path.join(out, "mf.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump({"market": "mf", "data_through": "2026-10-01"}, fh)
            result = mf.publish(out, None, amfi=DownAmfi(D(2026, 10, 7)), mfapi=FakeMfApi(D(2026, 10, 7)),
                                nse=FakeNse())
            self.assertFalse(result["ok"])
            with open(path, encoding="utf-8") as fh:
                self.assertEqual(json.load(fh)["data_through"], "2026-10-01")

    def test_older_data_is_not_published(self):
        with tempfile.TemporaryDirectory() as out:
            path = os.path.join(out, "mf.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump({"market": "mf", "data_through": "2026-12-31"}, fh)
            with mock.patch.object(mf, "MIN_RANKED", 1):
                result = mf.publish(out, None, amfi=FakeAmfi(D(2026, 10, 7)), mfapi=FakeMfApi(D(2026, 10, 7)),
                                    nse=FakeNse())
            self.assertFalse(result["ok"])
            self.assertIn("older", result["error"])


if __name__ == "__main__":
    unittest.main()
