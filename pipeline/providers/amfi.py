"""Mutual fund data: AMFI, mfapi.in and NSE's daily index file.

* NAVAll.txt (AMFI): every scheme with its SEBI category, fund house, plan,
  option and latest NAV. Its scheme codes key the NAV history.
* The JSON endpoints behind the AMFI website's pages (not a documented API):
  fund performance (returns against the benchmark, daily AUM, riskometer),
  total expense ratios (daily rows per fund house and month) and the daily
  tracking error of index funds. They are rate limited and a throttled call
  is often an HTTP 200 whose body is not JSON, so calls are spaced about a
  second apart and retried with backoff.
* mfapi.in: a free mirror of AMFI's NAV history, one scheme per request.
* NSE's daily index file: P/E, P/B and dividend yield of every NSE index.
"""

from __future__ import annotations

import csv
import datetime
import io
import math
import re
import time

import requests

from pipeline.log import Logger
from pipeline.providers.yahoo import USER_AGENT

AMFI = "https://www.amfiindia.com"
NAV_ALL_URL = AMFI + "/spages/NAVAll.txt"
PERFORMANCE_URL = AMFI + "/gateway/pollingsebi/api/amfi/fundperformance"
AMC_LIST_URL = AMFI + "/api/populate-mf"
TER_URL = AMFI + "/api/populate-te-rdata-revised"
TRACKING_ERROR_URL = AMFI + "/api/tracking-error-data"
MFAPI_URL = "https://api.mfapi.in/mf/{code}"
NSE_INDICES_URL = "https://archives.nseindia.com/content/indices/ind_close_all_{ddmmyyyy}.csv"

# AMFI fund-performance filters (open-ended schemes).
OPEN_ENDED = 1
EQUITY = 1
OTHER = 5
INDEX_FUNDS_AND_ETFS = 38

RETRYABLE_STATUS = {429, 500, 502, 503, 504}
MIN_NAV_ROWS = 1000


class MfDataError(RuntimeError):
    pass


def _num(value) -> float | None:
    try:
        f = float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


# ── Parsing (pure) ──────────────────────────────────────────────

_CATEGORY_LINE = re.compile(r"^(Open Ended|Close Ended|Interval Fund)\s+Schemes?\s*\((.*)\)\s*$", re.I)
_NOT_GROWTH = re.compile(r"idcw|dividend|bonus|payout|reinvest", re.I)
_GROWTH = re.compile(r"growth|cumulative", re.I)
_PLAN_WORDS = re.compile(r"direct|regular|growth|cumulative|idcw|dividend|bonus", re.I)


def parse_nav_all(text: str) -> list[dict]:
    """Open-ended schemes from AMFI's NAVAll.txt.

    The file interleaves a scheme-type line such as
    'Open Ended Schemes(Equity Scheme - Large Cap Fund)', a fund-house line
    ('Axis Mutual Fund') and `;`-separated scheme rows:
    code;ISIN;ISIN reinvestment;name;plan;option;NAV;date. Older rows leave
    plan and option empty and put them in the name instead; a few say neither,
    or give the plan but no option (`labelled` is then False). Some fund
    houses call the growth option 'Cumulative'.
    """
    out: list[dict] = []
    category = amc = None
    open_ended = False
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("Scheme Code"):
            continue
        if ";" not in line:
            match = _CATEGORY_LINE.match(line)
            if match:
                open_ended = match.group(1).lower() == "open ended"
                category = match.group(2).strip()
            else:
                amc = line
            continue
        parts = [p.strip() for p in line.split(";")]
        if not open_ended or len(parts) < 8 or not parts[0].isdigit():
            continue
        name, plan, option = parts[3], parts[4], parts[5]
        if plan or option:
            # A blank option (a scheme's only option) leaves growth unknown.
            labelled = bool(option) or bool(_PLAN_WORDS.search(name))
            direct = "direct" in plan.lower()
            growth = bool(_GROWTH.search(option)) and not _NOT_GROWTH.search(option)
        else:
            labelled = bool(_PLAN_WORDS.search(name))
            direct = bool(re.search(r"\bdirect\b", name, re.I))
            growth = bool(_GROWTH.search(name)) and not _NOT_GROWTH.search(name)
        try:
            day = datetime.datetime.strptime(parts[7], "%d-%b-%Y").date()
        except ValueError:
            day = None
        nav = _num(parts[6])
        out.append({"code": int(parts[0]), "isin": parts[1] if parts[1] not in ("", "-") else None,
                    "name": name, "plan": plan, "option": option, "labelled": labelled,
                    "direct": direct, "growth": growth,
                    "nav": nav if nav and nav > 0 else None, "date": day,
                    "amc": amc or "", "category": category or ""})
    return out


def parse_mfapi(payload: dict) -> list[tuple[datetime.date, float]]:
    """mfapi.in history -> [(date, nav)] oldest first, junk rows dropped."""
    by_day: dict[datetime.date, float] = {}
    for row in (payload or {}).get("data") or []:
        try:
            day = datetime.datetime.strptime(str(row.get("date")), "%d-%m-%Y").date()
        except ValueError:
            continue
        nav = _num(row.get("nav"))
        if nav and nav > 0:
            by_day[day] = nav
    return sorted(by_day.items())


def index_key(name: str) -> str:
    """'Nifty100 Equal Weight' and 'NIFTY 100 Equal Weight' -> 'nifty100equalweight'."""
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def parse_nse_indices(text: str) -> dict[str, dict]:
    """NSE's ind_close_all CSV -> {index_key: {name, date, close, pe, pb, dy}} (rows with a P/E)."""
    out: dict[str, dict] = {}
    for row in csv.DictReader(io.StringIO(text.lstrip("\ufeff"))):
        name = (row.get("Index Name") or "").strip()
        pe = _num(row.get("P/E"))
        if not name or not pe or pe <= 0:
            continue
        try:
            day = datetime.datetime.strptime((row.get("Index Date") or "").strip(), "%d-%m-%Y").date()
        except ValueError:
            continue
        close = _num(row.get("Closing Index Value") or row.get("Closing"))
        out[index_key(name)] = {"name": name, "date": day, "close": close, "pe": pe,
                                "pb": _num(row.get("P/B")), "dy": _num(row.get("Div Yield"))}
    return out


def latest_ter(rows: list[dict]) -> list[dict]:
    """AMFI daily TER rows -> the latest row of each scheme."""
    best: dict[str, dict] = {}
    for row in rows or []:
        name = (row.get("Scheme_Name") or "").strip()
        day = str(row.get("TER_Date") or "")[:10]
        if not name or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
            continue
        if name in best and best[name]["date"] >= day:
            continue
        direct = _num(row.get("D_TER"))
        regular = _num(row.get("R_TER"))
        best[name] = {"name": name, "category": (row.get("SchemeCat_Desc") or "").strip(), "date": day,
                      "ter_direct": direct if direct and direct > 0 else None,
                      "ter_regular": regular if regular and regular > 0 else None}
    return list(best.values())


def _records(payload) -> list[dict]:
    data = payload.get("data", payload) if isinstance(payload, dict) else payload
    return [r for r in data if isinstance(r, dict)] if isinstance(data, list) else []


# ── HTTP ────────────────────────────────────────────────────────

class Http:
    """A requests session with a minimum gap between calls and retries.

    A body that is not JSON when JSON was expected counts as throttling.
    """

    def __init__(self, log: Logger, *, min_interval: float = 0.0, retries: int = 5,
                 backoff: float = 2.0, timeout: float = 60.0, headers: dict | None = None) -> None:
        self.log = log
        self.min_interval = min_interval
        self.retries = retries
        self.backoff = backoff
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT,
                                     "Accept": "application/json, text/plain, */*",
                                     **(headers or {})})
        self._last = 0.0

    def _pace(self) -> None:
        gap = self.min_interval - (time.monotonic() - self._last)
        if gap > 0:
            time.sleep(gap)

    def request(self, method: str, url: str, *, as_json: bool = True, ok404: bool = False,
                min_bytes: int = 0, **kwargs):
        last_err = "no attempt made"
        for attempt in range(self.retries):
            self._pace()
            try:
                resp = self.session.request(method, url, timeout=self.timeout, **kwargs)
            except requests.RequestException as exc:
                last_err = f"{type(exc).__name__}: {exc}"
            else:
                if resp.status_code == 404 and ok404:
                    self._last = time.monotonic()
                    return None
                if resp.status_code in RETRYABLE_STATUS:
                    last_err = f"HTTP {resp.status_code}"
                elif resp.status_code >= 400:
                    self._last = time.monotonic()
                    raise MfDataError(f"{url}: HTTP {resp.status_code}")
                elif len(resp.content) < min_bytes:
                    last_err = f"short response ({len(resp.content)} bytes)"
                elif as_json:
                    try:
                        payload = resp.json()
                    except ValueError:
                        last_err = "response was not JSON (throttled)"
                    else:
                        self._last = time.monotonic()
                        return payload
                else:
                    self._last = time.monotonic()
                    return resp.content.decode("utf-8", errors="replace")
            self._last = time.monotonic()
            if attempt + 1 < self.retries:
                time.sleep(min(30.0, self.backoff * (2 ** attempt)))
        raise MfDataError(f"{url}: gave up after {self.retries} attempts ({last_err})")


def _month_start(day: datetime.date, back: int = 0) -> datetime.date:
    year, month = day.year, day.month - back
    while month < 1:
        year, month = year - 1, month + 12
    return datetime.date(year, month, 1)


# ── Clients ─────────────────────────────────────────────────────

class Amfi:
    """AMFI's NAV file and website endpoints."""

    def __init__(self, log: Logger | None = None, *, min_interval: float = 1.1, retries: int = 6) -> None:
        self.log = log or Logger("amfi")
        self.http = Http(self.log, min_interval=min_interval, retries=retries)

    def _get(self, url: str, params: dict, referer: str):
        return self.http.request("GET", url, params=params, headers={"Referer": AMFI + referer})

    def nav_all(self) -> list[dict]:
        text = self.http.request("GET", NAV_ALL_URL, as_json=False, min_bytes=100_000)
        rows = parse_nav_all(text)
        if len(rows) < MIN_NAV_ROWS:
            raise MfDataError(f"NAVAll.txt: only {len(rows)} open-ended schemes")
        return rows

    def performance(self, category: int, subcategory: int, report_date: datetime.date) -> list[dict]:
        body = {"maturityType": OPEN_ENDED, "category": category, "subCategory": subcategory,
                "mfid": 0, "reportDate": report_date.strftime("%d-%b-%Y")}
        payload = self.http.request("POST", PERFORMANCE_URL, json=body,
                                    headers={"Referer": AMFI + "/otherdata/fund-performance"})
        return _records(payload)

    def performance_date(self, latest: datetime.date, days_back: int = 10) -> datetime.date:
        """The most recent business day with fund-performance data (probed on large caps)."""
        for back in range(days_back):
            day = latest - datetime.timedelta(days=back)
            if day.weekday() < 5 and self.performance(EQUITY, 1, day):
                return day
        raise MfDataError(f"AMFI fund performance: no data in the {days_back} days to {latest}")

    def amcs(self) -> list[dict]:
        payload = self.http.request("GET", AMC_LIST_URL, headers={"Referer": AMFI + "/ter-of-mf-schemes"})
        return [{"id": str(r.get("mfId")), "name": (r.get("mfName") or "").strip()}
                for r in (payload if isinstance(payload, list) else []) if r.get("mfId")]

    def ter_month(self, amc_id: str, month: datetime.date) -> list[dict]:
        rows: list[dict] = []
        page = 1
        while True:
            payload = self._get(TER_URL, {"MF_ID": amc_id, "Month": month.strftime("%m-%Y"), "strCat": -1,
                                          "strType": 1, "page": page, "pageSize": 100}, "/ter-of-mf-schemes")
            batch = _records(payload)
            rows += batch
            pages = int(((payload or {}).get("meta") or {}).get("pageCount") or 0) if isinstance(payload, dict) else 0
            if not batch or page >= pages:
                return rows
            page += 1

    def latest_ter(self, amc_id: str, today: datetime.date) -> list[dict]:
        """Each scheme's latest TER: this month's rows, or last month's if none are posted yet."""
        rows = self.ter_month(amc_id, _month_start(today))
        if not rows:
            rows = self.ter_month(amc_id, _month_start(today, 1))
        return latest_ter(rows)

    def tracking_error(self, day: datetime.date) -> list[dict]:
        return _records(self._get(TRACKING_ERROR_URL, {"MF_ID": "all", "strdt": day.strftime("%d-%b-%Y").lower()},
                                  "/otherdata/tracking-error"))

    def latest_tracking_error(self, today: datetime.date, days_back: int = 12,
                              days_wanted: int = 3) -> list[dict]:
        """Each scheme's most recent tracking error from the last few days published (fund
        houses post on different days). Rows gain `as_of`."""
        merged: dict[str, dict] = {}
        found = 0
        for back in range(days_back):
            day = today - datetime.timedelta(days=back)
            if day.weekday() >= 5:
                continue
            rows = self.tracking_error(day)
            if not rows:
                continue
            for row in rows:
                name = (row.get("Scheme_Name") or "").strip()
                if name and name not in merged:
                    merged[name] = {**row, "as_of": day.isoformat()}
            found += 1
            if found >= days_wanted:
                break
        return list(merged.values())


class MfApi:
    """NAV history from mfapi.in."""

    def __init__(self, log: Logger | None = None, *, min_interval: float = 0.15) -> None:
        self.log = log or Logger("mfapi")
        self.http = Http(self.log, min_interval=min_interval, retries=4, backoff=1.5, timeout=45.0)

    def history(self, code: int) -> list[tuple[datetime.date, float]]:
        payload = self.http.request("GET", MFAPI_URL.format(code=int(code)))
        if isinstance(payload, dict) and payload.get("status") not in (None, "SUCCESS"):
            raise MfDataError(f"mfapi {code}: status {payload.get('status')}")
        return parse_mfapi(payload)


class NseIndices:
    """NSE's end-of-day file of every index (404 on holidays and before about 6 pm IST)."""

    def __init__(self, log: Logger | None = None, *, min_interval: float = 0.3) -> None:
        self.log = log or Logger("nse")
        self.http = Http(self.log, min_interval=min_interval, retries=3, backoff=5.0, timeout=45.0)

    def day(self, day: datetime.date) -> dict[str, dict] | None:
        text = self.http.request("GET", NSE_INDICES_URL.format(ddmmyyyy=day.strftime("%d%m%Y")),
                                 as_json=False, ok404=True, min_bytes=5000)
        if text is None:
            return None
        rows = parse_nse_indices(text)
        return rows or None

    def last_on_or_before(self, day: datetime.date, days_back: int = 7) -> dict[str, dict] | None:
        for back in range(days_back):
            d = day - datetime.timedelta(days=back)
            if d.weekday() >= 5:
                continue
            rows = self.day(d)
            if rows:
                return rows
        return None
