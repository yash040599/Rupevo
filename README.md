# Rupevo

**Market rankings, explained.** Rupevo publishes rules-based rankings of the
**Indian Nifty 100** and the **US NASDAQ-100**, refreshed from end-of-day
prices, with every score broken down so readers can see *why* a stock ranks
where it does.

Live site (after the one-time setup below): **https://yash040599.github.io/Rupevo/**

| Page | What it shows | Model |
|---|---|---|
| [Nifty 100 Ranking](site/india/index.html) | Technical setups, technical score (A–D), risk grade, 52-week dips, sector strength | Migrated from the ai-portfolio-manager swing scanner |
| [NASDAQ-100 Ranking](site/us/index.html) | Six-pillar long-term scorecard: quality, valuation vs sector, growth, momentum, balance sheet, risk | Migrated from the ai-portfolio-manager US long-term scorer |

Every page has a USD/INR display toggle, light/dark theme, a "last synced"
indicator, a **Request refresh** button for visitors, a **Buy me a coffee**
button (UPI, coming next) and a finance disclaimer. No login is needed.

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
   data → Run workflow*, pick `both`, `india` or `us`.
3. **From your PC**:
   ```powershell
   cd C:\Users\yashagrawal\AiPortfolioManager\Rupevo
   .\.venv\Scripts\python.exe -m pipeline refresh --market both
   git add site/data; git commit -m "data: refresh"; git push
   ```
   Pushing `site/` triggers the deploy automatically.

To refresh automatically every weekday, uncomment the `schedule:` block in
[.github/workflows/refresh-data.yml](.github/workflows/refresh-data.yml).

If a market fails (for example Yahoo throttling), its previous snapshot
stays live, the other market still publishes, and the run is marked failed
with the reason in the job summary. A market is never published when more
than 20% of its stocks failed to download.

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
4. **Refresh-request emails**: go to [web3forms.com](https://web3forms.com),
   enter `yash040599@gmail.com`, and paste the access key from the email into
   `web3formsKey` in [site/assets/js/config.js](site/assets/js/config.js).
   Until then, *Request refresh* opens the visitor's email app pre-addressed
   to you. (Web3Forms keys are public by design; a key can only email its
   owner. Free tier: 250 submissions/month.)
5. **Run one cloud refresh** (*Actions → Refresh market data → Run
   workflow*) to confirm Yahoo works from GitHub's runners.
6. *(Next step)* **UPI for "Buy me a coffee"**: set `upi.id` in
   `site/assets/js/config.js`. Until then the button shows "coming soon".

No secrets are stored in the repository or in GitHub Actions: the pipeline
uses only public data, and the admin token lives in your browser.

---

## Local development

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt

.\.venv\Scripts\python.exe -m unittest discover -s tests -t .   # tests
.\.venv\Scripts\python.exe -m ruff check .                      # lint

# Quick partial run into a scratch folder (never overwrites site/data)
.\.venv\Scripts\python.exe -m pipeline refresh --limit 10 --out .cache\scratch

# Preview the site at http://127.0.0.1:8765/
.\.venv\Scripts\python.exe -m http.server 8765 --directory site
```

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
  providers/       Yahoo Finance prices + US fundamentals (network I/O)
  universes/       Nifty 100 / NASDAQ-100 lists, sector buckets, refresher
  india.py, us.py  snapshot builders;  publish.py, cli.py  the command line
site/
  index.html, india/, us/, 404.html
  assets/css/rupevo.css   design tokens ported from the local dashboard
  assets/js/              core, shell, ranking, admin, request, config
  data/                   published snapshots (written by the pipeline)
tests/             engine, snapshot, universe, parser and publication-safety tests
.github/workflows/ ci.yml · pages.yml (deploy) · refresh-data.yml (refresh + deploy)
```

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

* UPI "Buy me a coffee" (UPI deep link + QR).
* Tax tools: RSU / foreign assets (Schedule FA) ITR filing helper.
* Personal features (watchlists, portfolio analysis) — need sign-in and a
  backend; portfolio import is best done from broker CSV exports or the
  NSDL/CDSL CAS statement, parsed in the browser.

---

*Disclaimer: Rupevo is an educational project. Nothing here is investment
advice or a recommendation to buy, sell or hold any security. The author is
not a SEBI-registered Investment Adviser or Research Analyst.*
