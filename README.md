# Rupevo

**Market rankings, fund comparisons and tax tools, explained.** Rupevo
publishes rules-based rankings of the **Indian Nifty 100** and of **US stocks**
(the NASDAQ-100 and the NYSE's 100 largest US companies), refreshed from
end-of-day prices, with every score broken down so readers can see *why* a
stock ranks where it does; a **comparison of direct-plan mutual funds** within
their group (which fund house's Nifty 50 fund, which mid-cap fund), with the
reasons; and step-by-step **tax tools** for Indian investors, starting with
foreign RSUs.

Live site: **https://yash040599.github.io/Rupevo/**

| Page | What it shows | Model |
|---|---|---|
| [Nifty 100 Ranking](site/india/index.html) | Technical setups, technical score (A–D), risk grade, 52-week dips, sector strength | Migrated from the ai-portfolio-manager swing scanner |
| [US Stock Ranking](site/us/index.html) | Six-pillar long-term scorecard (quality, valuation vs sector, growth, momentum, balance sheet, risk) for two lists: the **NASDAQ-100** and the **NYSE top 100** (the 100 largest US companies listed on the NYSE, e.g. Oracle, Uber, JPMorgan). A switch shows **All US** (both lists ranked together), **NASDAQ-100** or **NYSE top 100**; search covers the lists in view, and searching one exchange for a company on the other says where it is | Migrated from the ai-portfolio-manager US long-term scorer |
| [Mutual Fund Comparison](site/mf/index.html) | Every direct-plan equity fund ranked within its group: **14 index-fund groups** (Nifty 50, Sensex, Next 50, Nifty 100, Nifty 100 and Nifty 50 Equal Weight, LargeMidcap 250, Midcap 150, Smallcap 250, Nifty 500, Total Market, Momentum 30, Low Vol 30, Alpha Low-Vol 30) and **9 active categories** (large, large & mid, flexi, multi, mid, small cap, focused, value, ELSS). Each group opens with the top-ranked fund and *how we decided*; index groups show what the tracking gap is worth on a SIP, active groups where a low-cost index fund would rank on the same rules. Below: a **SIP split by age and risk** (by fund category) and a **lump-sum check** (each index's P/E against its own history) | `pipeline/mf.py` (see *The mutual fund comparison*) |
| [Tax tools](site/tax/index.html) | RSU taxation → broker (Fidelity) → company (**Microsoft, Oracle**). Load Fidelity's *View open lots* CSV (shares held) and, if you sold any, *View closed lots* (Previously held shares); the company page has three tabs: **Foreign assets** (Schedule FA Table A2 for the Fidelity account and A3 with one row per RSU vest and ESPP purchase, including lots sold during the year with their proceeds, plus the Schedule AL cost), **Selling shares** (capital gains under India's 24-month rule: Schedule CG A5/B8, gains by date of sale, and the Schedule FSI row) and **Dividends** (the payments the shares received in the financial year, Schedule OS with its quarterly breakup, Schedule FSI, Schedule TR and the Form 67 fields with its deadline, plus the company's dividend history). Sold shares change Schedule FA and the dividends too, so those tabs ask for both exports unless nothing was ever sold. Visitors can request another company. Every tax page has an interactive "how far through the financial year are we" slider (advance-tax and ITR dates marked) and a "Did you know?" card mixing tax facts with stories from market history | Runs in the browser: the user's files are never uploaded. Uses published SBI TT buying rates, closes and dividends (`site/data/tax/`, refreshed weekly) |

Every page has light/dark theme, a **Buy me a coffee** button (in the top
bar, a floating ☕ on phones once the bar scrolls away, and the footer) and a
disclaimer. Ranking pages and the fund comparison add a "last synced"
indicator, a **Request refresh** button and collapsible sections (the ranking
pages also a USD/INR toggle). No login is needed.

The home, ranking, fund and tax pages end with a **Did you know?** card: true stories
from market history (Indian and world: crashes, scams, bubbles, famous bets,
quick maths) with a takeaway for ordinary investors, mixed with tax facts on the
tax pages. Each page starts on a different story, the start moves on every day,
and ← / → step through the rest.

---

## How it works

```
               ┌──────────────── GitHub Actions: "Refresh market data" ──────────────────┐
 Schedule ─────►  python -m pipeline refresh → site/data/{india,us,us-nyse}.json → commit  │
 (daily/weekly)│      │  Yahoo Finance EOD prices + fundamentals                            │
 Admin ────────►      │  NSE / Nasdaq lists (NASDAQ-100; NYSE listings → NYSE top 100)      │
 (Analyse now, │      └─ scoring engine (pipeline/engine, migrated from the local tool)      │
  email link,  │  python -m pipeline mf → site/data/mf.json                                  │
  Actions tab  │      └─ AMFI (NAVs, returns, AUM, expense ratios, tracking error),          │
  or local)    │         mfapi.in (NAV history), NSE (index P/E)                             │
               └──────────────────────────────┬────────────────────────────────────────────┘
                                              ▼
                               "Deploy site" → GitHub Pages (static: site/)
                                              ▼
 Visitors ◄── HTML/CSS/JS renders the JSON snapshots; "Request refresh" → Web3Forms → email
```

* **`site/`** is a dependency-free static website (HTML, CSS, ES modules).
  It only reads `site/data/*.json`; there is no server.
* **`pipeline/`** is the Python job that builds those snapshots. The scoring
  engine is pure arithmetic copied from `ai-portfolio-manager`
  (indicators, swing signals, conviction/risk grading, US long-term
  scorecard) with no broker, config or AI dependencies.
* **Publishing is screener-style on purpose**: ranks, scores, grades and
  indicators only. Entry/stop/target levels and buy/sell wording are never
  published, and `tests/test_published_data.py` blocks any snapshot that
  contains them, the fund comparison included (see *Compliance notes*).
* **Mutual funds**: `python -m pipeline mf` writes `site/data/mf.json`
  (`pipeline/mf.py`, `mf_valuation.py`, `providers/amfi.py`,
  `engine/mf_scoring.py`); see *The mutual fund comparison* below.
* **Tax reference data**: `python -m pipeline tax-data` writes
  `site/data/tax/sbi-tt-buy-usd.json` (SBI telegraphic-transfer buying rates
  for USD since January 2020, from the MIT-licensed
  [sbi-fx-ratekeeper](https://github.com/sahilgupta/sbi-fx-ratekeeper) archive),
  `site/data/tax/msft.json` and `orcl.json` (10 years of Yahoo Finance daily
  closes plus dividends with declared/ex/record/pay dates: Nasdaq for
  Microsoft, and the feed behind Oracle's investor-relations dividend page for
  Oracle, since Nasdaq has no history for it; Yahoo ex-dates are the
  fallback). The tax tools fetch these files and read the user's broker exports
  in the browser (`assets/js/fidelity.js` parses them, `schedule-fa.js`,
  `dividends.js` and `capital-gains.js` do the maths). Nothing personal is
  uploaded or stored.

---

## Refreshing the data (admin)

Every successful refresh updates the **Last synced** time on its page.

**Automatic refreshes** ([.github/workflows/refresh-data.yml](.github/workflows/refresh-data.yml),
times in IST; GitHub can start scheduled runs a few minutes late):

| When | What | Why then |
|---|---|---|
| Tuesday to Saturday, 06:47 | Both stock rankings | After the US close, so each morning shows the previous session of both markets (Yahoo fills in NSE's daily bar late in the evening) |
| Saturday, 09:17 | Mutual fund comparison | Friday's NAVs and AMFI's returns are in; fund rankings move slowly, so weekly is enough |
| Monday, 08:00 | Tax data only | SBI rates, Microsoft and Oracle prices and dividends |

The tax data is also refreshed on every other run. A daily refresh adds about
170 KB to the repository (roughly 45 MB a year), which is fine for years; the
Actions minutes are free because the repository is public.

Visitors who need data sooner press **Request refresh**, which emails you.
To refresh by hand there are four ways:

1. **From the request email.** The email ends with a *Refresh now* link
   (the page with `?refresh=<market>`). Open it in a browser where admin mode
   is on and the page asks you to confirm, then runs and follows the refresh;
   anywhere else it first asks for your admin token (once per browser: tick
   *Remember on this device*, including on your phone). The link itself grants
   nothing, so only follow links that start with
   `https://yash040599.github.io/Rupevo/`: anyone can send you an email that
   looks like a request. The email also links the workflow on GitHub.
2. **"Analyse now" on the website.**
   Click **Admin** in the footer, paste a GitHub fine-grained token (see
   setup step 3) and the page switches "Request refresh" for **Analyse now**.
   It dispatches the workflow, follows the run live and reloads the page
   when the new data is deployed (about 3–6 minutes for the rankings, 10–20
   for the mutual funds). The admin panel also has *Refresh mutual funds*,
   *Refresh all* and recent-run history. Visitors never see the button,
   and GitHub rejects dispatches from anyone without write access.
3. **GitHub Actions tab / GitHub mobile app**: *Actions → Refresh market
   data → Run workflow*, pick `both` (both stock rankings), `india`, `us`
   (both US lists), `mf` (mutual funds), `all` (everything) or `tax`.
4. **From your PC**:
   ```powershell
   cd C:\Users\yashagrawal\AiPortfolioManager\Rupevo
   .\.venv\Scripts\python.exe -m pipeline refresh --market both
   .\.venv\Scripts\python.exe -m pipeline mf
   .\.venv\Scripts\python.exe -m pipeline tax-data
   git add site/data; git commit -m "data: refresh"; git push
   ```
   Pushing `site/` triggers the deploy automatically.

If a list fails (for example Yahoo throttling), its previous snapshot
stays live, the other lists still publish, and the run is marked failed
with the reason in the job summary. A list is never published when more
than 20% of its stocks failed to download. The fund comparison works the same
way (more than 20% of NAV histories missing, a third of the fund groups
failing, fewer than 150 funds ranked, or older data than the published file
keeps the previous `mf.json`), and so does the tax data: a file that fails its
checks (too few rows, or older than the published one) is not replaced.

---

## One-time setup (manual steps)

1. **Push this repository** to `github.com/yash040599/Rupevo` (`main`).
2. **Enable GitHub Pages**: *Settings → Pages → Build and deployment →
   Source: **GitHub Actions***. Then run *Actions → Deploy site → Run
   workflow* once (later pushes deploy automatically).
3. **Admin token** for the "Analyse now" button:
   [Settings → Developer settings → Fine-grained tokens → Generate new token](https://github.com/settings/personal-access-tokens/new)
   * Repository access: *Only select repositories* → `yash040599/Rupevo`
   * Permissions → Repository permissions → **Actions: Read and write**
   * Choose an expiry (for example 90 days) and paste it into the site's
     **Admin** panel. It is kept only in that browser and sent only to
     `api.github.com`; *Forget token* removes it.
4. **Emails from the site (Web3Forms)** — done. The site is static, so it
   cannot send email by itself; [Web3Forms](https://web3forms.com) is a free
   relay that forwards the site's *Request refresh* and *Request a company*
   forms to your inbox (without a key, those buttons fall back to opening the
   **visitor's** email app with a pre-filled message, which many visitors do
   not finish sending). To set it up again or change the key:
   1. On <https://web3forms.com> choose **Create your Form — Free**, sign up
      with `yash040599@gmail.com` and verify the email.
   2. Create the form: name `Rupevo website`, website URL
      `yash040599.github.io/Rupevo`. The next screen shows the access key
      (a long ID like `xxxxxxxx-xxxx-…`).
   3. Paste it into `web3formsKey: '…'` in
      [site/assets/js/config.js](site/assets/js/config.js), commit and push —
      the site redeploys by itself.
   4. Test it: on the live site click *Request refresh* (or *Request a
      company* on the Fidelity page) and send; the email arrives within a
      minute (the first time, check Gmail's Promotions or Spam folder and
      mark it "Not spam").

   The key is public by design (it can only email you). Free plan: 250
   emails/month, spam filtering included. Domain locking is a paid feature
   and not needed.
5. **Run one cloud refresh** (*Actions → Refresh market data → Run
   workflow*) to confirm Yahoo works from GitHub's runners, and one with
   `mf` to confirm AMFI and NSE answer them too (NSE sometimes blocks cloud
   IPs; the lump-sum check then keeps its last P/E readings, with their date).
6. **UPI for "Buy me a coffee"** — done (`yash040599@okhdfcbank`). To change
   it, edit `upi` in `site/assets/js/config.js` and regenerate the QR image:
   `python scripts/make_upi_qr.py <upi-id> --payee "<name>"` (a test fails
   while the QR and config disagree). The dialog shows the QR and the UPI ID
   with a copy button; on phones it also lists the three steps to pay the UPI
   ID from any UPI app. There is deliberately no "open UPI app" button: UPI
   apps reject payment links (`upi://pay`) to personal UPI IDs (the payment
   fails after the PIN), and on iPhone `upi://` opens one app chosen by iOS,
   often WhatsApp. "Save QR image" uses the share sheet on iPhone, so the
   image lands in Photos for the UPI app's scanner.

No secrets are stored in the repository or in GitHub Actions: the pipeline
uses only public data, and the admin token lives in your browser.

---

## Local development

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt

.\.venv\Scripts\python.exe -m unittest discover -s tests -t .   # tests
node --test "tests/js/*.test.mjs"                               # JS unit tests
.\.venv\Scripts\python.exe -m ruff check .                      # lint

# Quick partial run into a scratch folder (never overwrites site/data)
.\.venv\Scripts\python.exe -m pipeline refresh --limit 10 --out .cache\scratch

# Mutual funds: 3 funds per group into a scratch folder (NAV histories and
# expense ratios are cached in .cache\mf for 18 hours, so re-runs are quick)
.\.venv\Scripts\python.exe -m pipeline mf --limit 3 --out .cache\scratch

# Tax reference data (SBI rates, Microsoft and Oracle prices and dividends)
.\.venv\Scripts\python.exe -m pipeline tax-data --out .cache\scratch\tax

# Rebuild the synthetic exports the tests use (open and closed lots: made-up
# quantities, real Microsoft prices from site/data/tax/msft.json) in tests/fixtures/
.\.venv\Scripts\python.exe scripts\make_sample_export.py

# Preview the site at http://127.0.0.1:8765/
.\.venv\Scripts\python.exe -m http.server 8765 --directory site
```

Never commit a real broker export, or a test or fixture built from one: tests
use synthetic lots only.

Index constituents live in `pipeline/universes/*.json`. They refresh
automatically in the cloud workflow, or locally with
`python -m pipeline universe` (`--only nifty100|nasdaq100|nyse100`). After
NSE's March/September rebalance, add new Nifty 100 symbols to
[pipeline/universes/sectors.py](pipeline/universes/sectors.py) (a test fails
until every constituent has a sector bucket).

The **NYSE top 100** has no official constituent file, so it is selected from
every NYSE listing in Nasdaq's stock screener: US companies only, common stock
only (preferreds, listed notes and bonds, warrants and ADRs are left out), one
share class per company (the most traded, e.g. BRK.B), largest market value
first. A member stays until it falls below #120 and a newcomer joins once it
is in the top 80 (or a place frees up), so companies near #100 do not swap in
and out on every refresh. `--market us` builds it into `site/data/us-nyse.json`
next to the NASDAQ-100 in `site/data/us.json`; the US page combines the two.

## Project layout

```
pipeline/
  engine/          pure scoring code migrated from ai-portfolio-manager; mf_scoring.py (fund maths)
  providers/       Yahoo Finance prices, dividends + US fundamentals; amfi.py (AMFI, mfapi.in, NSE index file)
  universes/       Nifty 100 / NASDAQ-100 / NYSE top 100 lists, sector buckets, refresher
  india.py, us.py  snapshot builders;  publish.py, cli.py  the command line
  mf.py            mutual fund comparison (groups, name matching, scoring, reasons)
  mf_valuation.py  index P/E history for the lump-sum check
  taxdata.py       tax reference data: SBI TT buying rates, closes, dividends
scripts/
  make_upi_qr.py   regenerates the "Buy me a coffee" UPI QR image
  make_sample_export.py  writes the synthetic Fidelity exports in tests/fixtures/
site/
  index.html, india/, us/, mf/, 404.html
  tax/             Tax tools → rsu/ → fidelity/ → msft/, orcl/ (tabs: foreign assets, selling shares, dividends)
  assets/css/rupevo.css   design tokens ported from the local dashboard
  assets/js/              core, shell (nav/footer), coffee (UPI dialog),
                          device, ranking (+ us-lists: the US page's
                          NASDAQ/NYSE views), mf (fund page) + mf-plan
                          (SIP split and SIP maths), admin (refreshes and
                          email refresh links),
                          mail (forms → Web3Forms/mailto), request, tax,
                          fy (financial-year slider), trivia (the
                          "Did you know?" stories and facts), config,
                          fidelity (export parser), schedule-fa,
                          dividends and capital-gains (the maths),
                          rsu-tool (company pages)
  assets/img/             favicon, UPI QR (svg + png)
  data/                   published snapshots (written by the pipeline);
                          data/tax/ holds the tax tools' reference data
tests/             engine, snapshot, universe, parser, publication-safety,
                   tax-data, mutual fund (offline, with fake AMFI/NSE data)
                   and site-structure (links, assets, QR) tests;
                   tests/js/ holds Node tests for the financial-year maths,
                   the trivia content, the Fidelity parser, the Schedule FA, dividend and capital
                   gains engines, the US list views, the SIP split and phone detection;
                   tests/fixtures/ the synthetic exports
.github/workflows/ ci.yml · pages.yml (deploy) · refresh-data.yml (refresh + deploy)
```

### The mutual fund comparison

`python -m pipeline mf` ([pipeline/mf.py](pipeline/mf.py)) builds
`site/data/mf.json` from public data, about 10–15 minutes in the cloud
(AMFI allows about one request a second):

* **Which funds**: AMFI's fund-performance data lists every open-ended fund
  per SEBI sub-category with its benchmark, direct and benchmark returns,
  daily AUM and riskometer. Active groups are equity sub-categories; index
  groups come from the *Index Funds / ETFs* sub-category, without ETFs (no
  direct NAV) and ELSS index funds. Each fund is matched to its direct growth
  plan in `NAVAll.txt` for the scheme code (some fund houses call the growth
  option *Cumulative*; a few rows give no plan or option and are used only
  when their NAV matches the direct plan's).
* **Joins by name**: expense ratios (AMFI's daily TER rows per fund house: this
  month's, or last month's when a fund house has not posted yet) and tracking
  error (AMFI, the last three days published) are matched by scheme name
  through `name_key` with a close-match fallback that never pairs names with
  different numbers (Nifty 50 never matches Nifty 500).
* **Index funds** are grouped by the index their **name** spells out (AMFI's
  benchmark label is occasionally wrong: a Nifty 50 fund labelled Nifty 500).
  Tracking difference is computed from AMFI's returns: the fund's 1-, 3-, 5-
  and 10-year return minus the group's index return (the median of what the
  group's funds report). AMFI's monthly tracking-difference disclosure is not
  used because fund houses report it with different signs. Scores, on fixed
  scales: the gap to the index either way, averaged over 1 and 3 years (50%;
  0% scores 100, 1% or more 0; a fund with only a 1-year record is pulled
  halfway toward the group's typical fund), tracking error (20%), expense
  ratio (20%) and size (10%, log scale from ₹10 crore to ₹10,000 crore). A
  fund needs a 1-year return to be ranked.
* **Active funds**, as percentiles within the category among funds with
  5 years of history: consistency (the share of the last 60 month-ends at
  which the fund's 3-year return beat the category median; from mfapi.in NAV
  history) 30%, 3- and 5-year returns 20%, 5-year return per unit of
  volatility 20%, the worst fall in 5 years 15%, expense ratio 15%. The best
  index fund of the matching index group (with 5 years of history) is scored
  on the same rules to say where it would rank (*index check*).
* **Valuation check** ([pipeline/mf_valuation.py](pipeline/mf_valuation.py)):
  each index's P/E from NSE's daily index file against its own month-end P/E
  since April 2021 (NSE has computed P/E from consolidated profits since
  31 March 2021). Months already in the published file are not downloaded
  again. Factor indices are left out: their P/E jumps at every rebalance.
* Every fund carries its pillar scores, `reasons` and `notes` (small fund,
  regrouped by name, one-year record), which the page shows as *Why it ranks
  here*. The SIP split by age and risk is plain rules in
  [site/assets/js/mf-plan.js](site/assets/js/mf-plan.js) (`SPLITS`), tested
  in `tests/js/mf-plan.test.mjs`.
* The page opens with three questions (which fund, how much at your age,
  what to do with a lump sum) that preview the live answer and jump to their
  section; the full fund table starts folded. Sections and groups can be
  shared as direct links: `mf/#compare`, `mf/#plan`, `mf/#lumpsum`, `mf/#how`,
  or a group such as `mf/#midcap` or `mf/#nifty50`.

To add a group, add a `Group` to `INDEX_GROUPS` (its `benchmark` as
`benchmark_key` normalises it, e.g. `"nifty 200 momentum 30"`) or to
`ACTIVE_GROUPS` (AMFI's equity sub-category: 1 large, 2 large & mid, 3 flexi,
4 multi, 5 mid, 6 small, 7 value, 8 ELSS, 9 contra, 10 dividend yield,
11 focused), with a `valuation` key from `mf_valuation.INDICES` if it has one.

### Adding a tax guide page

Tax pages are plain HTML loading `assets/js/tax.js` (nav, footer, contact
links, the financial-year slider, trivia and the request-a-company form).
Copy a page from `site/tax/`, fix the relative `../` depth of its asset
links and breadcrumbs, and run the tests — `tests/test_site.py` fails on any
link or asset that does not resolve. Mark email links with
`<a data-contact data-contact-subject="…">` and the address is filled in
from `config.js`. Add `data-fy-progress` / `data-trivia` placeholders (see
any tax page's `fun-grid`) to show the slider and trivia; tax dates live in
`assets/js/fy.js`.

### Adding a "Did you know?" story

Stories and tax facts live in [site/assets/js/trivia.js](site/assets/js/trivia.js)
(`MARKET_STORIES` and `taxTrivia`). Each has an `id`, a `tag` (World, India,
Quick maths or Tax), an optional `year`, a `title`, the `story` and a
`takeaway`. Keep it true and checkable (dates, numbers, names), the story
under about 450 characters, plain text (it is shown as text, not HTML), and
the takeaway general — never a tip on a particular stock. Avoid putting two
Indian stories next to each other. `data-trivia="market"` shows only the
stories (home and ranking pages); `data-trivia` alone mixes in the tax facts.
`tests/js/trivia.test.mjs` checks the format, lengths and ordering.

### The company tax pages

[site/tax/rsu/fidelity/msft/](site/tax/rsu/fidelity/msft/index.html) and
[orcl/](site/tax/rsu/fidelity/orcl/index.html) load `assets/js/rsu-tool.js`
(which also runs `tax.js`). The page's `data-company` / `data-broker`
attributes pick the entity details, data file and investor-relations link from
the `COMPANIES` / `BROKERS` tables at the top of that file. The visitor loads
the exports (step 2): *View open lots* for the shares held and, if any were
sold, *View closed lots*, together or one at a time; each file's kind is
detected from its columns. The tool renders the return selector and three tabs
(`#fa`, `#selling`, `#dividends` in the URL). Shares sold or transferred count
in Schedule FA and the dividends for the time they were held, so when only one
export is loaded those two tabs say which file is missing (and that *View open
lots* alone is complete if nothing was ever sold):

* **Foreign assets** (`schedule-fa.js`): for each lot held during the calendar
  year, the initial value (value at vesting for RSUs; the purchase-day close
  for ESPP, or the price paid), the peak (the highest rupee value on any
  trading day, so never below the closing value), the 31 December value and the
  dividends paid, each at the SBI TT buying rate for its date (or the last
  rate before it); Table A2 for the Fidelity account; the Schedule AL cost.
  Lots sold during the year have a nil closing value, their sale proceeds (at
  the rate on the sale date) and a peak over the days they were held.
  ESPP lots are recognised by Fidelity's share source `SP` (or, for other
  codes, a grant date and a typical ESPP discount; the closed-lots export has
  no share source, so sold lots take it from a held lot of the same date or
  are judged by the discount alone).
* **Selling shares** (`capital-gains.js`): sales in the financial year,
  long-term when held more than 24 months (12.5% without indexation,
  section 112), otherwise short-term at the slab rate. The sale value is
  Fidelity's proceeds at the Rule 115 rate (last day of the month before the
  sale); the cost is the value taxed as salary (section 49(2AA)) at the rate on
  the vesting or purchase day, so the rupee's fall since then is part of the
  gain (an option converts the cost at the sale's rate instead). Output:
  Schedule CG A5/B8 fields, set-off of losses, the gains by date of sale
  (rows 3 and 5 of the accrual table), the Schedule FSI row (Article 13, no
  foreign tax) and a CSV of the working. Transfers out are not sales.
* **Dividends** (`dividends.js`): the payments in the financial year on lots
  acquired before each ex-date (and not sold before it), converted under Rule
  115 (SBI rate on the last day of the month before payment); the US tax at
  25% (W-8BEN) or 30%; the credit as the lowest of the US tax, the 25% treaty
  rate and the Indian tax at the visitor's rate; Schedule OS with the five 234C
  periods, FSI, TR and the Form 67 fields with its deadline (Form 44 from tax
  year 2026-27).

To add a company: add its ticker to `TAX_STOCKS` in `pipeline/taxdata.py`
(with a dividend source) and run `tax-data`, add an entry to `COMPANIES`,
and copy a company page, changing the names in step 1.

---

## Compliance notes (read before changing what is published)

* **Why not Zerodha Kite data?** The Kite Connect terms
  (<https://kite.trade/terms>) state that market data "cannot be displayed to
  the public at large" and prohibit publicly displaying derivative works of
  API content. A violation can terminate API access that the private trading
  bot depends on. Kite also allows one active access token per API key, so a
  cloud login would log the bot out. The public site therefore uses Yahoo
  Finance end-of-day data for both markets. Yahoo's terms also restrict
  redistribution; keep the site non-commercial, attributed and focused on
  derived scores.
* **SEBI.** The SEBI (Research Analysts) Regulations as amended in 2024 treat
  buy/sell/hold calls, price targets and trading calls (entry, stop-loss,
  target) as research services needing registration. "Consideration" can
  include indirect benefits, which a donation link may arguably count as.
  Rupevo therefore publishes a mechanical screen with neutral wording, no
  price levels, and a disclaimer on every page. This is not legal advice;
  take professional advice before adding recommendations, paid features or
  personalised advice.
* **Mutual funds.** The fund comparison is the same kind of mechanical
  screen: it ranks direct plans within a group by published numbers, states
  its rules, and uses neutral wording ("top ranked", never buy/sell; the same
  publication test covers `mf.json`). The SIP split is a general rule of thumb
  by fund *category* and never names a fund; the lump-sum check is a rule of
  thumb about index valuations. Selling mutual funds needs an AMFI
  registration (ARN) and personalised advice needs SEBI registration as an
  Investment Adviser, so the site links to no fund's purchase page, earns
  nothing from fund houses and asks nothing about a visitor's finances. The
  data comes from AMFI's public website, mfapi.in and NSE: keep it attributed
  and the site non-commercial.

## Roadmap

* Debt and hybrid fund groups, for the debt slice of the SIP split.
* More brokers and companies as people request them.
* Personal features (watchlists, portfolio analysis) — need sign-in and a
  backend; portfolio import is best done from broker CSV exports or the
  NSDL/CDSL CAS statement, parsed in the browser.

---

*Disclaimer: Rupevo is an educational project. Nothing here is investment
advice or a recommendation to buy, sell or hold any security. The author is
not a SEBI-registered Investment Adviser or Research Analyst.*
