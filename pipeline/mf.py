"""Mutual fund comparison: direct-plan equity funds ranked against their peers.

Published to site/data/mf.json for the Mutual Funds page. Two kinds of group:

* Index funds that track the same index (Nifty 50, Nifty Next 50, ...). They
  own the same shares, so what separates them is how closely and how cheaply
  they follow the index. Fixed scales: the gap to the index (the fund's 1- and
  3-year returns against the index's total return, from AMFI's return data)
  50%, tracking error 20%, expense ratio 20%, fund size 10%.
* Actively managed funds in one SEBI category (large cap, mid cap, ...),
  scored as percentiles within the category: consistency (how often the
  fund's rolling 3-year return beat the category median at the month-ends of
  the last five years) 30%, 3- and 5-year returns 20%, return per unit of
  volatility 20%, the worst fall in five years 15%, expense ratio 15%. Each
  category also says where a low-cost index fund would rank on the same rules.

Only direct plans (growth option) are compared: they pay no distributor
commission. ETFs are left out (no direct plan; bought on the exchange), and so
are index funds with an ELSS lock-in.

Fund names are the join key between AMFI's sources (scheme list, performance,
expense ratios, tracking data); `name_key` normalises them and a close-match
fallback catches small differences in punctuation and wording.
"""

from __future__ import annotations

import datetime
import json
import os
import re
import time
import traceback
from collections import Counter
from dataclasses import dataclass

from pipeline import mf_valuation
from pipeline.clock import iso, now_ist
from pipeline.engine import mf_scoring as ms
from pipeline.log import Logger
from pipeline.providers.amfi import (
    EQUITY, INDEX_FUNDS_AND_ETFS, OTHER, Amfi, MfApi, MfDataError, NseIndices,
)
from pipeline.snapshot import SCHEMA_VERSION, SnapshotError, rnd

MARKET = "mf"
TITLE = "Mutual Fund Comparison"
MIN_ACTIVE_YEARS = 5
SMALL_FUND_CRORE = {"index": 100.0, "active": 500.0}
STALE_NAV_DAYS = 10
MAX_HISTORY_FAILURE_SHARE = 0.2
MAX_GROUP_FAILURE_SHARE = 0.34
MIN_RANKED = 150
CACHE_HOURS = 18


@dataclass(frozen=True)
class Group:
    key: str
    kind: str                       # "index" or "active"
    label: str
    short: str
    about: str
    benchmark: str | None = None    # index groups: normalised benchmark they track
    subcategory: int | None = None  # active groups: AMFI equity sub-category
    valuation: str | None = None    # mf_valuation index key for the lump-sum check
    compare_with: str | None = None  # active groups: index group for the index check


INDEX_GROUPS = (
    Group("nifty50", "index", "Nifty 50 index funds", "Nifty 50",
          "India's 50 largest listed companies, weighted by the value of their freely traded shares.",
          benchmark="nifty 50", valuation="nifty50"),
    Group("sensex", "index", "Sensex index funds", "Sensex",
          "30 of the largest companies on the BSE.", benchmark="bse sensex", valuation="nifty50"),
    Group("next50", "index", "Nifty Next 50 index funds", "Next 50",
          "The 50 companies after the Nifty 50 in size (ranks 51 to 100).",
          benchmark="nifty next 50", valuation="next50"),
    Group("nifty100", "index", "Nifty 100 index funds", "Nifty 100",
          "The 100 largest companies: the Nifty 50 and the Next 50 together.",
          benchmark="nifty 100", valuation="nifty100"),
    Group("nifty100ew", "index", "Nifty 100 Equal Weight index funds", "Nifty 100 EW",
          "The same 100 companies at 1% each, reset every quarter, so the biggest do not dominate.",
          benchmark="nifty 100 equal weight", valuation="nifty100ew"),
    Group("nifty50ew", "index", "Nifty 50 Equal Weight index funds", "Nifty 50 EW",
          "The Nifty 50 companies at 2% each, reset every quarter.",
          benchmark="nifty 50 equal weight", valuation="nifty50ew"),
    Group("largemid250", "index", "Nifty LargeMidcap 250 index funds", "LargeMid 250",
          "Half in the Nifty 100 and half in the Nifty Midcap 150.",
          benchmark="nifty largemidcap 250", valuation="largemid250"),
    Group("midcap150", "index", "Nifty Midcap 150 index funds", "Midcap 150",
          "Companies ranked 101 to 250 by market value.", benchmark="nifty midcap 150", valuation="midcap150"),
    Group("smallcap250", "index", "Nifty Smallcap 250 index funds", "Smallcap 250",
          "Companies ranked 251 to 500 by market value.",
          benchmark="nifty smallcap 250", valuation="smallcap250"),
    Group("nifty500", "index", "Nifty 500 index funds", "Nifty 500",
          "The 500 largest companies: large, mid and small caps by market value.",
          benchmark="nifty 500", valuation="nifty500"),
    Group("totalmarket", "index", "Nifty Total Market index funds", "Total Market",
          "About 750 companies: the Nifty 500 plus the Nifty Microcap 250.",
          benchmark="nifty total market", valuation="totalmarket"),
    Group("momentum30", "index", "Nifty 200 Momentum 30 index funds", "Momentum 30",
          "The 30 Nifty 200 stocks with the strongest recent price momentum, reset twice a year.",
          benchmark="nifty 200 momentum 30"),
    Group("lowvol30", "index", "Nifty 100 Low Volatility 30 index funds", "Low Vol 30",
          "The 30 least volatile stocks of the Nifty 100.", benchmark="nifty 100 low volatility 30"),
    Group("alphalowvol30", "index", "Nifty Alpha Low-Volatility 30 index funds", "Alpha Low-Vol 30",
          "30 large and mid-sized stocks picked for high alpha and low volatility.",
          benchmark="nifty alpha low volatility 30"),
)

ACTIVE_GROUPS = (
    Group("largecap", "active", "Large-cap funds", "Large cap",
          "At least 80% in the 100 largest companies.", subcategory=1, valuation="nifty100",
          compare_with="nifty50"),
    Group("largemidcap", "active", "Large & mid-cap funds", "Large & mid",
          "At least 35% each in large and mid-sized companies.", subcategory=2, valuation="largemid250",
          compare_with="largemid250"),
    Group("flexicap", "active", "Flexi-cap funds", "Flexi cap",
          "At least 65% in shares, in any mix of company sizes.", subcategory=3, valuation="nifty500",
          compare_with="nifty500"),
    Group("multicap", "active", "Multi-cap funds", "Multi cap",
          "At least 25% each in large, mid and small companies.", subcategory=4, valuation="nifty500",
          compare_with="nifty500"),
    Group("midcap", "active", "Mid-cap funds", "Mid cap",
          "At least 65% in companies ranked 101 to 250 by market value.", subcategory=5,
          valuation="midcap150", compare_with="midcap150"),
    Group("smallcap", "active", "Small-cap funds", "Small cap",
          "At least 65% in companies ranked 251 and below.", subcategory=6, valuation="smallcap250",
          compare_with="smallcap250"),
    Group("focused", "active", "Focused funds", "Focused",
          "At most 30 stocks, any company size.", subcategory=11, valuation="nifty500",
          compare_with="nifty500"),
    Group("value", "active", "Value funds", "Value",
          "Shares picked by a value-investing strategy.", subcategory=7, valuation="nifty500",
          compare_with="nifty500"),
    Group("elss", "active", "ELSS (tax-saver) funds", "ELSS",
          "At least 80% in shares with a 3-year lock-in; deductible under section 80C in the old tax regime.",
          subcategory=8, valuation="nifty500", compare_with="nifty500"),
)

GROUPS = INDEX_GROUPS + ACTIVE_GROUPS
GROUP_BY_KEY = {g.key: g for g in GROUPS}


# ── Names ───────────────────────────────────────────────────────

_STOP = {"fund", "the", "scheme", "plan", "direct", "growth", "option", "an", "open", "ended",
         "index", "mutual", "mf", "of", "regular"}


def name_key(name: str) -> str:
    """Comparable form of a scheme name: 'UTI - Flexi Cap Fund.' and
    'UTI Flexi Cap Fund' both become 'uti flexicap'."""
    s = (name or "").lower()
    s = re.sub(r"\([^)]*\)", " ", s)
    s = re.sub(r"\b(formerly|erstwhile)\b.*$", " ", s)
    s = s.replace("&", " and ")
    s = re.sub(r"([a-z])(\d)", r"\1 \2", s)
    s = re.sub(r"(\d)([a-z])", r"\1 \2", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    s = re.sub(r"\b(mid|small|large|flexi|multi|micro)\s+cap\b", r"\1cap", s)
    return " ".join(t for t in s.split() if t not in _STOP)


def benchmark_key(text: str) -> str:
    """'Nifty200 Momentum 30 TRI' -> 'nifty 200 momentum 30'."""
    s = (text or "").lower()
    s = re.sub(r"\([^)]*\)", " ", s).replace("s&p", " ")
    s = re.sub(r"total returns? index|\btri\b|\bindex\b", " ", s)
    s = re.sub(r"\bweighted\b", "weight", s)
    s = re.sub(r"([a-z])(\d)", r"\1 \2", s)
    s = re.sub(r"(\d)([a-z])", r"\1 \2", s)
    return " ".join(re.sub(r"[^a-z0-9]+", " ", s).split())


def amc_key(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", " ", (name or "").lower())
    s = re.sub(r"\b(mutual fund|asset management|company|limited|ltd|amc|mf|private|pvt)\b", " ", s)
    return " ".join(s.split())


def amc_label(name: str) -> str:
    return re.sub(r"\s*Mutual Fund\s*$", "", (name or "").strip(), flags=re.I) or name


def similarity(a: str, b: str) -> float:
    """Token overlap of two name keys; 0 unless both carry the same numbers
    (so 'nifty 50' never matches 'nifty 100' or 'nifty 50 equal weight 50')."""
    ta, tb = set(a.split()), set(b.split())
    if not ta or not tb or {t for t in ta if t.isdigit()} != {t for t in tb if t.isdigit()}:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def closest(key: str, candidates, threshold: float) -> str | None:
    """The candidate key closest to `key`, if close enough and clearly ahead of the next."""
    if key in candidates:
        return key
    best = second = 0.0
    best_key = None
    for cand in candidates:
        score = similarity(key, cand)
        if score > best:
            best, second, best_key = score, best, cand
        elif score > second:
            second = score
    return best_key if best >= threshold and best - second >= 0.05 else None


def indian_number(value: float) -> str:
    """12345678 -> '1,23,45,678'."""
    digits = str(int(round(abs(value))))
    head, tail = digits[:-3], digits[-3:]
    groups = []
    while len(head) > 2:
        groups.insert(0, head[-2:])
        head = head[:-2]
    if head:
        groups.insert(0, head)
    return ("-" if value < 0 else "") + ",".join(groups + [tail])


def crore(value: float) -> str:
    return f"₹{indian_number(value)} crore"


def _gap(td: float, period: str) -> str:
    if td < 0:
        return f"trailed the index by {abs(td):.2f}% {period}"
    if td > 0:
        return f"was ahead of the index by {td:.2f}% {period}"
    return f"matched the index {period}"


# ── Small caches for repeated local runs ────────────────────────

class DiskCache:
    """JSON files under the pipeline cache folder, reused while fresh (local re-runs)."""

    def __init__(self, root: str | None, hours: float = CACHE_HOURS) -> None:
        self.root = root
        self.max_age = hours * 3600

    def _path(self, name: str) -> str | None:
        return os.path.join(self.root, "mf", name + ".json") if self.root else None

    def get(self, name: str):
        path = self._path(name)
        if not path or not os.path.exists(path) or time.time() - os.path.getmtime(path) > self.max_age:
            return None
        try:
            with open(path, encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return None

    def put(self, name: str, value) -> None:
        path = self._path(name)
        if not path:
            return
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(value, fh)


def _history(mfapi, code: int, cache: DiskCache) -> list[tuple[datetime.date, float]]:
    cached = cache.get(f"nav-{code}")
    if cached is not None:
        return [(datetime.date.fromisoformat(d), v) for d, v in cached]
    history = mfapi.history(code)
    cache.put(f"nav-{code}", [[d.isoformat(), v] for d, v in history])
    return history


# ── Joining AMFI's sources ──────────────────────────────────────

def _is_index_fund(record: dict) -> bool:
    name = (record.get("schemeName") or "").lower()
    if record.get("navDirect") is None:  # ETFs have no direct plan
        return False
    return not re.search(r"\betf\b|exchange traded|fund of fund|\bfof\b|elss|tax saver", name)


class SchemeIndex:
    """Direct-plan growth schemes from NAVAll.txt, looked up by name."""

    def __init__(self, schemes: list[dict]) -> None:
        self.by_key: dict[str, list[dict]] = {}
        self.unlabelled: dict[str, list[dict]] = {}
        for s in schemes:
            cat = s["category"].lower()
            if not s["nav"] or ("equity" not in cat and "index" not in cat):
                continue
            if s["direct"] and s["growth"]:
                self.by_key.setdefault(name_key(s["name"]), []).append(s)
            elif not s.get("labelled", True) and not re.search(r"regular", f"{s['plan']} {s['name']}", re.I):
                self.unlabelled.setdefault(name_key(s["name"]), []).append(s)

    def find(self, name: str, nav: float | None) -> dict | None:
        key = closest(name_key(name), self.by_key, 0.8)
        if key:
            cands = self.by_key[key]
            if len(cands) > 1 and nav:
                # Some schemes list several direct growth codes under one name: the one
                # whose NAV matches AMFI's performance data is the main one.
                return min(cands, key=lambda s: abs(s["nav"] / nav - 1.0))
            return min(cands, key=lambda s: s["code"])
        # A row that does not say its plan or option is used only when its NAV matches
        # the direct plan's NAV in AMFI's performance data.
        key = closest(name_key(name), self.unlabelled, 0.8) if nav else None
        if key:
            best = min(self.unlabelled[key], key=lambda s: abs(s["nav"] / nav - 1.0))
            if abs(best["nav"] / nav - 1.0) < 0.05:
                return best
        return None


class NameLookup:
    """Rows keyed by normalised scheme name with a close-match fallback."""

    def __init__(self, rows: list[dict], name_field: str, *, skip_etfs: bool = False) -> None:
        self.rows: dict[str, dict] = {}
        for row in rows:
            key = name_key(row.get(name_field) or "")
            if not key or (skip_etfs and re.search(r"\betf\b|exchange traded", key)):
                continue
            self.rows.setdefault(key, row)

    def find(self, name: str, threshold: float = 0.8) -> dict | None:
        key = closest(name_key(name), self.rows, threshold)
        return self.rows.get(key) if key else None


PERIODS = (("1y", "1Year"), ("3y", "3Year"), ("5y", "5Year"), ("10y", "10Year"))
MAX_REGROUP_GAP = 1.5


def index_group_by_name(name: str) -> Group | None:
    """The index group whose index the fund's name ends with ('Kotak Nifty 100 Low
    Volatility 30' is Low Vol 30, not Nifty 100). The phrase must close the name, so
    'Nifty 500 Momentum 50' or 'Nifty50 Value 20' match no group."""
    tokens = name_key(name).split()
    best = None
    for g in INDEX_GROUPS:
        need = g.benchmark.split()
        if tokens[-len(need):] == need and (best is None or len(need) > len(best.benchmark.split())):
            best = g
    return best


def assign_index_records(records: list[dict]) -> tuple[dict[str, list[tuple[dict, str | None]]], list[str]]:
    """({group key: [(record, AMFI's benchmark label when the fund was regrouped)]}, names left out).

    AMFI's benchmark field is occasionally wrong (a Nifty 50 fund labelled Nifty 500, a
    Smallcap 250 fund labelled Smallcap 50). When the name ends with a different index of
    ours, the fund moves there, but only if its 1-year return is within
    MAX_REGROUP_GAP points of that index's: names and returns must agree."""
    by_benchmark = {g.benchmark: g for g in INDEX_GROUPS}
    out: dict[str, list[tuple[dict, str | None]]] = {g.key: [] for g in INDEX_GROUPS}
    pending = []
    for record in records:
        labelled = by_benchmark.get(benchmark_key(record.get("benchmark")))
        named = index_group_by_name(record.get("schemeName") or "")
        if labelled and (named is None or named.key == labelled.key):
            out[labelled.key].append((record, None))
        elif named:
            pending.append((record, named))
    references = {key: index_reference(entries) for key, entries in out.items()}
    skipped = []
    for record, named in pending:
        own, index = record.get("return1YearDirect"), references[named.key].get("1y")
        if isinstance(own, (int, float)) and index is not None and abs(own - index) > MAX_REGROUP_GAP:
            skipped.append(record.get("schemeName") or "")
            continue
        out[named.key].append((record, (record.get("benchmark") or "").strip() or "none"))
    return out, skipped


def index_reference(entries: list[tuple[dict, str | None]]) -> dict[str, float | None]:
    """The index's total return per period: the median of what the group's funds report
    (fund houses occasionally report a different figure; funds regrouped by name are left out)."""
    ref: dict[str, float | None] = {}
    for period, field in PERIODS:
        values = [r.get(f"return{field}Benchmark") for r, moved in entries if not moved]
        ref[period] = ms.median(v for v in values if isinstance(v, (int, float)))
    return ref


# ── Scoring ─────────────────────────────────────────────────────

def _mean(values) -> float | None:
    clean = [v for v in values if v is not None]
    return sum(clean) / len(clean) if clean else None


def _gap_score(td: float | None) -> float | None:
    """Tracking scores the size of the gap to the index, whichever side it falls."""
    return ms.tracking_score(-abs(td)) if td is not None else None


def score_index(funds: list[dict]) -> None:
    """Fixed-scale scores for index funds with at least a 1-year return.

    Tracking averages the 1- and 3-year gap scores. A fund with only a 1-year record is
    pulled halfway toward the group's typical 1-year score: one year can flatter by luck."""
    typical = ms.median(_gap_score((f.get("tracking_difference") or {}).get("1y"))
                        for f in funds if f["status"] == "ranked")
    for f in funds:
        td = f.get("tracking_difference") or {}
        one, three = _gap_score(td.get("1y")), _gap_score(td.get("3y"))
        if one is not None and three is not None:
            tracking = (one + three) / 2
        elif one is not None:
            tracking = (one + typical) / 2 if typical is not None else one
        else:
            tracking = three
        components = {"tracking": tracking, "steadiness": ms.steadiness_score(f.get("tracking_error")),
                      "cost": ms.cost_score(f.get("ter")), "size": ms.size_score(f.get("aum_cr"))}
        f["components"] = {k: rnd(v, 1) for k, v in components.items()}
        if f["status"] == "ranked":
            score, _ = ms.weighted_score(components, ms.INDEX_WEIGHTS)
            f["score"] = rnd(score, 1)


def score_active(funds: list[dict]) -> dict[int, tuple[float | None, dict]]:
    """Percentile scores within a category: {code: (score, components)}."""
    pct = ms.percentile_scores
    r3 = pct({f["code"]: f["returns"].get("3y") for f in funds})
    r5 = pct({f["code"]: f["returns"].get("5y") for f in funds})
    risk_adjusted = pct({f["code"]: f.get("return_per_risk") for f in funds})
    downside = pct({f["code"]: f.get("max_drawdown") for f in funds})
    cost = pct({f["code"]: f.get("ter") for f in funds}, higher_is_better=False)
    out = {}
    for f in funds:
        c = f.get("consistency") or {}
        components = {
            "consistency": c.get("pct"),
            "returns": _mean([r3.get(f["code"]), r5.get(f["code"])]),
            "risk_adjusted": risk_adjusted.get(f["code"]),
            "downside": downside.get(f["code"]),
            "cost": cost.get(f["code"]),
        }
        score, _ = ms.weighted_score(components, ms.ACTIVE_WEIGHTS)
        out[f["code"]] = (score, components)
    return out


def _rank(funds: list[dict], tiebreak) -> list[dict]:
    ranked = sorted((f for f in funds if f["status"] == "ranked" and f.get("score") is not None),
                    key=lambda f: (-f["score"], tiebreak(f), f["name"]))
    for i, f in enumerate(ranked, 1):
        f["rank"] = i
    others = sorted((f for f in funds if f.get("rank") is None), key=lambda f: f["name"])
    for f in others:
        if f["status"] == "ranked":
            f["status"], f["status_reason"] = "no_score", "Not enough data to score."
    return ranked + others


# ── Building the groups ─────────────────────────────────────────

def _base_fund(group: Group, record: dict, scheme: dict, as_of: datetime.date) -> dict:
    def returns(suffix: str) -> dict:
        return {p: rnd(record.get(f"return{k}{suffix}")) for p, k in PERIODS}
    return {
        "code": scheme["code"], "name": (record.get("schemeName") or scheme["name"]).strip(),
        "amc": amc_label(scheme["amc"]), "isin": scheme.get("isin"),
        "rank": None, "score": None, "status": "ranked", "status_reason": None,
        "benchmark": (record.get("benchmark") or "").strip() or None,
        "riskometer": record.get("riskometerScheme"),
        "aum_cr": rnd(record.get("dailyAUM"), 1),
        "nav": rnd(record.get("navDirect"), 4), "nav_date": as_of.isoformat(),
        "returns": returns("Direct"), "benchmark_returns": returns("Benchmark"),
        "ter": None, "ter_date": None, "since": None, "years": None,
        "components": {}, "reasons": [], "notes": [],
    }


def _index_tracking(f: dict, record: dict, reference: dict) -> None:
    """Tracking difference from AMFI's return data: the fund's return minus the index's total
    return over the same period (annualised for 3, 5 and 10 years), against the group's
    reference index return. AMFI's monthly tracking-difference disclosure is not used: fund
    houses report it with different signs."""
    f["benchmark_returns"] = {p: rnd(v) for p, v in reference.items()}
    td = {}
    for period, field in PERIODS:
        value, index = record.get(f"return{field}Direct"), reference.get(period)
        td[period] = rnd(value - index) if isinstance(value, (int, float)) and index is not None else None
    f["tracking_difference"] = td


def _apply_history(f: dict, series: ms.NavSeries | None, as_of: datetime.date) -> None:
    if series is None or not len(series):
        f["status"], f["status_reason"] = "no_history", "NAV history unavailable."
        return
    f["since"] = series.start.isoformat()
    f["years"] = rnd((as_of - series.start).days / 365.25, 1)
    if series.on(as_of, STALE_NAV_DAYS) is None:
        f["status"], f["status_reason"] = "stale", "No NAV published in the last 10 days."


def _active_metrics(f: dict, series: ms.NavSeries, as_of: datetime.date) -> dict:
    """Rolling windows and risk numbers for one fund (windows are returned, not published)."""
    windows = ms.rolling_cagrs(series, ms.rolling_ends(as_of))
    f["volatility"] = rnd(ms.annual_volatility(series, ms.rolling_ends(as_of, ms.ROLLING_LOOKBACK_MONTHS + 1)))
    f["max_drawdown"] = rnd(ms.max_drawdown(series, ms.years_before(as_of, 5), as_of))
    for period, years in (("3y", 3), ("5y", 5)):
        if f["returns"].get(period) is None:
            f["returns"][period] = rnd(ms.trailing_cagr(series, as_of, years))
    r5, vol = f["returns"].get("5y"), f.get("volatility")
    f["return_per_risk"] = rnd(r5 / vol) if r5 is not None and vol else None
    return windows


def _active_status(f: dict, windows: dict) -> None:
    if f["status"] != "ranked":
        return
    if (f.get("years") or 0) < MIN_ACTIVE_YEARS - 0.05 or len(windows) < ms.MIN_ROLLING_WINDOWS:
        f["status"] = "too_new"
        f["status_reason"] = (f"Direct plan has {f.get('years') or 0:.1f} years of history; the comparison "
                              f"needs {MIN_ACTIVE_YEARS} (for rolling 3-year returns).")
    elif f.get("volatility") is None or f["returns"].get("5y") is None:
        f["status"], f["status_reason"] = "no_score", "Not enough NAV history to measure risk."


def _median_of(funds: list[dict], getter) -> float | None:
    return ms.median(getter(f) for f in funds)


def _index_reasons(f: dict, stats: dict) -> None:
    td = f.get("tracking_difference") or {}
    parts = [(td[p], label) for p, label in (("3y", "a year over 3 years"), ("1y", "over the last year"))
             if td.get(p) is not None]
    if parts:
        (first, first_label), rest = parts[0], parts[1:]
        text = _gap(first, first_label)
        for value, label in rest:
            same_way = value != 0 and (value < 0) == (first < 0)
            text += f" and {abs(value):.2f}% {label}" if same_way else f"; it {_gap(value, label)}"
        typical = stats.get("median_gap_3y") if td.get("3y") is not None else stats.get("median_gap_1y")
        if typical is not None:
            text += f", against a typical gap of {typical:.2f}% in this group"
        f["reasons"].append(text[0].upper() + text[1:] + ".")
    if f.get("tracking_error") is not None:
        f["reasons"].append(f"Tracking error {f['tracking_error']:.2f}%: how far its daily returns stray from "
                            f"the index (median {stats.get('median_te') or 0:.2f}%).")
    if f.get("ter") is not None:
        f["reasons"].append(f"Expense ratio {f['ter']:.2f}% a year (median {stats.get('median_ter') or 0:.2f}%).")
    if f.get("aum_cr"):
        f["reasons"].append(f"Manages {crore(f['aum_cr'])}.")
    if td.get("3y") is None and td.get("1y") is not None:
        f["notes"].append("One year of record: its tracking score is pulled halfway toward the group's "
                          "typical fund until it has three.")


def _active_reasons(f: dict, stats: dict) -> None:
    c = f.get("consistency") or {}
    if c.get("of"):
        f["reasons"].append(f"Beat the category median in {c['beat']} of {c['of']} rolling 3-year periods "
                            f"({c['pct']:.0f}%).")
    for period, label in (("5y", "5-year"), ("3y", "3-year")):
        value, median = f["returns"].get(period), stats.get(f"median_return_{period}")
        if value is not None and median is not None:
            f["reasons"].append(f"{label} return {value:.1f}% a year; the median fund {median:.1f}%.")
            break
    if f.get("max_drawdown") is not None and stats.get("median_drawdown") is not None:
        span = ("in the last 5 years" if (f.get("years") or 0) >= MIN_ACTIVE_YEARS - 0.05
                else f"since its direct plan began {f.get('years') or 0:.1f} years ago")
        f["reasons"].append(f"Worst fall from a peak {span}: {abs(f['max_drawdown']):.1f}%; the median fund "
                            f"fell {abs(stats['median_drawdown']):.1f}% at worst in 5 years.")
    if f.get("return_per_risk") is not None and stats.get("median_return_per_risk") is not None:
        f["reasons"].append(f"Return per unit of risk {f['return_per_risk']:.2f} (median "
                            f"{stats['median_return_per_risk']:.2f}): 5-year return divided by volatility "
                            f"({f['volatility']:.1f}%).")
    if f.get("ter") is not None and stats.get("median_ter") is not None:
        f["reasons"].append(f"Expense ratio {f['ter']:.2f}% a year (median {stats['median_ter']:.2f}%).")
    fund5, bench5 = f["returns"].get("5y"), f["benchmark_returns"].get("5y")
    if fund5 is not None and bench5 is not None and f.get("benchmark"):
        gap = fund5 - bench5
        verb = "Beat" if gap > 0 else "Trailed"
        f["reasons"].append(f"{verb} its benchmark ({f['benchmark']}) by {abs(gap):.1f}% a year over 5 years.")


def _common_notes(f: dict, kind: str) -> None:
    if f.get("aum_cr") is not None and f["aum_cr"] < SMALL_FUND_CRORE[kind]:
        f["notes"].append(f"Small fund: {crore(f['aum_cr'])} in assets.")
    if f.get("ter") is None:
        f["notes"].append("Expense ratio could not be downloaded from AMFI this time; scored without it."
                          if f.get("ter_failed") else "Expense ratio not found in AMFI's data; scored without it.")


def build_index_group(group: Group, funds: list[dict], reference: dict | None = None) -> dict:
    for f in funds:
        if f["status"] != "ranked":
            continue
        td = f.get("tracking_difference") or {}
        if td.get("1y") is None and td.get("3y") is None:
            young = (f.get("years") or 0) < 1.0
            f["status"] = "too_new" if young else "no_tracking"
            f["status_reason"] = ("Less than a year old: the comparison starts once AMFI publishes a 1-year return."
                                  if young else "AMFI has not published a 1-year return for this fund.")
    score_index(funds)
    ranked = [f for f in funds if f["status"] == "ranked"]

    def td(f, period):
        return (f.get("tracking_difference") or {}).get(period)

    stats = {
        "funds": len(funds), "ranked": len(ranked),
        "index_return": {p: rnd(v) for p, v in (reference or {}).items()},
        "median_td_1y": rnd(_median_of(ranked, lambda f: td(f, "1y"))),
        "median_td_3y": rnd(_median_of(ranked, lambda f: td(f, "3y"))),
        "median_gap_1y": rnd(_median_of(ranked, lambda f: abs(td(f, "1y")) if td(f, "1y") is not None else None)),
        "median_gap_3y": rnd(_median_of(ranked, lambda f: abs(td(f, "3y")) if td(f, "3y") is not None else None)),
        "median_te": rnd(_median_of(ranked, lambda f: f.get("tracking_error"))),
        "median_ter": rnd(_median_of(ranked, lambda f: f.get("ter"))),
    }
    for f in funds:
        _index_reasons(f, stats)
        _common_notes(f, "index")
    ordered = _rank(funds, lambda f: (-(f["components"].get("tracking") or 0), f.get("ter") or 9))
    return {"stats": stats, "funds": ordered}


def build_active_group(group: Group, funds: list[dict], windows: dict[int, dict],
                       proxy: dict | None, proxy_windows: dict | None) -> dict:
    medians = ms.window_medians({str(code): w for code, w in windows.items()})
    for f in funds:
        beat, of = ms.consistency(windows.get(f["code"], {}), medians)
        f["consistency"] = {"beat": beat, "of": of, "pct": rnd(beat / of * 100, 1) if of else None}
        _active_status(f, windows.get(f["code"], {}))
    ranked = [f for f in funds if f["status"] == "ranked"]
    for code, (score, components) in score_active(ranked).items():
        f = next(x for x in ranked if x["code"] == code)
        f["score"] = rnd(score, 1)
        f["components"] = {k: rnd(v, 1) for k, v in components.items()}
    stats = {
        "funds": len(funds), "ranked": len(ranked), "windows": len(medians),
        "median_return_3y": rnd(_median_of(ranked, lambda f: f["returns"].get("3y"))),
        "median_return_5y": rnd(_median_of(ranked, lambda f: f["returns"].get("5y"))),
        "median_drawdown": rnd(_median_of(ranked, lambda f: f.get("max_drawdown"))),
        "median_volatility": rnd(_median_of(ranked, lambda f: f.get("volatility"))),
        "median_return_per_risk": rnd(_median_of(ranked, lambda f: f.get("return_per_risk"))),
        "median_ter": rnd(_median_of(ranked, lambda f: f.get("ter"))),
    }
    for period in ("3y", "5y"):
        pairs = [(f["returns"].get(period), f["benchmark_returns"].get(period)) for f in funds]
        pairs = [(a, b) for a, b in pairs if a is not None and b is not None]
        stats[f"beat_benchmark_{period}"] = {"beat": sum(1 for a, b in pairs if a > b), "of": len(pairs)}
    for f in funds:
        _active_reasons(f, stats)
        _common_notes(f, "active")
    ordered = _rank(funds, lambda f: -((f.get("consistency") or {}).get("pct") or 0))
    return {"stats": stats, "funds": ordered,
            "index_check": _index_check(ranked, medians, proxy, proxy_windows)}


def _index_check(ranked: list[dict], medians: dict, proxy: dict | None, proxy_windows: dict | None) -> dict | None:
    """Where a low-cost index fund would rank in an active category on the same rules."""
    if not proxy or not proxy_windows or not ranked:
        return None
    beat, of = ms.consistency(proxy_windows, medians)
    if of < ms.MIN_ROLLING_WINDOWS:
        return None
    candidate = {**proxy, "code": -1, "consistency": {"beat": beat, "of": of, "pct": beat / of * 100}}
    scores = score_active(ranked + [candidate])
    score = scores[-1][0]
    if score is None:
        return None
    better = sum(1 for f in ranked if (scores[f["code"]][0] or 0) > score)
    return {"code": proxy["code"], "name": proxy["name"], "group": proxy["group"],
            "would_rank": better + 1, "of": len(ranked) + 1, "score": rnd(score, 1),
            "consistency": {"beat": beat, "of": of, "pct": rnd(beat / of * 100, 1)},
            "return_5y": proxy["returns"].get("5y"), "max_drawdown": proxy.get("max_drawdown"),
            "ter": proxy.get("ter")}


# ── The snapshot ────────────────────────────────────────────────

def build(amfi, mfapi, nse, log: Logger | None = None, *, previous: dict | None = None,
          today: datetime.date | None = None, limit: int | None = None,
          cache_dir: str | None = None) -> dict:
    log = log or Logger(MARKET)
    started = now_ist()
    today = today or started.date()
    cache = DiskCache(cache_dir)
    errors: list[dict] = []

    schemes = amfi.nav_all()
    scheme_index = SchemeIndex(schemes)
    nav_date = max(s["date"] for s in schemes if s["date"] and s["direct"])
    as_of = amfi.performance_date(min(nav_date, today))
    log.info(f"{len(schemes)} open-ended schemes; performance and NAVs as of {as_of}")

    # Fund lists per group from AMFI's performance data (benchmarks, returns, AUM).
    # Index groups hold (record, AMFI benchmark label when the fund's name says otherwise).
    records: dict[str, list[tuple[dict, str | None]]] = {}
    failed_groups = 0
    try:
        index_records = [r for r in amfi.performance(OTHER, INDEX_FUNDS_AND_ETFS, as_of) if _is_index_fund(r)]
    except MfDataError as exc:
        index_records = []
        failed_groups += len(INDEX_GROUPS)
        errors.append({"source": "AMFI fund performance (index funds)", "error": str(exc)[:200]})
    index_groups, skipped = assign_index_records(index_records)
    records.update(index_groups)
    if skipped:
        log.warning(f"left out {len(skipped)} index funds whose name and returns point to different "
                    f"indices: {', '.join(skipped[:6])}")
    references = {g.key: index_reference(records[g.key]) for g in INDEX_GROUPS}
    for g in ACTIVE_GROUPS:
        try:
            records[g.key] = [(r, None) for r in amfi.performance(EQUITY, g.subcategory, as_of)
                              if r.get("navDirect") is not None]
        except MfDataError as exc:
            records[g.key] = []
            failed_groups += 1
            errors.append({"source": f"AMFI fund performance ({g.label})", "error": str(exc)[:200]})
    if failed_groups > MAX_GROUP_FAILURE_SHARE * len(GROUPS):
        raise SnapshotError(f"AMFI fund performance failed for {failed_groups} of {len(GROUPS)} groups")

    funds_by_group: dict[str, list[dict]] = {}
    unmatched = []
    for g in GROUPS:
        rows = records[g.key][:limit] if limit else records[g.key]
        benchmark_names = Counter((r.get("benchmark") or "").strip() for r, moved in rows if not moved)
        funds = []
        seen = set()
        for rec, moved_from in rows:
            scheme = scheme_index.find(rec.get("schemeName") or "", rec.get("navDirect"))
            if not scheme:
                unmatched.append(rec.get("schemeName"))
                continue
            if scheme["code"] in seen:
                continue
            seen.add(scheme["code"])
            fund = {**_base_fund(g, rec, scheme, as_of), "group": g.key}
            if g.kind == "index":
                _index_tracking(fund, rec, references[g.key])
                if moved_from:
                    fund["benchmark"] = benchmark_names.most_common(1)[0][0] if benchmark_names else None
                    fund["notes"].append("Grouped by its name: AMFI's data lists "
                                         + (f"its benchmark as {moved_from}." if moved_from != "none"
                                            else "no benchmark."))
            funds.append(fund)
        funds_by_group[g.key] = funds
    if unmatched:
        log.warning(f"{len(unmatched)} funds not found in NAVAll.txt: {', '.join(map(str, unmatched[:8]))}")
    all_funds = [f for funds in funds_by_group.values() for f in funds]
    log.info(f"{len(all_funds)} funds in {sum(1 for v in funds_by_group.values() if v)} groups")

    _attach_ter(amfi, all_funds, schemes, today, cache, errors, log, previous)
    _attach_tracking_error(amfi, funds_by_group, today, errors, log)

    # NAV histories (rolling returns, volatility, falls; fund age).
    series_by_code: dict[int, ms.NavSeries] = {}
    failures = 0
    for i, f in enumerate(all_funds, 1):
        try:
            series_by_code[f["code"]] = ms.NavSeries(_history(mfapi, f["code"], cache))
        except MfDataError as exc:
            failures += 1
            log.warning(f"{f['name']}: {exc}")
        if i % 50 == 0:
            log.info(f"NAV histories {i}/{len(all_funds)}")
    if all_funds and failures > MAX_HISTORY_FAILURE_SHARE * len(all_funds):
        raise SnapshotError(f"NAV history failed for {failures} of {len(all_funds)} funds")
    if failures:
        errors.append({"source": "mfapi.in NAV history", "error": f"{failures} funds without history"})

    for f in all_funds:
        _apply_history(f, series_by_code.get(f["code"]), as_of)

    groups_out = []
    index_results: dict[str, dict] = {}
    for g in INDEX_GROUPS:
        if not funds_by_group[g.key]:
            continue
        result = build_index_group(g, funds_by_group[g.key], references[g.key])
        index_results[g.key] = result
        groups_out.append(_group_json(g, result))

    for g in ACTIVE_GROUPS:
        funds = funds_by_group[g.key]
        if not funds:
            continue
        windows = {}
        for f in funds:
            series = series_by_code.get(f["code"])
            if series is not None and len(series) and f["status"] == "ranked":
                windows[f["code"]] = _active_metrics(f, series, as_of)
        proxy, proxy_windows = _proxy(index_results.get(g.compare_with), series_by_code, as_of)
        groups_out.append(_group_json(g, build_active_group(g, funds, windows, proxy, proxy_windows)))

    valuation, valuation_errors = mf_valuation.build(nse, previous, today, log)
    errors += valuation_errors

    ranked = sum(g["stats"]["ranked"] for g in groups_out)
    if not limit and ranked < MIN_RANKED:
        raise SnapshotError(f"only {ranked} funds could be ranked")
    amcs = {f["amc"] for f in all_funds}
    return {
        "schema": SCHEMA_VERSION,
        "market": MARKET,
        "title": TITLE,
        "currency": "INR",
        "generated_at": iso(now_ist()),
        "started_at": iso(started),
        "data_through": as_of.isoformat(),
        "data_source": {
            "funds": "AMFI fund performance and NAVAll (direct plans, growth option)",
            "nav_history": "AMFI NAV history via mfapi.in",
            "expense_ratio": "AMFI total expense ratios",
            "tracking": "AMFI returns (tracking difference) and AMFI tracking error",
            "valuation": valuation["source"],
        },
        "as_of": {
            "performance": as_of.isoformat(),
            "expense_ratio": max((f["ter_date"] for f in all_funds if f.get("ter_date")), default=None),
            "tracking_error": max((f.get("tracking_error_as_of") or "" for f in all_funds), default="") or None,
            "valuation": valuation.get("as_of"),
        },
        "partial": bool(limit),
        "model": {"index_weights": ms.INDEX_WEIGHTS, "active_weights": ms.ACTIVE_WEIGHTS,
                  "rolling_years": ms.ROLLING_YEARS, "lookback_months": ms.ROLLING_LOOKBACK_MONTHS,
                  "min_windows": ms.MIN_ROLLING_WINDOWS, "min_active_years": MIN_ACTIVE_YEARS,
                  "small_fund_crore": SMALL_FUND_CRORE},
        "stats": {"funds": len(all_funds), "ranked": ranked, "groups": len(groups_out), "amcs": len(amcs),
                  "errors": len(errors),
                  "without_ter": sum(1 for f in all_funds if f.get("ter") is None)},
        "groups": groups_out,
        "valuation": valuation,
        "errors": errors,
    }


def _group_json(g: Group, result: dict) -> dict:
    benchmarks = Counter(f["benchmark"] for f in result["funds"] if f.get("benchmark"))
    out = {"key": g.key, "kind": g.kind, "label": g.label, "short": g.short, "about": g.about,
           "benchmark": benchmarks.most_common(1)[0][0] if benchmarks else None,
           "valuation": g.valuation, "compare_with": g.compare_with,
           "stats": result["stats"], "funds": result["funds"]}
    if g.kind == "active":
        out["index_check"] = result.get("index_check")
    return out


def _proxy(index_result: dict | None, series_by_code: dict, as_of: datetime.date):
    """The index fund used for an active category's index check: the best-ranked fund of the
    matching index group with five years of history (else its oldest fund)."""
    if not index_result:
        return None, None
    old_enough = [f for f in index_result["funds"] if (f.get("years") or 0) >= MIN_ACTIVE_YEARS
                  and series_by_code.get(f["code"]) is not None]
    if not old_enough:
        return None, None
    ranked = [f for f in old_enough if f.get("rank")]
    pick = min(ranked, key=lambda f: f["rank"]) if ranked else max(old_enough, key=lambda f: f["years"])
    proxy = {k: (dict(v) if isinstance(v, dict) else v) for k, v in pick.items()}
    windows = _active_metrics(proxy, series_by_code[pick["code"]], as_of)
    if proxy.get("volatility") is None or proxy["returns"].get("5y") is None:
        return None, None
    return proxy, windows


def _attach_ter(amfi, funds: list[dict], schemes: list[dict], today: datetime.date, cache: DiskCache,
                errors: list[dict], log: Logger, previous: dict | None = None) -> None:
    """Latest direct-plan expense ratio of each fund, from its fund house's TER rows.

    When AMFI cannot be reached for a fund house, its funds keep the expense ratio of the
    previous snapshot (with its date) rather than being scored without one; a fund with
    neither is marked `ter_failed`."""
    before = {f["code"]: (f["ter"], f.get("ter_date")) for g in (previous or {}).get("groups") or []
              for f in g.get("funds") or [] if isinstance(f.get("ter"), (int, float))}
    unreached: list[dict] = []
    try:
        amcs = amfi.amcs()
    except MfDataError as exc:
        errors.append({"source": "AMFI expense ratios", "error": str(exc)[:200]})
        log.warning(f"TER fund-house list: {exc}")
        amcs, unreached = [], list(funds)
    by_amc_key = {amc_key(a["name"]): a for a in amcs}
    scheme_amc = {s["code"]: s["amc"] for s in schemes}
    wanted: dict[str, list[dict]] = {}
    for f in funds if amcs else []:
        key = closest(amc_key(scheme_amc.get(f["code"], "")), by_amc_key, 0.6)
        if key:
            wanted.setdefault(by_amc_key[key]["id"], []).append(f)
    failed = 0
    for n, (amc_id, members) in enumerate(sorted(wanted.items()), 1):
        name = f"ter-{amc_id}-{today:%Y-%m}"
        rows = cache.get(name)
        if rows is None:
            try:
                rows = amfi.latest_ter(amc_id, today)
            except MfDataError as exc:
                failed += 1
                unreached += members
                log.warning(f"TER for fund house {amc_id}: {exc}")
                continue
            cache.put(name, rows)
        lookup = NameLookup([r for r in rows if r.get("ter_direct")], "name")
        for f in members:
            row = lookup.find(f["name"], 0.7)
            if row:
                f["ter"], f["ter_date"] = rnd(row["ter_direct"]), row["date"]
        if n % 10 == 0:
            log.info(f"expense ratios: {n}/{len(wanted)} fund houses")
    reused = 0
    for f in unreached:
        if f["code"] in before:
            f["ter"], f["ter_date"] = before[f["code"]]
            reused += 1
        else:
            f["ter_failed"] = True
    if failed or unreached:
        errors.append({"source": "AMFI expense ratios",
                       "error": f"{failed} fund houses could not be reached; {reused} funds keep the "
                                f"previous expense ratio"})
    still = [f for f in funds if f.get("ter_failed")]
    if still and len(still) > MAX_HISTORY_FAILURE_SHARE * len(funds):
        raise SnapshotError(f"expense ratios unavailable for {len(still)} of {len(funds)} funds")
    missing = [f["name"] for f in funds if f.get("ter") is None]
    if missing:
        log.warning(f"{len(missing)} funds without an expense ratio: {', '.join(missing[:8])}")


def _attach_tracking_error(amfi, funds_by_group: dict[str, list[dict]], today: datetime.date,
                           errors: list[dict], log: Logger) -> None:
    """AMFI's daily tracking error of each index fund (its spread around the index)."""
    index_funds = [f for g in INDEX_GROUPS for f in funds_by_group.get(g.key, [])]
    for f in index_funds:
        f["tracking_error"], f["tracking_error_as_of"] = None, None
    if not index_funds:
        return
    try:
        rows = amfi.latest_tracking_error(today)
    except MfDataError as exc:
        errors.append({"source": "AMFI tracking error", "error": str(exc)[:200]})
        log.warning(f"tracking error: {exc}")
        return
    lookup = NameLookup(rows, "Scheme_Name", skip_etfs=True)
    for f in index_funds:
        row = lookup.find(f["name"])
        if row and isinstance(row.get("DirectPercent"), (int, float)):
            f["tracking_error"], f["tracking_error_as_of"] = rnd(row["DirectPercent"]), row.get("as_of")
    missing = [f["name"] for f in index_funds if f["tracking_error"] is None]
    if missing:
        log.info(f"{len(missing)} index funds without a tracking error: {', '.join(missing[:6])}")


# ── Publishing ──────────────────────────────────────────────────

def publish(out_dir: str, cache_dir: str | None, log: Logger | None = None, *, limit: int | None = None,
            amfi=None, mfapi=None, nse=None) -> dict:
    """Build and write site/data/mf.json; the previous file stays when the build fails."""
    from pipeline.publish import load_previous, write_snapshot

    log = log or Logger(MARKET)
    path = os.path.join(out_dir, f"{MARKET}.json")
    previous = load_previous(path)
    try:
        snap = build(amfi or Amfi(Logger("amfi")), mfapi or MfApi(Logger("mfapi")),
                     nse or NseIndices(Logger("nse")), log, previous=previous, limit=limit,
                     cache_dir=cache_dir)
        if (not limit and previous and previous.get("data_through")
                and snap["data_through"] < previous["data_through"]):
            raise SnapshotError(f"data through {snap['data_through']} is older than the published "
                                f"{previous['data_through']}")
    except (SnapshotError, MfDataError) as exc:
        log.error(f"not published: {exc}")
        return {"market": MARKET, "ok": False, "error": str(exc)}
    except Exception as exc:  # noqa: BLE001 — report and keep the previous file
        log.error(f"not published: {exc}\n{traceback.format_exc()}")
        return {"market": MARKET, "ok": False, "error": f"{type(exc).__name__}: {exc}"}
    write_snapshot(path, snap)
    stats = snap["stats"]
    log.info(f"wrote {path}: {stats['ranked']} of {stats['funds']} funds ranked in {stats['groups']} groups")
    problems = f" · {stats['errors']} data problem{'s' if stats['errors'] != 1 else ''} (see errors)" if stats["errors"] else ""
    return {"market": MARKET, "ok": True, "ranked": stats["ranked"], "data_through": snap["data_through"],
            "changes": f"{stats['funds']} funds in {stats['groups']} groups{problems}", "errors": stats["errors"]}
