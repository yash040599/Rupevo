# Rupevo

**Market rankings and tax tools, explained.** Rupevo publishes rules-based
rankings of the **Indian Nifty 100** and the **US NASDAQ-100**, refreshed from
end-of-day prices, with every score broken down so readers can see *why* a
stock ranks where it does — plus step-by-step **tax tools** for Indian
investors, starting with foreign RSUs.

Live site: **https://yash040599.github.io/Rupevo/**

| Page | What it shows | Model |
|---|---|---|
| [Nifty 100 Ranking](site/india/index.html) | Technical setups, technical score (A–D), risk grade, 52-week dips, sector strength | Migrated from the ai-portfolio-manager swing scanner |
| [NASDAQ-100 Ranking](site/us/index.html) | Six-pillar long-term scorecard: quality, valuation vs sector, growth, momentum, balance sheet, risk | Migrated from the ai-portfolio-manager US long-term scorer |
| [Tax tools](site/tax/index.html) | RSU taxation → broker (Fidelity) → company. **Microsoft: Schedule FA calculator.** Load Fidelity's *View open lots* CSV and get Table A3 (one row per RSU vest and ESPP purchase), Table A2 (the Fidelity account) and the Schedule AL cost, for the previous or current return (and the next one from January). Oracle is in progress; visitors can request another company. Every tax page has an interactive "how far through the financial year are we" slider (advance-tax and ITR dates marked) and rotating tax trivia | Runs in the browser: the user's file is never uploaded. Uses published SBI TT buying rates, Microsoft closes and dividends (`site/data/tax/`, refreshed weekly) |

Every page has light/dark theme, a **Buy me a coffee** button (in the top
bar, a floating ☕ on phones once the bar scrolls away, and the footer) and a
disclaimer. Ranking pages add a USD/INR toggle, a "last synced" indicator, a
**Request refresh** button and collapsible sections. No login is needed.

---

## How it works

```
             ┌──────────────── GitHub Actions: "Refresh market data" ────────────────┐
 Admin ──────►  python -m pipeline refresh   →  site/data/{india,us}.json  → commit  │
 (Analyse now│      │  Yahoo Finance EOD prices + fundamentals                          │
  button,    │      │  NSE / Nasdaq constituent lists                                   │
  Actions tab│      └─ scoring engine (pipeline/engine, migrated from the local tool)    │
  or local)  └──────────────────────────────┬───────────────────────────────────────────┘
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
  contains them (see *Compliance notes*).
* **Tax reference data**: `python -m pipeline tax-data` writes
  `site/data/tax/sbi-tt-buy-usd.json` (SBI telegraphic-transfer buying rates
  for USD since January 2020, from the MIT-licensed
  [sbi-fx-ratekeeper](https://github.com/sahilgupta/sbi-fx-ratekeeper) archive) and
  `site/data/tax/msft.json` (10 years of Yahoo Finance daily closes plus
  dividend ex/pay dates from Nasdaq, with Yahoo as the fallback). The tax
  calculators fetch these files and read the user's broker export in the
  browser (`assets/js/fidelity.js` parses it, `assets/js/schedule-fa.js`
  does the maths). Nothing personal is uploaded or stored.

---

## Refreshing the data (admin)

Every successful refresh updates the **Last synced** time on its page.
There are three ways to run one:

1. **"Analyse now" on the website** (recommended).
   Click **Admin** in the footer, paste a GitHub fine-grained token (see
   setup step 3) and the page switches "Request refresh" for **Analyse now**.
   It dispatches the workflow, follows the run live and reloads the page
   when the new data is deployed (about 3–6 minutes). The admin panel also
   has *Refresh both* and recent-run history. Visitors never see the button,
   and GitHub rejects dispatches from anyone without write access.
2. **GitHub Actions tab / GitHub mobile app**: *Actions → Refresh market
   data → Run workflow*, pick `both`, `india`, `us` or `tax`.
3. **From your PC**:
   ```powershell
   cd C:\Users\yashagrawal\AiPortfolioManager\Rupevo
   .\.venv\Scripts\python.exe -m pipeline refresh --market both
   .\.venv\Scripts\python.exe -m pipeline tax-data
   git add site/data; git commit -m "data: refresh"; git push
   ```
   Pushing `site/` triggers the deploy automatically.

**Tax data** (SBI rates, Microsoft prices and dividends) is refreshed on
every run, and on its own every Monday at 08:00 IST by the workflow's
schedule; choose `tax` to refresh only that. To refresh the rankings
automatically too, add another `cron:` line to the `schedule:` block in
[.github/workflows/refresh-data.yml](.github/workflows/refresh-data.yml)
(there is a commented example); any schedule other than the Monday one
refreshes both markets.

If a market fails (for example Yahoo throttling), its previous snapshot
stays live, the other market still publishes, and the run is marked failed
with the reason in the job summary. A market is never published when more
than 20% of its stocks failed to download. The tax data works the same way:
a file that fails its checks (too few rows, or older than the published one)
is not replaced.

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
4. **Emails from the site (Web3Forms)** — *recommended*. The site is static,
   so it cannot send email by itself; [Web3Forms](https://web3forms.com) is a
   free relay that forwards the site's *Request refresh* and *Request a
   company* forms to your inbox. Without it those buttons still work, but
   they open the **visitor's** email app with a pre-filled message, and many
   visitors will not finish sending it.
   1. Open <https://web3forms.com>, choose **Create your Access Key**, enter
      `yash040599@gmail.com` and submit.
   2. Copy the access key (a long ID like `xxxxxxxx-xxxx-…`) from the email
      Web3Forms sends you (check spam if it doesn't arrive).
   3. Paste it into `web3formsKey: '…'` in
      [site/assets/js/config.js](site/assets/js/config.js), commit and push —
      the site redeploys by itself.
   4. Test it: on the live site click *Request refresh* (or *Request a
      company* on the Fidelity page) and send; the email arrives within a
      minute.

   The key is public by design (it can only email you). Free plan: 250
   emails/month, spam filtering included. Domain locking is a paid feature
   and not needed.
5. **Run one cloud refresh** (*Actions → Refresh market data → Run
   workflow*) to confirm Yahoo works from GitHub's runners.
6. **UPI for "Buy me a coffee"** — done (`yash040599@okhdfcbank`). To change
   it, edit `upi` in `site/assets/js/config.js` and regenerate the QR image:
   `python scripts/make_upi_qr.py <upi-id> --payee "<name>"` (a test fails
   while the QR and config disagree). The dialog shows the QR and the UPI ID
   with a copy button. On phones it adds a button per UPI app (Google Pay,
   slice, PhonePe, Paytm, CRED, BHIM) that copies the UPI ID and opens the
   app: on iPhone through the app's own URL scheme, on Android through its
   Play Store page (tap Open). The visitor then pays the UPI ID from inside the app.
   There is deliberately no `upi://pay` payment link: UPI apps reject
   payment links to personal UPI IDs (the payment fails after the PIN),
   and on iPhone `upi://` opens one app chosen by iOS, often WhatsApp. "Save
   QR image" uses the share sheet on iPhone, so the image lands in Photos
   for the UPI app's scanner. The app list is in `site/assets/js/upi.js`.

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

# Tax reference data (SBI rates, Microsoft prices and dividends)
.\.venv\Scripts\python.exe -m pipeline tax-data --out .cache\scratch\tax

# Rebuild the synthetic sample behind "Try with sample data" (made-up
# quantities, real Microsoft prices from site/data/tax/msft.json)
.\.venv\Scripts\python.exe scripts\make_sample_export.py

# Preview the site at http://127.0.0.1:8765/
.\.venv\Scripts\python.exe -m http.server 8765 --directory site
```

Never commit a real broker export, or a test or sample built from one: tests and
samples use synthetic lots only.

Index constituents live in `pipeline/universes/*.json`. They refresh
automatically in the cloud workflow, or locally with
`python -m pipeline universe`. After NSE's March/September rebalance, add
new Nifty 100 symbols to
[pipeline/universes/sectors.py](pipeline/universes/sectors.py) (a test fails
until every constituent has a sector bucket).

## Project layout

```
pipeline/
  engine/          pure scoring code migrated from ai-portfolio-manager
  providers/       Yahoo Finance prices, dividends + US fundamentals (network I/O)
  universes/       Nifty 100 / NASDAQ-100 lists, sector buckets, refresher
  india.py, us.py  snapshot builders;  publish.py, cli.py  the command line
  taxdata.py       tax reference data: SBI TT buying rates, closes, dividends
scripts/
  make_upi_qr.py   regenerates the "Buy me a coffee" UPI QR image
  make_sample_export.py  writes the synthetic Fidelity sample export
site/
  index.html, india/, us/, 404.html
  tax/             Tax tools → rsu/ → fidelity/ → msft/ (Schedule FA calculator), orcl/
  assets/css/rupevo.css   design tokens ported from the local dashboard
  assets/js/              core, shell (nav/footer), coffee (UPI dialog) +
                          upi (UPI app links), ranking, admin,
                          mail (forms → Web3Forms/mailto), request, tax,
                          fy (financial-year slider + trivia), config,
                          fidelity (export parser), schedule-fa (the maths),
                          rsu-tool (calculator page)
  assets/img/             favicon, UPI QR (svg + png)
  assets/samples/         synthetic broker export for "Try with sample data"
  data/                   published snapshots (written by the pipeline);
                          data/tax/ holds the calculators' reference data
tests/             engine, snapshot, universe, parser, publication-safety,
                   tax-data and site-structure (links, assets, QR) tests;
                   tests/js/ holds Node tests for the financial-year maths,
                   the Fidelity parser, the Schedule FA engine and the UPI
                   app links
.github/workflows/ ci.yml · pages.yml (deploy) · refresh-data.yml (refresh + deploy)
```

### Adding a tax guide page

Tax pages are plain HTML loading `assets/js/tax.js` (nav, footer, contact
links, the financial-year slider, trivia and the request-a-company form).
Copy a page from `site/tax/`, fix the relative `../` depth of its asset
links and breadcrumbs, and run the tests — `tests/test_site.py` fails on any
link or asset that does not resolve. Mark email links with
`<a data-contact data-contact-subject="…">` and the address is filled in
from `config.js`. Add `data-fy-progress` / `data-trivia` placeholders (see
any tax page's `fun-grid`) to show the slider and trivia; facts and tax
dates live in `assets/js/fy.js`.

### The Schedule FA calculator

[site/tax/rsu/fidelity/msft/](site/tax/rsu/fidelity/msft/index.html) loads
`assets/js/rsu-tool.js` (which also runs `tax.js`). The page's
`data-company` / `data-broker` attributes pick the entity details, data file
and sample from the `COMPANIES` / `BROKERS` tables at the top of that file.
For each lot held during the calendar year it works out: the initial value
(value at vesting for RSUs; the purchase-day close for ESPP, or the price
paid); the peak (the highest rupee value on any trading day, so never below
the closing value); the 31 December value; and dividends paid. Each uses the
SBI TT buying rate for its date, or the last rate before it. It also
gives Table A2 for the Fidelity account and the Schedule AL cost. To add a
company: add its ticker to `TAX_STOCKS` in `pipeline/taxdata.py` and run
`tax-data`, add an entry to `COMPANIES`, and copy the Microsoft page. Its
ESPP rules (discount, lookback) may need changes to `classifyLot`.

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

## Roadmap

* Tax tools for Microsoft at Fidelity: dividends (Schedule OS, FSI and TR
  with Form 67), then sold shares from "Previously held shares" (capital
  gains, plus sale proceeds in Schedule FA). Then the same for Oracle.
* More brokers and companies as people request them.
* Personal features (watchlists, portfolio analysis) — need sign-in and a
  backend; portfolio import is best done from broker CSV exports or the
  NSDL/CDSL CAS statement, parsed in the browser.

---

*Disclaimer: Rupevo is an educational project. Nothing here is investment
advice or a recommendation to buy, sell or hold any security. The author is
not a SEBI-registered Investment Adviser or Research Analyst.*
