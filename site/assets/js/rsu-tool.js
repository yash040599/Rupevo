// RSU tool on the company pages (tax/rsu/fidelity/msft/, orcl/): reads the
// broker exports in the browser and shows, in tabs, the Schedule FA values,
// the dividend income with its foreign tax credit, and the capital gains on
// shares sold. The files never leave the device: they are parsed here and kept
// in memory.
import './tax.js';
import { esc, loadJSON, siteUrl, toast } from './core.js';
import { fillContactLinks } from './shell.js';
import { fmtDay, istWallClock } from './fy.js';
import { detectExport, parseClosedLots, parseOpenLots } from './fidelity.js';
import { classifyLot, computeScheduleFA, priceCheck, returnOptions, scheduleFaCsv, series } from './schedule-fa.js';
import { computeDividends, DTAA, QUARTERS } from './dividends.js';
import { capitalGainsCsv, computeCapitalGains, DTAA_GAINS } from './capital-gains.js';

const COUNTRY = '2 - United States of America';
const COMPANIES = {
  MSFT: {
    name: 'Microsoft Corporation', short: 'Microsoft', address: 'One Microsoft Way, Redmond, Washington',
    zip: '98052', nature: 'Listed company', data: 'data/tax/msft.json', esppDiscount: 0.1,
    ir: 'https://www.microsoft.com/en-us/investor/dividends-and-stock-history',
  },
  ORCL: {
    name: 'Oracle Corporation', short: 'Oracle', address: '2300 Oracle Way, Austin, Texas',
    zip: '78741', nature: 'Listed company', data: 'data/tax/orcl.json', esppDiscount: 0.15,
    ir: 'https://investor.oracle.com/dividends-and-splits/default.aspx',
  },
};
const BROKERS = {
  fidelity: { name: 'Fidelity Stock Plan Services, LLC', address: '245 Summer Street, Boston, Massachusetts', zip: '02210' },
};
// Surcharge on dividend income is capped at 15%, so 35.88% is the highest rate on it. Short-term
// capital gains can carry a higher surcharge: “Another rate” covers those.
const TAX_RATES = [
  [0.312, '31.2%: 30% slab + 4% cess (income up to ₹50 lakh)'],
  [0.3432, '34.32%: with 10% surcharge (₹50 lakh – ₹1 crore)'],
  [0.3588, '35.88%: with 15% surcharge (above ₹1 crore)'],
  [0.26, '26%: 25% slab + cess'],
  [0.208, '20.8%: 20% slab + cess'],
  [0.156, '15.6%: 15% slab + cess'],
  [0.104, '10.4%: 10% slab + cess'],
  [0.052, '5.2%: 5% slab + cess'],
];
const TABS = ['fa', 'selling', 'dividends'];
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 4;
const MIN_BUSY_MS = 600;
const KINDS = {
  open: { title: 'Shares you hold', file: 'View open lots.csv', idPrefix: 'L' },
  closed: { title: 'Shares you sold', file: 'View closed lots.csv', idPrefix: 'C' },
};

const app = document.getElementById('app');
const company = COMPANIES[app.dataset.company];
const broker = BROKERS[app.dataset.broker];
const els = {
  drop: document.getElementById('dropzone'),
  dropName: document.getElementById('dz-name'),
  file: document.getElementById('file-input'),
  status: document.getElementById('load-status'),
  tool: document.getElementById('tool'),
};
// files.open / files.closed: { kind, name, lots, skipped } for each export loaded. lots: both
// together (for Schedule FA and the dividends); closedLots: the sold lots, with the share source
// filled in from the open lots where possible. loadErrors: messages about files that could not be used.
const state = {
  files: { open: null, closed: null }, lots: null, closedLots: [], esppBasis: 'fmv', rateOverrides: {},
  loadErrors: [], data: null, fa: null, div: null, cg: null, costRate: 'acquired',
  indiaRate: 0.312, customRate: false, usRate: DTAA.rate, historyAll: false,
};
const today = () => istWallClock().toISOString().slice(0, 10);

// ── Formatting ──
const inrFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const rupees = (n) => (n === null || n === undefined ? '—' : `${n < 0 ? '−' : ''}₹${inrFmt.format(Math.abs(n))}`);
const money = (n, max = 2) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: max })}`;
const usd = (n) => money(n);
const shares = (q) => q.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const dmy = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const longDate = (iso) => (iso ? fmtDay(new Date(`${iso}T00:00:00Z`)) : '—');
const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(2).replace(/\.?0+$/, '')}%`);
const rateText = (r) => (r ? `₹${r.rate.toFixed(2)}${r.manual ? ' (entered by you)' : ` (SBI, ${longDate(r.date)})`}` : '—');
const copyVal = (n) => (n === null || n === undefined ? '<span class="muted">—</span>'
  : `<button class="copy-val" type="button" data-copy="${n}" title="Copy ${n}">${rupees(n)}</button>`);
const copyText = (s) => `<button class="copy-val" type="button" data-copy="${esc(s)}" title="Copy">${esc(s)}</button>`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fyLabel = (fy) => `FY ${fy}-${String((fy + 1) % 100).padStart(2, '0')}`;
// What a lot's value per share at acquisition is (classifyLot's `basis`).
const BASIS_TEXT = {
  cost: 'value at vesting, from your export',
  close: 'closing price on the purchase day',
  paid: 'price you paid',
  estimated: 'estimated from the price paid',
};

// ── Data ──
let dataPromise = null;
function loadData() {
  dataPromise ||= Promise.all([loadJSON(siteUrl(company.data)), loadJSON(siteUrl('data/tax/sbi-tt-buy-usd.json'))])
    .then(([stock, fx]) => ({
      stock, fx, prices: series(stock.closes), rates: series(fx.rates), dividends: stock.dividends,
    }))
    .catch((err) => { dataPromise = null; throw err; });
  return dataPromise;
}

// ── Page skeleton: return bar, tabs and panels ──
function skeleton() {
  const options = returnOptions(today());
  els.tool.innerHTML = `
    <section class="card tool-bar" id="tool-top" aria-label="Return and section">
      <div class="controls-row">
        <label class="field">Return you are filing
          <select id="year-select">${options.map((o) => `<option value="${o.cy}"${o.isDefault ? ' selected' : ''}>${
            o.fyLabel} return (${o.yearLabel}, filed in ${o.filedIn})</option>`).join('')}</select>
        </label>
      </div>
      <div class="tabs" role="tablist" aria-label="Parts of your return">
        <button class="tab" type="button" role="tab" id="tab-fa" aria-controls="panel-fa" data-tab="fa">
          <span class="tab-title">Foreign assets</span><span class="tab-sub">Schedule FA · AL</span></button>
        <button class="tab" type="button" role="tab" id="tab-selling" aria-controls="panel-selling" data-tab="selling">
          <span class="tab-title">Selling shares</span><span class="tab-sub">Capital gains · CG · FSI</span></button>
        <button class="tab" type="button" role="tab" id="tab-dividends" aria-controls="panel-dividends" data-tab="dividends">
          <span class="tab-title">Dividends</span><span class="tab-sub">OS · FSI · TR · Form 67</span></button>
      </div>
    </section>

    <div class="tab-panel" role="tabpanel" id="panel-fa" aria-labelledby="tab-fa" tabindex="-1">
      <div id="fa-files"></div>
      <section class="card" id="fa-head" hidden>
        <p class="small muted" id="fa-period" style="margin:0"></p>
        <fieldset class="radio-row" id="espp-basis" hidden style="border:0;padding:0;margin:10px 0 0">
          <legend class="small muted" style="padding:0;margin-bottom:4px">ESPP shares: initial value at</legend>
          <label><input type="radio" name="espp-basis" value="fmv" checked> market price on the purchase day
            (recommended)</label>
          <label><input type="radio" name="espp-basis" value="paid"> the price you paid</label>
        </fieldset>
      </section>
      <div id="fa-results"></div>
      ${faMethod()}
    </div>

    <div class="tab-panel" role="tabpanel" id="panel-selling" aria-labelledby="tab-selling" tabindex="-1" hidden>
      <section class="card" id="cg-controls" hidden>
        <p class="small muted" id="cg-period" style="margin:0 0 10px"></p>
        <fieldset class="radio-row" style="border:0;padding:0;margin:0 0 12px">
          <legend class="small muted" style="padding:0;margin-bottom:4px">Convert the cost at</legend>
          <label><input type="radio" name="cost-rate" value="acquired" checked> SBI's rate on the vesting or purchase
            day (recommended)</label>
          <label><input type="radio" name="cost-rate" value="sale"> the sale's rate, like the sale value</label>
        </fieldset>
        <fieldset class="radio-row" id="cg-espp-basis" hidden style="border:0;padding:0;margin:0 0 12px">
          <legend class="small muted" style="padding:0;margin-bottom:4px">ESPP shares: cost at</legend>
          <label><input type="radio" name="cg-espp-basis" value="fmv" checked> market price on the purchase day
            (recommended)</label>
          <label><input type="radio" name="cg-espp-basis" value="paid"> the price you paid</label>
        </fieldset>
        <div class="controls-row">${rateField('Your slab rate, for the tax estimate')}</div>
        <p class="small muted" style="margin:10px 0 0">The rate only changes the estimate of Indian tax in Schedule FSI:
          short-term gains at this rate, long-term gains at 12.5% plus cess (and surcharge, capped at 15%). It is the
          same setting as on the Dividends tab.</p>
      </section>
      <div id="cg-results"></div>
      ${cgMethod()}
    </div>

    <div class="tab-panel" role="tabpanel" id="panel-dividends" aria-labelledby="tab-dividends" tabindex="-1" hidden>
      <div id="div-files"></div>
      <section class="card" id="div-controls" hidden>
        <p class="small muted" id="div-period" style="margin:0 0 10px"></p>
        <div class="controls-row">
          ${rateField('Your Indian tax rate on this income')}
          <label class="field">US tax withheld
            <select id="us-rate">
              <option value="0.25" selected>25%: W-8BEN on file (India–US treaty rate)</option>
              <option value="0.3">30%: no W-8BEN on file</option>
            </select>
          </label>
        </div>
        <p class="small muted" style="margin:10px 0 0">The rate only changes the foreign tax credit, which is capped
          at the Indian tax on the dividends. Most people with RSUs are in the 30% slab; if your CA uses your average
          rate instead, choose “Another rate”.</p>
      </section>
      <div id="div-results"></div>
      <section class="card" id="div-history"><span class="skel" style="width:40%"></span><span class="skel"></span></section>
      ${divMethod()}
    </div>

    ${itrChecklistHtml()}`;
}

function faMethod() {
  return `<section class="card">
    <details class="fold">
      <summary><h2>How the Schedule FA numbers are worked out</h2></summary>
      <div class="prose">
        <p><strong>Which year.</strong> Schedule FA lists foreign assets held at any time in the <em>calendar</em>
          year that starts in the return's financial year: the return for FY 2025-26 covers 1 January – 31 December
          2025. Shares acquired from January to March appear in the following year's Schedule FA.</p>
        <p><strong>Exchange rate.</strong> Every rupee value uses the State Bank of India telegraphic transfer (TT)
          buying rate for the relevant date, as the ITR instructions require. On weekends and bank holidays the last
          rate SBI published before that date is used, and if SBI revised a rate during the day, its first rate of
          the day. The rates come from SBI's daily forex card rates, archived since January 2020 by the open-source
          <a href="https://github.com/sahilgupta/sbi-fx-ratekeeper" target="_blank" rel="noopener">sbi-fx-ratekeeper</a>.</p>
        <p><strong>Initial value.</strong> Shares × value per share on the acquisition date × the rate that day. For
          RSUs the value per share is the cost basis in your export: the market value at vesting, taxed as salary
          through your payslip. For ESPP purchases it is that day's closing price, because the
          ${Math.round(company.esppDiscount * 100)}% discount is also taxed as salary; you can switch to the price you
          paid.</p>
        <p><strong>Peak value.</strong> For each lot, the highest value in rupees on any trading day from 1 January
          (or its acquisition date, if later) to 31 December: shares × that day's closing price × that day's rate. The
          rupee moves too, so this can be a different day from the highest dollar price. It is never below the closing
          value, nor, for shares acquired during the year, below the initial value. Table A2's peak balance is worked
          out the same way for all the lots together.</p>
        <p><strong>Closing value.</strong> The closing price on 31 December (or the last trading day before it) ×
          shares, at the rate on 31 December. While the year is still running, the latest closing price and rate are
          used and the values are marked provisional.</p>
        <p><strong>Amount paid or credited.</strong> ${esc(company.short)}'s cash dividends paid during the year on the
          lot's shares, if the lot was acquired before the ex-dividend date. The amounts are gross, before the US tax
          withheld, and converted at the rate on the payment date, as is common practice for Schedule FA.</p>
        <p><strong>Sale proceeds.</strong> For shares sold during the year (from Fidelity's View closed lots.csv): the
          amount Fidelity paid for them, after its fees, at the rate on the day of the sale. A sold lot's closing value
          is nil, and its peak counts only the days it was held, including the sale.</p>
        <p><strong>One row per lot.</strong> Some guides combine all lots of a company into one row. A row per vest or
          purchase gives the date of acquisition the form asks for, and is the more detailed choice.</p>
        <p><strong>Data.</strong> Prices are Yahoo Finance daily closes, refreshed weekly with the dividends. Values
          are rounded to whole rupees, as the e-filing portal requires.</p>
      </div>
    </details>
  </section>`;
}

function divMethod() {
  return `<section class="card">
    <details class="fold">
      <summary><h2>How the dividend numbers are worked out</h2></summary>
      <div class="prose">
        <p><strong>Which year.</strong> Dividends are income of the <em>financial</em> year in which they are paid,
          1 April – 31 March. (Schedule FA uses the calendar year instead, so its dividend totals differ.)</p>
        <p><strong>Which shares.</strong> A lot receives a dividend if it was acquired before the ex-dividend date
          and, if you sold it, sold on or after that date. Shares you sold are in Fidelity's View closed lots.csv: load
          it too if you sold any, so the dividends they received before the sale are counted.</p>
        <p><strong>Exchange rate.</strong> Rule 115 converts a dividend at SBI's TT buying rate on the last day of the
          month before the month it is paid; on a weekend or holiday, the last rate before it. Rule 128 converts the
          US tax withheld at the same rate.</p>
        <p><strong>US tax.</strong> Fidelity withholds US tax from each dividend: 25% under Article 10 of the
          India–US tax treaty when a W-8BEN is on file, otherwise 30%. Only the treaty's 25% can be credited in
          India; anything above it has to be reclaimed from the US.</p>
        <p><strong>Foreign tax credit.</strong> The lowest of the US tax paid, 25% of the dividend and the Indian tax
          on the dividend at the rate you choose. With a 25% withholding and the 30% slab, that is the full US tax.
          The surcharge on dividend income is capped at 15%.</p>
        <p><strong>Quarters.</strong> Schedule OS asks when dividends were received, in five periods, to work out
          interest for late advance tax (section 234C). Each payment goes in the period of its payment date.</p>
        <p><strong>Data.</strong> Dividend dates and amounts are refreshed weekly from the source named above the
          dividend history; check them against
          <a href="${esc(company.ir)}" target="_blank" rel="noopener">${esc(company.short)}'s investor relations
          page</a>. Values are rounded to whole rupees, payment by payment.</p>
      </div>
    </details>
  </section>`;
}

// The tax-rate select appears on the Dividends and Selling tabs; syncControls() keeps them in step.
function rateField(label) {
  return `<label class="field">${label}
      <select data-india-rate>${TAX_RATES.map(([v, text]) => `<option value="${v}"${v === state.indiaRate
        ? ' selected' : ''}>${text}</option>`).join('')}<option value="custom">Another rate…</option></select>
    </label>
    <label class="field" data-custom-wrap hidden>Rate in %
      <input type="number" data-custom-rate min="0" max="50" step="0.01" inputmode="decimal" placeholder="e.g. 32">
    </label>`;
}

function cgMethod() {
  return `<section class="card">
    <details class="fold">
      <summary><h2>How the capital gains are worked out</h2></summary>
      <div class="prose">
        <p><strong>Which year.</strong> A gain is income of the financial year (1 April – 31 March) in which the
          shares were sold.</p>
        <p><strong>Short or long.</strong> ${esc(company.short)} shares are listed in the US, not on an Indian stock
          exchange, so they are long-term only when held for <em>more than 24 months</em> (section 2(42A)), from the
          vesting or purchase date to the sale date; exactly 24 months is still short-term. Fidelity's “Term” column
          uses the US one-year rule and does not count.</p>
        <p><strong>Tax rates.</strong> Long-term gains: 12.5% without indexation (section 112, for sales from 23 July
          2024), plus surcharge, capped at 15%, and 4% cess. The ₹1.25 lakh exemption is only for shares listed in
          India and equity funds (section 112A), so it does not apply. Short-term gains: your slab rate.</p>
        <p><strong>Sale value.</strong> Fidelity's proceeds in US dollars, after its fees, converted at SBI's TT
          buying rate on the last day of the month before the month of the sale (Rule 115); on a weekend or holiday,
          the last rate before it.</p>
        <p><strong>Cost.</strong> For RSU and ESPP shares, the cost is the fair market value that was taxed as salary
          when you got them (section 49(2AA)): the value at vesting from your export, or the closing price on the ESPP
          purchase day. It is converted at SBI's TT buying rate on that day. The rupee has mostly fallen against the
          dollar since then, so the same dollars are worth more rupees at the sale: that difference is part of the
          gain, and each sale's maths shows how much.</p>
        <p><strong>The other view.</strong> Some advisers convert the whole gain at the sale's Rule 115 rate (the gain
          in dollars × that rate), which leaves the rupee's fall out. That is the usual method for shares bought with
          your own dollars. For shares taxed as salary in rupees, section 49(2AA) points to the rupee cost. Switch
          above to compare, and ask your CA which to file.</p>
        <p><strong>Losses.</strong> Within these sales, a short-term loss is set off against long-term gains; a
          long-term loss only against long-term gains. In the table of gains by date, each period gets the gains of
          the sales in it, with losses taken off the latest periods first.</p>
        <p><strong>Data.</strong> SBI rates from the same archive as the other tabs; prices are Yahoo Finance daily
          closes. Values are rounded to whole rupees, sale by sale.</p>
      </div>
    </details>
  </section>`;
}

function itrChecklistHtml() {
  const fa = ['fa', 'Foreign assets'];
  const div = ['dividends', 'Dividends'];
  const sell = ['selling', 'Selling shares'];
  const rows = [
    ['Schedule FA', 'The shares (Table A3), including any sold during the year, and the Fidelity account (Table A2)', [fa]],
    ['Schedule AL', 'Only if your total income is above ₹1 crore: the cost of the shares', [fa]],
    ['Schedule CG', 'Gains on shares you sold: A5 short-term, B8 long-term, and when they arose', [sell]],
    ['Schedule OS', 'Dividend income, gross, with its quarterly breakup', [div]],
    ['Schedule FSI', 'The capital gains, and the dividends with the US tax paid on them', [sell, div]],
    ['Schedule TR', 'The foreign tax credit claimed under section 90', [div]],
    ['Form 67', 'Filed separately on the e-filing portal, before the ITR', [div]],
  ];
  return `<section class="card">
    <div class="card-head"><h2>Your ITR checklist for ${esc(company.short)} shares</h2></div>
    <div class="table-scroll"><table class="fa checklist-table">
      <thead><tr><th class="left">Where in the ITR</th><th class="left">What goes there</th><th class="left">On this page</th></tr></thead>
      <tbody>${rows.map(([where, what, links]) => `<tr><td class="left"><strong>${where}</strong></td>
        <td class="left">${what}</td><td class="left">${links.map(([tab, label]) => `<a href="#${tab}"
          data-goto="${tab}">${label}</a>`).join(' · ')}</td></tr>`).join('')}
        <tr><td class="left"><strong>Unlisted equity shares</strong></td><td class="left" colspan="2">The instructions
          ask for shares of <em>unlisted</em> foreign companies here, even when they are also in Schedule FA.
          ${esc(company.short)} is listed in the US, so it is usually left out; some CAs still add foreign shares
          because they are not listed in India. Ask yours if unsure.</td></tr>
      </tbody>
    </table></div>
    <p class="small muted" style="margin:10px 0 0">Use <strong>ITR-2</strong> (or ITR-3 with business income): ITR-1
      and ITR-4 cannot report foreign assets or income.</p>
  </section>`;
}

// ── Tabs ──
function selectTab(name, { focus = false } = {}) {
  const tabs = [...els.tool.querySelectorAll('[role="tab"]')];
  for (const tab of tabs) {
    const on = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !on;
    if (on && focus) tab.focus();
  }
  if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
}

// ── Loading the files ──
function setDrop(stateName, name = '') {
  els.drop.dataset.state = stateName;
  if (els.dropName) els.dropName.textContent = name;
  const busy = els.drop.querySelector('.dz-busy-text');
  if (busy && stateName === 'busy') busy.textContent = name.includes(' + ') ? 'Reading your files…' : 'Reading your file…';
}

function refreshDrop() {
  const names = Object.keys(KINDS).map((k) => state.files[k]?.name).filter(Boolean);
  setDrop(names.length ? 'done' : 'idle', names.join(' + '));
}

class LoadError extends Error {
  constructor(html, kind = null) {
    super(html);
    this.html = html;
    this.kind = kind;
  }
}

// Reads one export: works out which of the two it is, then checks its currency and prices.
async function readExport(text, name) {
  const file = `<strong>${esc(name)}</strong>`;
  const kind = detectExport(text);
  if (!kind) {
    throw new LoadError(`${file} does not look like a Fidelity share export: it has no “Date acquired” and
      “Quantity” columns. Choose <strong>View open lots.csv</strong> or <strong>View closed lots.csv</strong>.`);
  }
  let parsed;
  try {
    parsed = kind === 'open' ? parseOpenLots(text) : parseClosedLots(text);
  } catch (err) {
    throw new LoadError(`${file}: ${esc(err.message)}`, kind);
  }
  if (parsed.currency && parsed.currency !== 'USD') {
    throw new LoadError(`${file} shows values in ${esc(parsed.currency)}. Indian tax needs the US-dollar values, each
      converted at SBI's rate for its own date. In Fidelity's share details window, choose <strong>Asset
      currency</strong> before clicking <strong>Export</strong>.`, kind);
  }
  let data;
  try {
    data = await loadData();
  } catch (err) {
    throw new LoadError(`Could not load the exchange rates and prices (${esc(err.message)}). Please try again.`);
  }
  const check = priceCheck(parsed.lots, data.prices);
  if (!check.ok) {
    throw new LoadError(`The cost per share in ${file} does not match ${esc(company.short)}'s share price in US
      dollars on the dates the shares were acquired (${check.off} of ${check.checked} lots are far off). Check that
      this is your ${esc(company.short)} export, saved with <strong>Asset currency</strong> selected.`, kind);
  }
  state.data = data;
  return { kind, name, lots: parsed.lots, skipped: parsed.skipped };
}

// The closed-lots export has no share source or grant date: take them from the shares of the
// same lot still held (a partial sale), when those agree.
function mergeLots() {
  const open = state.files.open?.lots || [];
  state.closedLots = (state.files.closed?.lots || []).map((l) => {
    if (l.source !== null) return l;
    const same = open.filter((o) => o.acquired === l.acquired);
    const agree = same.length && same.every((o) => o.source === same[0].source && o.grantDate === same[0].grantDate);
    return agree ? { ...l, source: same[0].source, grantDate: same[0].grantDate } : l;
  });
  state.lots = open.length || state.closedLots.length ? [...open, ...state.closedLots] : null;
}

function setFile(kind, file) {
  state.files[kind] = file;
  // Rates typed in belong to the lots of the file they were typed for.
  for (const id of Object.keys(state.rateOverrides)) {
    if (id.startsWith(KINDS[kind].idPrefix)) delete state.rateOverrides[id];
  }
  mergeLots();
}

function describe(f) {
  const total = f.lots.reduce((a, l) => a + l.quantity, 0);
  const skipped = f.skipped.length ? ` Skipped ${plural(f.skipped.length, 'row')} without a quantity, date or cost
    (line ${f.skipped.map((s) => s.line).join(', ')}).` : '';
  const head = `<strong>${KINDS[f.kind].title}</strong> · ${esc(f.name)}:`;
  if (f.kind === 'closed') {
    const moved = f.lots.filter((l) => l.transferred).length;
    const dates = f.lots.map((l) => l.sold);
    return `${head} ${plural(f.lots.length, 'lot')}${moved ? ` (${moved} transferred out)` : ''}, ${shares(total)}
      shares, sold ${esc(longDate(dates[0]))} – ${esc(longDate(dates[dates.length - 1]))}.${skipped}`;
  }
  const types = state.data
    ? f.lots.map((l) => classifyLot(l, state.data.prices, { esppDiscount: company.esppDiscount }).type) : [];
  const rsu = types.filter((t) => t === 'RSU').length;
  const kinds = [rsu && plural(rsu, 'RSU vest'), types.length - rsu && plural(types.length - rsu, 'ESPP purchase')]
    .filter(Boolean).join(', ');
  return `${head} ${plural(f.lots.length, 'lot')}${kinds ? ` (${kinds})` : ''}, ${shares(total)} shares, acquired
    ${esc(longDate(f.lots[0].acquired))} – ${esc(longDate(f.lots[f.lots.length - 1].acquired))}.${skipped}`;
}

function renderStatus() {
  const lines = [];
  for (const kind of Object.keys(KINDS)) {
    const f = state.files[kind];
    if (f) {
      lines.push(`<div class="status-line ok file-line"><span>${describe(f)}</span><button class="btn ghost small"
        type="button" data-remove="${kind}" aria-label="Remove ${esc(f.name)}">Remove</button></div>`);
    }
  }
  for (const html of state.loadErrors) lines.push(`<div class="status-line bad">${html}</div>`);
  if (state.files.open && !state.files.closed) {
    lines.push(`<p class="small muted load-hint">Sold or transferred any ${esc(company.short)} shares? Load
      <strong>View closed lots.csv</strong> too (step 1, Previously held shares): the <a href="#selling"
      data-goto="selling">Selling shares</a> tab works out the capital gains, and Schedule FA and the dividends include
      those shares for the time you held them. Never sold or transferred any? Then View open lots.csv alone is
      complete.</p>`);
  } else if (state.files.closed && !state.files.open) {
    lines.push(`<p class="small muted load-hint">Still hold ${esc(company.short)} shares? Load <strong>View open
      lots.csv</strong> too (step 1, Current shares): Schedule FA and the dividends need them as well.</p>`);
  }
  els.status.innerHTML = lines.length ? `<div class="load-lines">${lines.join('')}</div>` : '';
}

// Files are read one pick at a time, and a pick can finish after a later one (the first waits for the
// rates and prices). Each kind keeps the file of the latest pick that included that kind, so a slow
// earlier pick cannot overwrite a newer file of its kind, while picks of the two kinds add up.
let loadSeq = 0;
let inFlight = 0;
const kindSeq = { open: 0, closed: 0 };

async function useFiles(list) {
  const files = [...(list || [])].filter(Boolean);
  if (!files.length) return;
  const seq = ++loadSeq;
  inFlight += 1;
  setDrop('busy', files.map((f) => f.name).join(' + '));
  const started = Date.now();
  const loaded = [];
  const errors = [];
  try {
    for (const file of files.slice(0, MAX_FILES)) {
      if (file.size > MAX_FILE_BYTES) {
        errors.push(new LoadError(`<strong>${esc(file.name)}</strong> is too large to be a Fidelity export.`));
        continue;
      }
      try {
        loaded.push(await readExport(await file.text(), file.name));
      } catch (err) {
        errors.push(err instanceof LoadError ? err
          : new LoadError(`Could not read <strong>${esc(file.name)}</strong> (${esc(err.message)}).`));
      }
    }
    if (files.length > MAX_FILES) errors.push(new LoadError(`Only the first ${MAX_FILES} files were read.`));
    // Keep the spinner up long enough to be seen: the files are read in milliseconds.
    const wait = MIN_BUSY_MS - (Date.now() - started);
    if (wait > 0) await new Promise((resolve) => { setTimeout(resolve, wait); });
  } finally {
    inFlight -= 1;
  }
  const fresh = { open: seq > kindSeq.open, closed: seq > kindSeq.closed };
  // A file that cannot be used also clears the earlier file of its kind, so its results are not
  // mistaken for the new file's.
  for (const err of errors) if (err.kind && fresh[err.kind]) setFile(err.kind, null);
  for (const f of loaded) if (fresh[f.kind]) setFile(f.kind, f);
  for (const kind of [...errors.map((e) => e.kind), ...loaded.map((f) => f.kind)]) {
    if (kind && fresh[kind]) kindSeq[kind] = seq;
  }
  const latest = seq === loadSeq;
  const messages = errors.map((err) => err.html);
  state.loadErrors = latest ? messages : [...state.loadErrors, ...messages];
  renderStatus();
  renderAll();
  if (!inFlight) refreshDrop();
  if (!loaded.length || !latest) return;
  if (!loaded.some((f) => f.kind === 'open')) selectTab('selling');
  document.getElementById('tool-top').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function removeFile(kind) {
  setFile(kind, null);
  state.loadErrors = [];
  renderStatus();
  renderAll();
  if (!inFlight) refreshDrop();
}

// ── Rendering ──
// The same setting can appear on two tabs (tax rate, ESPP basis): show the current one on both.
function syncControls() {
  const preset = !state.customRate && TAX_RATES.some(([v]) => v === state.indiaRate);
  for (const select of els.tool.querySelectorAll('select[data-india-rate]')) {
    select.value = preset ? String(state.indiaRate) : 'custom';
    const wrap = select.closest('.controls-row').querySelector('[data-custom-wrap]');
    wrap.hidden = preset;
    const input = wrap.querySelector('input');
    if (!preset && input !== document.activeElement) {
      input.value = state.indiaRate ? String(Number((state.indiaRate * 100).toFixed(2))) : '';
    }
  }
  for (const radio of els.tool.querySelectorAll('input[name="espp-basis"], input[name="cg-espp-basis"]')) {
    radio.checked = radio.value === state.esppBasis;
  }
  for (const radio of els.tool.querySelectorAll('input[name="cost-rate"]')) {
    radio.checked = radio.value === state.costRate;
  }
}

function renderAll() {
  const cy = Number(els.tool.querySelector('#year-select').value);
  const option = returnOptions(today()).find((o) => o.cy === cy);
  syncControls();
  renderFa(cy, option);
  renderDividends(cy, option);
  renderSelling(cy, option);
  renderHistory(cy);
}

function placeholder(what) {
  return `<section class="card empty-state">
    <p style="margin:0"><strong>Load your Fidelity exports in step 2</strong> to see ${what}. They are read on your
      device and never uploaded.</p>
    <p class="small muted" style="margin:8px 0 0">For complete results load both <strong>View open lots.csv</strong>
      and <strong>View closed lots.csv</strong>. If you have never sold or transferred any shares, View open lots.csv
      alone is enough.</p>
    <p style="margin:8px 0 0"><a href="#step2" data-scroll="step2">Go to step 2 ↑</a></p>
  </section>`;
}

// Schedule FA and the dividends count sold shares for the time they were held, so they need both
// exports unless nothing was ever sold or transferred. Shown at the top of those two tabs.
function filesNoticeHtml(tab) {
  const { open, closed } = state.files;
  if (!open && !closed) return '';
  const fa = tab === 'fa';
  if (open && closed) {
    return `<div class="alert-line ok files-note"><span class="bang" aria-hidden="true">✓</span><p>Both exports are
      loaded, so ${fa ? 'Schedule FA includes the shares you hold and those you sold or transferred during the year'
        : 'the dividends include the shares you hold and those you sold, up to the sale'}.</p></div>`;
  }
  if (open) {
    return `<div class="alert-line files-note"><span class="bang" aria-hidden="true">!</span><p><strong>Sold or
      transferred any ${esc(company.short)} shares?</strong> Load <strong>View closed lots.csv</strong> too (step 1,
      Previously held shares) for the full, correct ${fa ? 'Schedule FA: it must list every share held at any time in'
        + ' the year, including those sold or transferred during it' : 'dividend income: shares you sold were paid'
        + ' every dividend whose ex-dividend date was on or before the sale date'}. <strong>Never sold or transferred
      any?</strong> Then View open lots.csv alone is complete.</p></div>`;
  }
  return `<div class="alert-line files-note"><span class="bang" aria-hidden="true">!</span><p><strong>Still hold
    ${esc(company.short)} shares?</strong> Load <strong>View open lots.csv</strong> too (step 1, Current shares): so
    far only the shares you sold are counted here.</p></div>`;
}

function newActNote(option) {
  return option?.newAct ? ' This is the first return under the Income-tax Act, 2025, and its forms are not out yet.' : '';
}

function renderFa(cy, option) {
  const head = els.tool.querySelector('#fa-head');
  const out = els.tool.querySelector('#fa-results');
  els.tool.querySelector('#fa-files').innerHTML = filesNoticeHtml('fa');
  if (!state.lots || !state.data) {
    head.hidden = true;
    out.innerHTML = placeholder('your Schedule FA rows');
    state.fa = null;
    return;
  }
  let res;
  try {
    res = computeScheduleFA({
      lots: state.lots, prices: state.data.prices, rates: state.data.rates, dividends: state.data.dividends,
      cy, today: today(), esppBasis: state.esppBasis, esppDiscount: company.esppDiscount,
      rateOverrides: state.rateOverrides,
    });
  } catch (err) {
    head.hidden = true;
    out.innerHTML = `<div class="banner warn">${esc(err.message)}</div>`;
    state.fa = null;
    return;
  }
  state.fa = res;
  head.hidden = false;
  els.tool.querySelector('#espp-basis').hidden = !state.lots.some((l) => classifyLot(l, state.data.prices,
    { esppDiscount: company.esppDiscount }).type === 'ESPP');
  els.tool.querySelector('#fa-period').innerHTML = (option?.complete
    ? `Schedule FA covers 1 January – 31 December ${cy}. The year is over, so these values are final.`
    : `Schedule FA covers 1 January – 31 December ${cy}. The year is still running, so the values are
      <strong>provisional</strong>: peak so far and value as of ${esc(longDate(res.closeDate))}. Come back after
      31 December ${cy} for the final figures.`)
    + (option?.newAct ? `${newActNote(option)} It assumes Schedule FA keeps covering the calendar year, as every
      return so far has.` : '');

  const notes = [...res.warnings];
  if (res.excluded.length) {
    notes.push(`${plural(res.excluded.length, 'lot')} ${res.excluded.length === 1 ? 'was' : 'were'} acquired after
      31 December ${cy}, so ${res.excluded.length === 1 ? 'it belongs' : 'they belong'} in the next return's Schedule FA.`);
  }
  const { stock, fx } = state.data;
  out.innerHTML = `
    <div class="result-head">
      <span class="chip ${res.final ? 'pos' : 'warn'}"><span class="dot"></span>${res.final
        ? `Final: calendar year ${cy}` : `Provisional: ${cy} so far`}</span>
      <span class="chip">${plural(res.rows.length, 'lot')} to report</span>
      <span class="small muted">SBI rates to ${esc(longDate(fx.last))} · ${esc(company.short)} prices to
        ${esc(longDate(stock.last))}</span>
    </div>
    ${notes.length ? `<div class="banner">${notes.map((n) => `<div>${n}</div>`).join('')}</div>` : ''}
    ${res.rows.length ? a2Html(res) + a3Html(res) : `<div class="banner warn">None of these lots were held during
      ${cy}, so there is nothing to report for this return.</div>`}
    ${alHtml(res)}
    ${faChecklistHtml(res)}`;
}

function workingHtml(r, res) {
  const q = shares(r.lot.quantity);
  const basis = BASIS_TEXT[r.basis];
  const items = [];
  items.push(r.initial.needsRate
    ? `Initial value: ${q} shares × ${usd(r.fmvPerShare)} (${basis}) × the SBI TT buying rate on
       ${longDate(r.lot.acquired)}, which is before the published history; type it in to calculate.`
    : `Initial value: ${q} shares × ${usd(r.fmvPerShare)} (${basis}) × ${rateText(r.initial.rate)} = ${rupees(r.initial.inr)}`);
  const p = r.peak;
  const peakDetail = {
    day: `${q} shares × ${usd(p.price)} close on ${longDate(p.date)} × ${rateText(p.rate)}`,
    closing: `${res.final ? 'the 31 December value' : 'the latest value'}, ${q} shares × ${usd(p.price)} close on
      ${longDate(p.date)} × ${rateText(p.rate)}`,
    acquired: `the value when acquired, ${q} shares × ${usd(p.price)} (${basis}) × ${rateText(p.rate)}`,
    sold: `the sale value, ${usd(p.usd)} for ${q} shares on ${longDate(p.date)} × ${rateText(p.rate)}`,
  }[p.kind];
  items.push(p.fallback
    ? `Peak value: no closing price yet after acquisition, so the acquisition value is used: ${rupees(p.inr)}`
    : `Peak value, the highest rupee value on any day ${r.sold ? 'it was held' : 'of the period'}: ${peakDetail}
      = ${rupees(p.inr)}`);
  items.push(r.sold
    ? `Closing value: nil, the shares were ${r.transferred ? 'transferred out' : 'sold'} on ${longDate(r.sold)}.`
    : `Closing value: ${usd(r.closing.price)} close on ${longDate(r.closing.date)} × ${q} shares ×
      ${rateText(r.closing.rate)} = ${rupees(r.closing.inr)}`);
  if (r.dividends.items.length) {
    items.push(`Dividends: ${r.dividends.items.map((d) => `${money(d.perShare, 4)} × ${q} shares paid
      ${longDate(d.pay)}${d.payKnown ? '' : ' (ex-date)'} × ${rateText(d.rate)} = ${
      d.exact === null ? '—' : rupees(Math.round(d.exact))}`).join('; ')}`);
  } else {
    items.push(`Dividends: none paid in ${res.cy} on these shares (a lot only gets dividends whose ex-dividend date is
      after it was acquired${r.lot.sold ? ' and not after it was sold' : ''}).`);
  }
  if (r.sold && !r.transferred) {
    items.push(`Sale proceeds: ${usd(r.proceeds.usd)} (Fidelity's proceeds, after fees) × ${rateText(r.proceeds.rate)}
      = ${rupees(r.proceeds.inr)}`);
  } else if (r.transferred) {
    items.push('Sale proceeds: none, the shares were transferred out of the account, not sold.');
  } else if (r.lot.sold) {
    items.push(`Sale proceeds: none in ${res.cy}; the shares were sold on ${longDate(r.lot.sold)}.`);
  } else {
    items.push('Sale proceeds: none, the shares are still held.');
  }
  return `<ul class="working-list">${items.map((t) => `<li>${t}</li>`).join('')}</ul>`;
}

function a2Html(res) {
  const a = res.account;
  const amounts = [];
  if (a.dividends > 0) amounts.push(['Dividend', a.dividends]);
  if (a.proceeds > 0) amounts.push(['Proceeds from sale or redemption of financial assets', a.proceeds]);
  if (!amounts.length) amounts.push(['No amount paid/credited', 0]);
  return `<section class="card">
    <div class="card-head"><h2>Schedule FA · Table A2: foreign custodial account</h2></div>
    <p class="small muted" style="margin:0 0 8px">The Fidelity account that holds the shares. Fill this table first,
      then Table A3 below.</p>
    <dl class="fixed-fields">
      <div><dt>Country/Region name and code</dt><dd>${copyText(COUNTRY)}</dd></div>
      <div><dt>Name of financial institution</dt><dd>${copyText(broker.name)}</dd></div>
      <div><dt>Address of financial institution</dt><dd>${copyText(broker.address)}</dd></div>
      <div><dt>ZIP code</dt><dd>${copyText(broker.zip)}</dd></div>
      <div><dt>Account number</dt><dd><span class="hint">Your stock plan account number, shown in NetBenefits</span></dd></div>
      <div><dt>Status</dt><dd>${copyText('Owner')}</dd></div>
      <div><dt>Account opening date</dt><dd><span class="hint">When your Fidelity account was opened: on or before
        ${a.firstLot ? dmy(a.firstLot) : 'your first lot'}, your earliest lot here</span></dd></div>
      <div><dt>Peak balance during the period</dt><dd>${copyVal(a.peak?.inr ?? null)}<span class="hint">${a.peak
        ? `on ${esc(longDate(a.peak.date))}` : ''}</span></dd></div>
      <div><dt>Closing balance</dt><dd>${copyVal(a.closing.inr)}<span class="hint">${res.final ? '31 Dec'
        : `as of ${esc(longDate(a.closing.date))}`}</span></dd></div>
    </dl>
    <div class="a2-amount">
      <h3>Gross amount paid/credited to the account during the period</h3>
      <p class="small muted">In the form this column has two boxes: choose the <strong>nature of amount</strong> from
        the list, then type the <strong>amount</strong>: what was credited to the account during
        ${res.cy}${amounts.length > 1 ? `. The account received more than one kind of amount, so add one A2 row for
        each; the details and balances above repeat on every row` : ''}.</p>
      ${amounts.map(([nature, value]) => `<dl class="fixed-fields pair">
        <div><dt>Nature of amount</dt><dd>${copyText(nature)}</dd></div>
        <div><dt>Amount</dt><dd>${copyVal(value)}</dd></div>
      </dl>`).join('')}
    </div>
    <p class="small muted" style="margin:10px 0 0">Use the institution name and address printed on your Fidelity
      statement if they differ. The balances count only the shares in your exports: if the account also held cash,
      such as sale proceeds left in Fidelity's money-market fund, add it. Your statements show the account's
      value.</p>
  </section>`;
}

function a3Html(res) {
  const rows = res.rows.map((r, i) => {
    const initial = r.initial.needsRate
      ? `<label class="small">Rate on ${dmy(r.lot.acquired)}<br><input class="rate-input" type="number" min="1"
          step="0.01" inputmode="decimal" data-rate-lot="${r.lot.id}" placeholder="SBI TT buy"
          value="${esc(state.rateOverrides[r.lot.id] ?? '')}"></label>`
      : copyVal(r.initial.inr);
    return `<tr>
      <td>${i + 1}</td>
      <td class="left lotcell">${copyText(dmy(r.lot.acquired))}<span class="sub"><span
        class="type-badge ${r.type === 'ESPP' ? 'espp' : ''}">${r.type}</span>${shares(r.lot.quantity)} shares</span>${
        r.sold ? `<span class="sub">${r.transferred ? 'Transferred out' : 'Sold'} ${dmy(r.sold)}</span>` : ''}</td>
      <td>${initial}</td>
      <td>${copyVal(r.peak.inr)}</td>
      <td>${copyVal(r.closing.inr)}</td>
      <td>${copyVal(r.dividends.inr)}</td>
      <td>${copyVal(r.proceeds.inr)}</td>
      <td><button class="btn ghost small disclosure" type="button" data-working="${i}" aria-expanded="false"
        aria-controls="work-${i}"><span class="disc-label">Show maths</span><span class="chev" aria-hidden="true">▾</span></button></td>
    </tr>
    <tr class="working" id="work-${i}" hidden><td colspan="8">${workingHtml(r, res)}</td></tr>`;
  }).join('');
  const t = res.totals;
  const soldRows = res.rows.filter((r) => r.sold).length;
  return `<section class="card">
    <div class="card-head"><h2>Schedule FA · Table A3: foreign equity and debt interest</h2>
      <span class="spacer"></span><button class="btn alt small" type="button" id="download-csv">⤓ Download CSV</button></div>
    <p class="small muted" style="margin:0 0 8px">Add one row per lot: ${res.rows.length} in all${soldRows
      ? `, including ${soldRows} sold or transferred during ${res.cy} (closing balance nil)` : ''}. These five details
      are the same on every row. Click any value to copy it; <strong>Show maths</strong> opens the working for a row.</p>
    <dl class="fixed-fields">
      <div><dt>Country/Region name and code</dt><dd>${copyText(COUNTRY)}</dd></div>
      <div><dt>Name of entity</dt><dd>${copyText(company.name)}</dd></div>
      <div><dt>Address of entity</dt><dd>${copyText(company.address)}</dd></div>
      <div><dt>ZIP code</dt><dd>${copyText(company.zip)}</dd></div>
      <div><dt>Nature of entity</dt><dd>${copyText(company.nature)}</dd></div>
    </dl>
    <div class="table-scroll"><table class="fa">
      <thead><tr><th>#</th><th class="left">Date of acquiring the interest</th>
        <th>Initial value of the investment</th><th>Peak value of investment during the period</th>
        <th>Closing balance</th><th>Total gross amount paid/credited during the period</th>
        <th>Total gross proceeds from sale or redemption</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td></td><td class="left">Total (not entered in the form)</td><td>${rupees(t.initial)}</td>
        <td>${rupees(t.peak)}</td><td>${rupees(t.closing)}</td><td>${rupees(t.dividends)}</td>
        <td>${rupees(t.proceeds)}</td><td></td></tr></tfoot>
    </table></div>
  </section>`;
}

function alHtml(res) {
  const { al } = res;
  return `<section class="card">
    <div class="card-head"><h2>Schedule AL: assets and liabilities</h2></div>
    <div class="alert-line"><span class="bang" aria-hidden="true">!</span><p><strong>Only if your total income is above
      ₹1 crore.</strong> With a total income of ₹1 crore or less, ITR-2 does not ask for Schedule AL: skip this.</p></div>
    <p style="margin:10px 0 0">Report these shares at cost under <strong>Movable assets → Financial assets → Shares and
      securities</strong>, added to the cost of your other shares: ${copyVal(al.inr)}, the cost of
      ${plural(al.lots, 'lot')} held on 31 March ${res.cy + 1}${al.provisional
      ? ` (provisional: lots acquired up to ${esc(longDate(al.asOf))})` : ''}${al.missingRates
      ? `, excluding ${plural(al.missingRates, 'lot')} still missing a rate` : ''}.</p>
  </section>`;
}

function faChecklistHtml(res) {
  return `<section class="card">
    <div class="card-head"><h2>Before you file</h2></div>
    <ul class="check-list">
      <li>Schedule FA is for residents who are <strong>ordinarily resident (ROR)</strong>. If you were not ordinarily
        resident (RNOR) or non-resident in this year, you do not fill it in.</li>
      <li>${state.files.closed
        ? `<strong>Shares you sold</strong> are included from ${esc(state.files.closed.name)}: held during ${res.cy},
          they are reported with their sale proceeds and a nil closing balance. Their gains go in Schedule CG: see the
          <a href="#selling" data-goto="selling">Selling shares tab</a>.`
        : `<strong>Sold shares since 1 January ${res.cy}?</strong> Shares held at any time in the year must be reported
          too, with their sale proceeds: load Fidelity's <strong>View closed lots.csv</strong> as well (step 1).`}</li>
      <li><strong>Dividends are taxable income too.</strong> See the <a href="#dividends" data-goto="dividends">Dividends
        tab</a> for Schedule OS, FSI, TR and Form 67.</li>
      <li>The tax department receives details of US accounts under FATCA, so keep this export and your Fidelity
        statements with your records.</li>
      <li>The ₹10 lakh penalty for not disclosing foreign assets does not apply when their total value (other than
        immovable property) is ₹20 lakh or less, but they should still be disclosed.</li>
    </ul>
  </section>`;
}

function renderDividends(fy, option) {
  const controls = els.tool.querySelector('#div-controls');
  const out = els.tool.querySelector('#div-results');
  els.tool.querySelector('#div-files').innerHTML = filesNoticeHtml('dividends');
  if (!state.lots || !state.data) {
    controls.hidden = true;
    out.innerHTML = placeholder(`the dividends your shares received and the values for Schedule OS, FSI, TR and
      Form 67. ${esc(company.short)}'s dividend history is below`);
    state.div = null;
    return;
  }
  controls.hidden = false;
  const res = computeDividends({
    lots: state.lots, dividends: state.data.dividends, rates: state.data.rates, fy, today: today(),
    usRate: state.usRate, indiaRate: state.indiaRate,
  });
  state.div = res;
  els.tool.querySelector('#div-period').innerHTML = `Dividends paid ${esc(longDate(res.start))} – ${esc(longDate(res.end))}
    (${fyLabel(fy)}).${res.final ? '' : ` The year is still running, so only payments made so far are counted:
    the values are <strong>provisional</strong>.`}${newActNote(option)}`;

  const upcoming = res.upcoming.length ? `<p class="small muted" style="margin:10px 0 0">Declared but not paid yet in
    ${fyLabel(fy)}: ${res.upcoming.map((d) => `${money(d.amount, 4)} a share on ${esc(longDate(d.pay))} (ex-dividend
    ${esc(longDate(d.ex))})`).join('; ')}. It will count once paid.</p>` : '';
  if (!res.rows.length) {
    out.innerHTML = `<section class="card"><p style="margin:0">None of the shares in your
      export${state.files.open && state.files.closed ? 's' : ''} received a ${esc(company.short)} dividend paid in
      ${fyLabel(fy)}, so there is no dividend income to report from them.</p>${upcoming}</section>`;
    return;
  }
  const t = res.totals;
  const rows = res.rows.map((r) => `<tr>
      <td class="left">${esc(longDate(r.pay))}${r.payKnown ? '' : ' <span class="sub">ex-date; payment date unknown</span>'}</td>
      <td class="left">${esc(longDate(r.ex))}</td>
      <td>${money(r.perShare, 4)}</td>
      <td>${shares(r.shares)}</td>
      <td>${usd(r.grossUsd)}</td>
      <td>${usd(r.taxUsd)}</td>
      <td class="left">${r.rate ? `₹${r.rate.rate.toFixed(2)}<span class="sub">SBI, ${esc(longDate(r.rate.date))}</span>`
        : '<span class="muted">not available</span>'}</td>
      <td>${copyVal(r.gross)}</td>
      <td>${copyVal(r.tax)}</td>
    </tr>`).join('');
  out.innerHTML = `
    <div class="result-head">
      <span class="chip ${res.final ? 'pos' : 'warn'}"><span class="dot"></span>${res.final
        ? `Final: ${fyLabel(fy)}` : `Provisional: ${fyLabel(fy)} so far`}</span>
      <span class="chip">${plural(res.rows.length, 'payment')}</span>
      <span class="small muted">US tax withheld at ${pct(res.usRate)} · Indian tax rate ${pct(res.indiaRate)}</span>
    </div>
    ${res.missingRates ? `<div class="banner warn">${plural(res.missingRates, 'payment')} ${res.missingRates === 1
      ? 'is' : 'are'} older than the SBI rate history, so ${res.missingRates === 1 ? 'it is' : 'they are'} left out
      of the totals.</div>` : ''}
    <section class="card">
      <div class="card-head"><h2>Dividends your shares received</h2></div>
      <p class="small muted" style="margin:0 0 8px">Every ${esc(company.short)} dividend paid in ${fyLabel(fy)} on the
        shares in your export${state.files.closed ? 's, including shares sold on or after the ex-dividend date' : ''},
        before and after the US tax. Each payment is converted at SBI's rate on the last day of the month before it
        was paid (Rule 115).</p>
      <div class="table-scroll"><table class="fa div-table">
        <thead><tr><th class="left">Paid on</th><th class="left">Ex-dividend</th><th>Per share</th><th>Shares</th>
          <th>Gross</th><th>US tax</th><th class="left">Rate</th><th>Gross (₹)</th><th>US tax (₹)</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td class="left">Total</td><td></td><td></td><td></td><td>${usd(t.grossUsd)}</td><td>${usd(t.taxUsd)}</td>
          <td></td><td>${rupees(t.income)}</td><td>${rupees(t.taxPaid)}</td></tr></tfoot>
      </table></div>
      ${upcoming}
    </section>
    ${osHtml(res)}
    ${fsiHtml(res)}
    ${trHtml(res)}
    ${form67Html(res, option)}`;
}

const tinHint = '<span class="hint">Your US taxpayer number (SSN or ITIN) if you have one; otherwise your passport number</span>';

function osHtml(res) {
  return `<section class="card">
    <div class="card-head"><h2>Schedule OS: income from other sources</h2></div>
    <dl class="fixed-fields">
      <div><dt>1a(i) Dividend income [other than (ii)]</dt><dd>${copyVal(res.totals.income)}</dd></div>
    </dl>
    <p class="small muted" style="margin:10px 0 6px">Enter the gross amount, before the US tax: that tax is claimed
      back as a credit (Schedules FSI and TR and Form 67), not deducted here. Schedule OS also asks when the dividends
      were received, under <strong>Information about accrual/receipt of income from other sources</strong> →
      Dividend income:</p>
    <div class="table-scroll"><table class="fa quarters">
      <thead><tr>${QUARTERS.map((q) => `<th>${q}</th>`).join('')}</tr></thead>
      <tbody><tr>${res.quarters.map((v) => `<td>${copyVal(v)}</td>`).join('')}</tr></tbody>
    </table></div>
  </section>`;
}

function fsiHtml(res) {
  return `<section class="card">
    <div class="card-head"><h2>Schedule FSI: income from outside India</h2></div>
    <dl class="fixed-fields">
      <div><dt>Country/Region code</dt><dd>${copyText(COUNTRY)}</dd></div>
      <div><dt>Taxpayer Identification Number</dt><dd>${tinHint}</dd></div>
      <div><dt>Head of income</dt><dd>${copyText('Income from other sources')}</dd></div>
      <div><dt>Income from outside India (included in Part B-TI)</dt><dd>${copyVal(res.totals.income)}</dd></div>
      <div><dt>Tax paid outside India</dt><dd>${copyVal(res.totals.taxPaid)}</dd></div>
      <div><dt>Tax payable on such income under normal provisions in India</dt><dd>${copyVal(res.taxIndia)}<span
        class="hint">at ${pct(res.indiaRate)}</span></dd></div>
      <div><dt>Tax relief available in India (the lower of the two)</dt><dd>${copyVal(res.relief)}</dd></div>
      <div><dt>Relevant article of DTAA</dt><dd>${copyText(String(DTAA.article))}<span class="hint">Dividends</span></dd></div>
    </dl>
  </section>`;
}

function trHtml(res) {
  return `<section class="card">
    <div class="card-head"><h2>Schedule TR: summary of tax relief</h2></div>
    <dl class="fixed-fields">
      <div><dt>Country/Region code</dt><dd>${copyText(COUNTRY)}</dd></div>
      <div><dt>Taxpayer Identification Number</dt><dd>${tinHint}</dd></div>
      <div><dt>Total taxes paid outside India</dt><dd>${copyVal(res.totals.taxPaid)}</dd></div>
      <div><dt>Total tax relief available</dt><dd>${copyVal(res.relief)}</dd></div>
      <div><dt>Section under which relief claimed</dt><dd>${copyText('90')}<span class="hint">a tax treaty applies</span></dd></div>
      <div><dt>Was any of this tax refunded by the US during the year?</dt><dd>${copyText('No')}<span class="hint">unless
        the IRS refunded some</span></dd></div>
    </dl>
    <p class="small muted" style="margin:10px 0 0">Schedule TR, Schedule FSI and Form 67 must show the same amounts.</p>
  </section>`;
}

function form67Html(res, option) {
  const fy = res.fy;
  const ayEnd = `31 March ${fy + 2}`;
  const form = option?.newAct ? 'Form 44' : 'Form 67';
  return `<section class="card">
    <div class="card-head"><h2>${form}: statement of foreign income and tax</h2>
      <span class="chip info">Filed separately on the e-filing portal</span></div>
    ${option?.newAct ? `<div class="banner">From tax year 2026-27, Form 67 becomes <strong>Form 44</strong> under the
      Income-tax Act, 2025. Its fields are expected to match the ones below; the rules, including its deadline, are
      being finalised.</div>` : ''}
    <div class="deadline">
      <strong>When:</strong> file it <strong>before you submit your ITR</strong>, so the credit is matched in one pass.
      ${option?.newAct ? `The draft rules allow 12 months after the end of the tax year, if the return is filed on time.`
        : `The rules (Rule 128(9)) allow it until <strong>${ayEnd}</strong>, the end of assessment year
        ${fy + 1}-${String((fy + 2) % 100).padStart(2, '0')}, if the ITR is filed by its due date or as a belated
        return; for an updated return, file it before the updated return.`} Without it, the credit is not given.
    </div>
    <p class="small" style="margin:10px 0 6px">e-Filing portal → <strong>e-File → Income Tax Forms → File Income Tax
      Forms → ${form}</strong>. Choose the assessment year, then add these details for the United States:</p>
    <dl class="fixed-fields">
      <div><dt>Name of the country/specified territory</dt><dd>${copyText('United States Of America')}</dd></div>
      <div><dt>Source of income</dt><dd>${copyText('Dividend')}</dd></div>
      <div><dt>Income from outside India</dt><dd>${copyVal(res.totals.income)}</dd></div>
      <div><dt>Tax paid outside India: Amount</dt><dd>${copyVal(res.totals.taxPaid)}</dd></div>
      <div><dt>Tax paid outside India: Rate (%)</dt><dd>${copyText((res.usRate * 100).toFixed(2))}</dd></div>
      <div><dt>Tax payable on such income under normal provisions in India</dt><dd>${copyVal(res.taxIndia)}</dd></div>
      <div><dt>Tax payable on such income under section 115JB/JC</dt><dd><span class="hint">Leave blank</span></dd></div>
      <div><dt>Credit claimed under section 90/90A: Article No. of DTAA</dt><dd>${copyText(String(DTAA.article))}</dd></div>
      <div><dt>Rate of tax as per DTAA (%)</dt><dd>${copyText(String(DTAA.rate * 100))}</dd></div>
      <div><dt>Credit claimed under section 90/90A: Amount</dt><dd>${copyVal(res.relief)}</dd></div>
      <div><dt>Credit claimed under section 91</dt><dd>${copyVal(0)}</dd></div>
      <div><dt>Total foreign tax credit claimed</dt><dd>${copyVal(res.relief)}</dd></div>
    </dl>
    <p class="small muted" style="margin:10px 0 0"><strong>Attach proof of the US tax:</strong> Fidelity's Form 1042-S,
      issued by 15 March for each calendar year (a financial year spans two of them), or your Fidelity statements
      showing each dividend and the tax withheld. Then verify the form with Aadhaar OTP or EVC.</p>
  </section>`;
}

// ── Selling shares: capital gains ──
function renderSelling(fy, option) {
  const controls = els.tool.querySelector('#cg-controls');
  const out = els.tool.querySelector('#cg-results');
  if (!state.files.closed || !state.data) {
    controls.hidden = true;
    state.cg = null;
    out.innerHTML = `<section class="card empty-state">
      <p style="margin:0"><strong>Load Fidelity's <em>View closed lots.csv</em> in step 2</strong> to see the capital
        gains on ${esc(company.short)} shares you sold. To get it, open <strong>Previously held shares</strong> in the
        same Fidelity window as in step 1, keep <strong>Asset currency</strong> and click <strong>Export</strong>. The
        file is read on your device and never uploaded.</p>
      <p style="margin:8px 0 0"><a href="#step1" data-scroll="step1">See step 1 ↑</a> · <a href="#step2"
        data-scroll="step2">Go to step 2 ↑</a></p>
    </section>`;
    return;
  }
  controls.hidden = false;
  const res = computeCapitalGains({
    lots: state.closedLots, prices: state.data.prices, rates: state.data.rates, fy, today: today(),
    esppBasis: state.esppBasis, esppDiscount: company.esppDiscount, costRate: state.costRate,
    rateOverrides: state.rateOverrides, indiaRate: state.indiaRate,
  });
  state.cg = res;
  els.tool.querySelector('#cg-espp-basis').hidden = !res.rows.some((r) => r.type === 'ESPP');
  els.tool.querySelector('#cg-period').innerHTML = `Shares sold ${esc(longDate(res.start))} – ${esc(longDate(res.end))}
    (${fyLabel(fy)}).${res.final ? '' : ' The year is still running, so this covers the sales so far.'}${newActNote(option)}`;

  const notes = [...res.warnings];
  if (res.transfers.length) {
    const one = res.transfers.length === 1;
    notes.push(`${plural(res.transfers.length, 'lot')} ${one ? 'was' : 'were'} transferred out of Fidelity in
      ${fyLabel(fy)} rather than sold. Moving shares to another account of yours is not a sale, so there is no gain on
      ${one ? 'it' : 'them'}.`);
  }
  const offered = returnOptions(today()).map((o) => o.cy);
  for (const e of res.elsewhere) {
    const one = e.count === 1;
    notes.push(`${plural(e.count, 'other lot')} in your file ${one ? 'was' : 'were'} sold or transferred in
      ${fyLabel(e.fy)}: ${offered.includes(e.fy) ? `choose the ${fyLabel(e.fy)} return above to see ${one ? 'it' : 'them'}`
        : `${one ? 'it belongs' : 'they belong'} in that year's return`}.`);
  }
  const banner = notes.length ? `<div class="banner">${notes.map((n) => `<div>${n}</div>`).join('')}</div>` : '';
  if (!res.rows.length) {
    out.innerHTML = `${banner}<section class="card"><p style="margin:0">Your file has no ${esc(company.short)} shares
      sold in ${fyLabel(fy)}, so there is no capital gain to report for this return.</p></section>`;
    return;
  }
  const count = (term) => res.rows.filter((r) => r.term === term).length;
  const { stock, fx } = state.data;
  const status = res.complete
    ? `<span class="chip ${res.final ? 'pos' : 'warn'}"><span class="dot"></span>${res.final
      ? `Final: ${fyLabel(fy)}` : `${fyLabel(fy)} so far`}</span>`
    : `<span class="chip warn"><span class="dot"></span>Incomplete: ${res.missingRates} waiting for a rate</span>`;
  const termCount = (b) => b.count + b.pending;
  out.innerHTML = `
    <div class="result-head">
      ${status}
      <span class="chip">${res.rows.length} ${res.rows.length === 1 ? 'lot' : 'lots'} sold</span>
      ${count('short') ? `<span class="chip">${count('short')} short-term</span>` : ''}
      ${count('long') ? `<span class="chip">${count('long')} long-term</span>` : ''}
      <span class="small muted">SBI rates to ${esc(longDate(fx.last))} · ${esc(company.short)} prices to
        ${esc(longDate(stock.last))}</span>
    </div>
    ${pendingHtml(res)}
    ${banner}
    ${salesHtml(res)}
    ${termCount(res.short) ? cgBlockHtml(res, 'short', true) : ''}
    ${termCount(res.long) ? cgBlockHtml(res, 'long', !termCount(res.short)) : ''}
    ${periodsHtml(res)}
    ${cgFsiHtml(res)}
    ${cgChecklistHtml(res)}`;
}

// Sales whose exchange rate is not available yet are left out of every total until it is.
function pendingHtml(res) {
  if (res.complete) return '';
  const p = res.pending;
  const items = [];
  if (p.before) {
    items.push(`${plural(p.before, 'lot')} acquired before ${esc(longDate(res.ratesFrom))}, when the SBI rate history
      starts: type SBI's TT buying rate on the acquisition date into the sale's <strong>Cost</strong> box below (your
      bank or payslip records for that vest have it).`);
  }
  if (p.later) {
    items.push(`${plural(p.later, 'lot')} acquired after ${esc(longDate(res.ratesTo))}, the latest SBI rate here (the
      rates are updated every week): type the rate into the sale's <strong>Cost</strong> box, or check back after the
      next update.`);
  }
  if (p.sale) {
    items.push(`${plural(p.sale, 'sale')} whose Rule 115 rate, for the last day of the month before the sale, is not in
      the rates yet (they run to ${esc(longDate(res.ratesTo))} and are updated every week): check back after the next
      update.`);
  }
  return `<div class="banner warn"><div><strong>Not complete yet.</strong> ${plural(res.missingRates, 'sale')}
    ${res.missingRates === 1 ? 'is' : 'are'} waiting for an exchange rate, so the Schedule CG totals, the gains by date
    of sale and Schedule FSI below leave ${res.missingRates === 1 ? 'it' : 'them'} out for now:</div>
    <ul class="pending-list">${items.map((t) => `<li>${t}</li>`).join('')}</ul></div>`;
}

function salesHtml(res) {
  const rows = res.rows.map((r, i) => {
    const sale = r.sale.rate
      ? `${copyVal(r.sale.inr)}<span class="sub">${usd(r.sale.usd)} × ₹${r.sale.rate.rate.toFixed(2)}</span>`
      : `<span class="muted">waiting for SBI's rate for ${dmy(r.sale.rateDate)}</span>`;
    let cost = '—';
    if (r.needsAcqRate) {
      cost = `<label class="small">Rate on ${dmy(r.lot.acquired)}<br><input class="rate-input" type="number" min="1"
        step="0.01" inputmode="decimal" data-rate-lot="${r.lot.id}" placeholder="SBI TT buy"
        value="${esc(state.rateOverrides[r.lot.id] ?? '')}"></label>`;
    } else if (r.cost.rate) {
      cost = `${copyVal(r.cost.inr)}<span class="sub">${usd(r.cost.usd)} × ₹${r.cost.rate.rate.toFixed(2)}</span>`;
    }
    let gain = '—';
    if (r.gain !== null) {
      gain = `${copyVal(r.gain)}${r.currency ? `<span class="sub">incl. ${rupees(r.currency)} from the rupee's
        ${r.currency > 0 ? 'fall' : 'rise'}</span>` : ''}`;
    }
    return `<tr>
      <td class="left lotcell">${dmy(r.lot.sold)}<span class="sub">${QUARTERS[r.quarter]}</span></td>
      <td class="left lotcell">${dmy(r.lot.acquired)}<span class="sub"><span class="type-badge ${r.type === 'ESPP'
        ? 'espp' : ''}">${r.type}</span>${shares(r.lot.quantity)} shares</span></td>
      <td class="left"><span class="type-badge term-${r.term}">${r.term === 'long' ? 'Long-term' : 'Short-term'}</span>
        <span class="sub">${plural(r.months, 'month')}${r.term === 'short' ? `; long-term from ${dmy(r.longFrom)}` : ''}</span></td>
      <td>${sale}</td>
      <td>${cost}</td>
      <td>${gain}</td>
      <td><button class="btn ghost small disclosure" type="button" data-working="cg-${i}" aria-expanded="false"
        aria-controls="cg-work-${i}"><span class="disc-label">Show maths</span><span class="chev" aria-hidden="true">▾</span></button></td>
    </tr>
    <tr class="working" id="cg-work-${i}" hidden><td colspan="7">${cgWorkingHtml(r, res)}</td></tr>`;
  }).join('');
  const done = res.rows.filter((r) => r.gain !== null);
  const sum = (pick) => done.reduce((a, r) => a + pick(r), 0);
  const left = res.rows.length - done.length;
  return `<section class="card">
    <div class="card-head"><h2>Shares you sold in ${fyLabel(res.fy)}</h2>
      <span class="spacer"></span><button class="btn alt small" type="button" id="download-cg-csv">⤓ Download CSV</button></div>
    <p class="small muted" style="margin:0 0 8px">One row per lot sold. The sale value is at SBI's rate for the last day
      of the month before the sale; the cost at ${res.costRate === 'sale' ? 'the same rate'
        : 'the rate on the day the shares vested or were bought'}. <strong>Show maths</strong> opens the working.</p>
    <div class="table-scroll"><table class="fa cg-table">
      <thead><tr><th class="left">Sold on</th><th class="left">Acquired</th><th class="left">Held</th>
        <th>Sale value</th><th>Cost</th><th>Gain</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td class="left">Total${left ? `<span class="sub">without the ${left} waiting for a rate</span>` : ''}</td>
        <td></td><td></td><td>${rupees(sum((r) => r.sale.inr))}</td>
        <td>${rupees(sum((r) => r.cost.inr))}</td><td>${rupees(sum((r) => r.gain))}</td><td></td></tr></tfoot>
    </table></div>
  </section>`;
}

function cgWorkingHtml(r, res) {
  const q = shares(r.lot.quantity);
  const items = [];
  const usLong = r.lot.usTerm === 'LONG';
  items.push(`Held ${plural(r.months, 'month')}, ${longDate(r.lot.acquired)} to ${longDate(r.lot.sold)}: ${
    r.term === 'long' ? 'more than 24 months, so long-term'
      : `not more than 24 months, so short-term (long-term from ${longDate(r.longFrom)})`}.${
    r.lot.usTerm && usLong !== (r.term === 'long') ? ` Fidelity shows “${usLong ? 'Long' : 'Short'}”: that is the US
      one-year rule, which does not count in India.` : ''}`);
  items.push(r.sale.rate
    ? `Sale value: ${usd(r.sale.usd)} (Fidelity's proceeds after fees, ${money(r.sale.perShare, 4)} a share) ×
      ${rateText(r.sale.rate)}, the rate for the last day of the month before the sale (Rule 115) = ${rupees(r.sale.inr)}`
    : `Sale value: ${usd(r.sale.usd)} × SBI's rate for ${longDate(r.sale.rateDate)}, the last day of the month before
      the sale (Rule 115), which is not in the rates yet (they run to ${longDate(res.ratesTo)}).`);
  const basis = BASIS_TEXT[r.basis];
  if (r.needsAcqRate) {
    items.push(`Cost: ${q} shares × ${money(r.fmvPerShare, 4)} (${basis}) = ${usd(r.cost.usd)} × SBI's TT buying rate
      on ${longDate(r.lot.acquired)}, which ${r.acqRateMissing === 'later'
        ? `is not in the rates yet (they run to ${longDate(res.ratesTo)})` : 'is before the published history'}; type
      it in to calculate.`);
  } else if (r.cost.rate) {
    items.push(`Cost: ${q} shares × ${money(r.fmvPerShare, 4)} (${basis}) = ${usd(r.cost.usd)} × ${rateText(r.cost.rate)}${
      res.costRate === 'sale' ? ', the sale\'s rate' : ''} = ${rupees(r.cost.inr)}`);
  }
  if (r.gain !== null) {
    let text = `Gain: ${rupees(r.sale.inr)} − ${rupees(r.cost.inr)} = ${rupees(r.gain)}.`;
    if (r.currency) {
      text += ` Of this, ${rupees(r.gain - r.currency)} is the shares' ${r.usdGain >= 0 ? 'rise' : 'fall'} of
        ${usd(Math.abs(r.usdGain))} at the sale's rate, and ${rupees(r.currency)} the rupee's ${r.currency > 0
        ? 'fall' : 'rise'} against the dollar since the shares were acquired: the ${usd(r.cost.usd)} cost × (₹${
        r.sale.rate.rate.toFixed(2)} − ₹${r.cost.rate.rate.toFixed(2)}).`;
    }
    items.push(text);
  }
  return `<ul class="working-list">${items.map((t) => `<li>${t}</li>`).join('')}</ul>`;
}

function cgBlockHtml(res, term, withNote) {
  const long = term === 'long';
  const b = long ? res.long : res.short;
  const all = b.count + b.pending;
  return `<section class="card">
    <div class="card-head"><h2>Schedule CG · ${long ? 'B8: long-term' : 'A5: short-term'} capital gains</h2>
      <span class="chip${b.pending ? ' warn' : ''}">${b.pending ? `${b.count} of ${all}` : b.count} ${all === 1 ? 'lot'
        : 'lots'}</span></div>
    <p class="small muted" style="margin:0 0 8px">${long
      ? '<strong>B. Long-term capital gains → 8. From sale of assets where B1 to B7 above are not applicable.</strong> Held more than 24 months: taxed at 12.5% without indexation (section 112).'
      : '<strong>A. Short-term capital gains → 5. From sale of assets other than at A1 or A2 or A3 or A4 above.</strong> Held 24 months or less: taxed at your slab rate.'}
      Enter the totals of these lots once; the e-filing utility works out c and e from what you type.</p>
    ${leftOutHtml(b.pending)}
    <dl class="fixed-fields">
      <div><dt>a(ii) Full value of consideration in respect of assets other than unquoted shares</dt><dd>${
        copyVal(b.consideration)}</dd></div>
      <div><dt>a(iii) Total (ic + ii)</dt><dd>${copyVal(b.consideration)}</dd></div>
      <div><dt>b(i) Cost of acquisition without indexation</dt><dd>${copyVal(b.cost)}</dd></div>
      <div><dt>b(ii) Cost of improvement without indexation</dt><dd>${copyVal(0)}</dd></div>
      <div><dt>b(iii) Expenditure wholly and exclusively in connection with transfer</dt><dd>${copyVal(0)}<span
        class="hint">Fidelity's proceeds are after fees</span></dd></div>
      <div><dt>b(iv) Total (i + ii + iii)</dt><dd>${copyVal(b.deductions)}</dd></div>
      <div><dt>c Balance (aiii – biv)</dt><dd>${copyVal(b.gain)}</dd></div>
      ${long
        ? `<div><dt>d Deduction under section 54F</dt><dd>${copyVal(0)}<span class="hint">only with a new house; see
            below</span></dd></div>
          <div><dt>e Long-term Capital Gains on assets at B8 above (8c – 8d)</dt><dd>${copyVal(b.gain)}</dd></div>`
        : `<div><dt>d Loss to be disallowed u/s 94(7) or 94(8)</dt><dd>${copyVal(0)}<span class="hint">usually
            nil</span></dd></div>
          <div><dt>e STCG on assets other than at A1 or A2 or A3 or A4 above (5c + 5d)</dt><dd>${copyVal(b.gain)}</dd></div>`}
    </dl>
    ${withNote ? `<p class="small muted" style="margin:0">Shares listed only abroad are not listed on an Indian stock
      exchange, so some CAs treat them as <em>unquoted</em> shares and enter the sale value under a(i) instead, as both
      (a) the consideration and (b) the fair market value, with a(ii) left at 0. The gain is the same either way.</p>`
      : ''}
  </section>`;
}

// A reminder on each Schedule CG card while some sales are still waiting for an exchange rate.
function leftOutHtml(n) {
  return n ? `<div class="banner warn" style="margin:0 0 10px">Not complete yet: leaves out ${plural(n, 'sale')} still
    waiting for an exchange rate (see above).</div>` : '';
}

function periodsHtml(res) {
  const s = res.setOff;
  const notes = [];
  const shortLoss = s.shortLossUsed + s.shortLossCarried;
  // Until every sale has its rate, losses may still be absorbed by the gains left out.
  if (res.complete && s.shortLossUsed) {
    notes.push(`The short-term loss of ${rupees(shortLoss)} is set off against the long-term gain${s.shortLossCarried
      ? `; the other ${rupees(s.shortLossCarried)} is carried forward` : ''}.`);
  } else if (res.complete && shortLoss) {
    notes.push(`The short-term loss of ${rupees(shortLoss)} has no gain here to be set off against, so it is carried
      forward.`);
  }
  if (res.complete && s.longLossCarried) {
    notes.push(`The long-term loss of ${rupees(s.longLossCarried)} can only be set off against long-term gains, so it
      is carried forward.`);
  }
  if (res.complete && (s.shortLossCarried || s.longLossCarried)) {
    notes.push('Losses carried forward go in Schedule CFL and can be used for 8 years, if the return is filed by its due date.');
  }
  const row = (label, values) => `<tr><td class="left">${label}</td>${values.map((v) => `<td>${copyVal(v)}</td>`).join('')}</tr>`;
  return `<section class="card">
    <div class="card-head"><h2>Schedule CG: gains by date of sale</h2></div>
    <p class="small muted" style="margin:0 0 8px">At the end of Schedule CG, <strong>Information about accrual/receipt
      of capital gain</strong> asks when the gains arose, to work out interest on late advance tax (section 234C).
      Each sale's gain goes in the period of its sale date, after losses are set off:</p>
    ${leftOutHtml(res.missingRates)}
    ${notes.length ? `<div class="banner">${notes.map((n) => `<div>${n}</div>`).join('')}</div>` : ''}
    <div class="table-scroll"><table class="fa quarters cg-periods">
      <thead><tr><th class="left">Type of capital gain</th>${QUARTERS.map((q) => `<th>${q}</th>`).join('')}</tr></thead>
      <tbody>
        ${row('3. Short-term capital gains taxable at applicable rates', res.periods.short)}
        ${row('5. Long-term capital gains taxable at the rate of 12.5%', res.periods.long)}
      </tbody>
    </table></div>
    <p class="small muted" style="margin:10px 0 0">This assumes these are your only capital gains and losses in the
      year. Other gains or losses (Indian shares, mutual funds, property) and losses brought forward change the
      set-off: the e-filing utility works it out in Schedule CG's set-off table and Schedule BFLA, which these rows
      follow.</p>
  </section>`;
}

function cgFsiHtml(res) {
  if (!res.fsi) {
    return `<section class="card">
      <div class="card-head"><h2>Schedule FSI</h2></div>
      <p class="small" style="margin:0">${res.complete
        ? 'These sales add up to a loss, so there is no capital gain from outside India to report in Schedule FSI.'
        : `The Schedule FSI values appear once every sale has its exchange rate: ${plural(res.missingRates, 'sale')}
          ${res.missingRates === 1 ? 'is' : 'are'} still waiting for one (see above).`}</p>
    </section>`;
  }
  const s = res.setOff;
  const t = res.tax;
  const parts = [];
  if (s.shortAfter) {
    parts.push(t.short === null ? `short-term ${rupees(s.shortAfter)} at your slab rate (choose it above)`
      : `short-term ${rupees(s.shortAfter)} × ${pct(t.shortRate)} = ${rupees(t.short)}`);
  }
  if (s.longAfter) {
    parts.push(`long-term ${rupees(s.longAfter)} × ${pct(t.longRate)} (12.5% plus ${t.longRate > 0.131
      ? 'surcharge and ' : ''}4% cess) = ${rupees(t.long)}`);
  }
  return `<section class="card">
    <div class="card-head"><h2>Schedule FSI: capital gains from outside India</h2></div>
    <p class="small muted" style="margin:0 0 8px">Schedule FSI lists all income from outside India. Under the United
      States (the same entry as your dividends, if you have any), add a row for <strong>Capital gains</strong>:</p>
    ${leftOutHtml(res.missingRates)}
    <dl class="fixed-fields">
      <div><dt>Country/Region code</dt><dd>${copyText(COUNTRY)}</dd></div>
      <div><dt>Taxpayer Identification Number</dt><dd>${tinHint}</dd></div>
      <div><dt>Head of income</dt><dd>${copyText('Capital Gains')}</dd></div>
      <div><dt>Income from outside India (included in Part B-TI)</dt><dd>${copyVal(res.fsi.income)}<span
        class="hint">gains after set-off</span></dd></div>
      <div><dt>Tax paid outside India</dt><dd>${copyVal(0)}<span class="hint">the US does not tax them</span></dd></div>
      <div><dt>Tax payable on such income under normal provisions in India</dt><dd>${copyVal(t.total)}<span
        class="hint">estimate</span></dd></div>
      <div><dt>Tax relief available in India</dt><dd>${copyVal(0)}</dd></div>
      <div><dt>Relevant article of DTAA</dt><dd>${copyText(String(DTAA_GAINS.article))}<span class="hint">Capital
        gains</span></dd></div>
    </dl>
    <p class="small muted" style="margin:0">Tax estimate: ${parts.join('; ')}. Fidelity does not withhold US tax on
      sales by a non-resident with a W-8BEN on file, so there is no foreign tax credit on these gains, and nothing to
      add for them in Schedule TR or Form 67.</p>
  </section>`;
}

function cgChecklistHtml(res) {
  const { fy } = res;
  return `<section class="card">
    <div class="card-head"><h2>Before you file</h2></div>
    <ul class="check-list">
      <li><strong>Short or long is India's rule:</strong> more than 24 months from vesting or purchase to sale is
        long-term. Fidelity's “Term” column uses the US one-year rule; ignore it.</li>
      <li><strong>The cost is what was taxed as salary.</strong> If your payslip or Form 16 shows a different perquisite
        value for a vest, use that value as the cost.</li>
      <li><strong>Fees.</strong> Fidelity's proceeds are after its commission and fees. If your trade confirmation shows
        the gross amount and the fees, you can enter the gross amount as the sale value and the fees under b(iii): the
        gain is the same.</li>
      <li><strong>Schedule FA too.</strong> It covers the calendar year: this return's Schedule FA lists every share held
        at any time in ${fy}, including those sold during ${fy}, with their sale proceeds. Shares sold from January to
        March ${fy + 1} appear in the next return's. See the <a href="#fa" data-goto="fa">Foreign assets tab</a>.</li>
      <li><strong>Advance tax.</strong> Tax on a gain is due with the next advance-tax instalment after the sale
        (15 June, 15 September, 15 December or 15 March; by 31 March for sales after 15 March). Paid then, there is no
        interest under section 234C.</li>
      <li><strong>Section 54F.</strong> Investing the sale value in a residential house can exempt a long-term gain,
        subject to conditions such as owning no more than one other house. Ask your CA.</li>
    </ul>
  </section>`;
}

function renderHistory(fy) {
  const box = els.tool.querySelector('#div-history');
  if (!state.data) return;
  const { stock } = state.data;
  const list = [...stock.dividends].reverse();
  const shown = state.historyAll ? list : list.slice(0, 12);
  const now = today();
  const inFy = (d) => (d.pay || d.ex) >= `${fy}-04-01` && (d.pay || d.ex) <= `${fy + 1}-03-31`;
  box.innerHTML = `
    <div class="card-head"><h2>${esc(company.short)} dividend history</h2></div>
    <p class="small muted" style="margin:0 0 8px">Cash dividends per share since ${esc(longDate(list[list.length - 1]?.ex))}.
      Source: ${esc(stock.sources?.dividends || 'company filings')}; check against
      <a href="${esc(company.ir)}" target="_blank" rel="noopener">${esc(company.short)}'s investor relations page</a>.
      Rows marked ${fyLabel(fy)} are paid in the return you chose.</p>
    <div class="table-scroll"><table class="fa history">
      <thead><tr><th class="left">Declared</th><th class="left">Ex-dividend</th><th class="left">Record</th>
        <th class="left">Paid</th><th>Per share</th></tr></thead>
      <tbody>${shown.map((d) => `<tr class="${inFy(d) ? 'in-fy' : ''}">
        <td class="left">${esc(longDate(d.declared))}</td><td class="left">${esc(longDate(d.ex))}</td>
        <td class="left">${esc(longDate(d.record))}</td>
        <td class="left">${esc(longDate(d.pay))}${(d.pay || d.ex) > now ? ' <span class="tag warn">Upcoming</span>'
          : inFy(d) ? ` <span class="tag">${fyLabel(fy)}</span>` : ''}</td>
        <td>${money(d.amount, 4)}</td></tr>`).join('')}</tbody>
    </table></div>
    ${list.length > 12 ? `<p style="margin:10px 0 0"><button class="btn alt small" type="button" id="history-toggle">${
      state.historyAll ? 'Show the latest 12' : `Show all ${list.length}`}</button></p>` : ''}`;
}

// ── Events ──
els.file.addEventListener('change', () => {
  useFiles(els.file.files);
  els.file.value = '';
});
['dragenter', 'dragover'].forEach((type) => els.drop.addEventListener(type, (e) => {
  e.preventDefault();
  els.drop.classList.add('drag');
}));
['dragleave', 'drop'].forEach((type) => els.drop.addEventListener(type, () => els.drop.classList.remove('drag')));
els.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  useFiles(e.dataTransfer?.files);
});

function goTo(tab) {
  selectTab(tab);
  document.getElementById('tool-top').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

els.status.addEventListener('click', (e) => {
  const remove = e.target.closest('[data-remove]');
  if (remove) {
    removeFile(remove.dataset.remove);
    return;
  }
  const goto = e.target.closest('[data-goto]');
  if (goto) {
    e.preventDefault();
    goTo(goto.dataset.goto);
  }
});

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

function saveCsv(csv, name) {
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadCsv() {
  saveCsv(scheduleFaCsv(state.fa, { country: COUNTRY, name: company.name, address: company.address,
    zip: company.zip, nature: company.nature }),
  `schedule-fa-table-a3-${company.short.toLowerCase()}-${state.fa.cy}.csv`);
}

function downloadCgCsv() {
  saveCsv(capitalGainsCsv(state.cg), `capital-gains-${company.short.toLowerCase()}-${fyLabel(state.cg.fy)
    .slice(3)}.csv`);
}

function wireTool() {
  els.tool.addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('button.copy-val');
    if (copyBtn) {
      if (await copy(copyBtn.dataset.copy)) {
        copyBtn.classList.add('copied');
        setTimeout(() => copyBtn.classList.remove('copied'), 1200);
        toast(`Copied ${copyBtn.dataset.copy}`);
      }
      return;
    }
    const tab = e.target.closest('[role="tab"]');
    if (tab) {
      selectTab(tab.dataset.tab);
      return;
    }
    const goto = e.target.closest('[data-goto]');
    if (goto) {
      e.preventDefault();
      goTo(goto.dataset.goto);
      return;
    }
    const scrollTo = e.target.closest('[data-scroll]');
    if (scrollTo) {
      e.preventDefault();
      document.getElementById(scrollTo.dataset.scroll)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const workBtn = e.target.closest('button[data-working]');
    if (workBtn) {
      const row = document.getElementById(workBtn.getAttribute('aria-controls'));
      row.hidden = !row.hidden;
      workBtn.setAttribute('aria-expanded', String(!row.hidden));
      workBtn.querySelector('.disc-label').textContent = row.hidden ? 'Show maths' : 'Hide maths';
      return;
    }
    if (e.target.closest('#download-csv') && state.fa) {
      downloadCsv();
      return;
    }
    if (e.target.closest('#download-cg-csv') && state.cg) {
      downloadCgCsv();
      return;
    }
    if (e.target.closest('#history-toggle')) {
      state.historyAll = !state.historyAll;
      renderHistory(Number(els.tool.querySelector('#year-select').value));
    }
  });

  els.tool.querySelector('[role="tablist"]').addEventListener('keydown', (e) => {
    const order = { ArrowRight: 1, ArrowLeft: -1 };
    const current = TABS.indexOf(document.activeElement?.dataset?.tab);
    if (current < 0) return;
    let next = null;
    if (e.key in order) next = (current + order[e.key] + TABS.length) % TABS.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = TABS.length - 1;
    if (next === null) return;
    e.preventDefault();
    selectTab(TABS[next], { focus: true });
  });

  const typedRate = (input) => {
    const typed = Number(input.value);
    return typed > 0 && typed <= 50 ? typed / 100 : null;
  };
  els.tool.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'year-select') {
      renderAll();
    } else if (t.name === 'espp-basis' || t.name === 'cg-espp-basis') {
      state.esppBasis = t.value;
      renderAll();
    } else if (t.name === 'cost-rate') {
      state.costRate = t.value;
      renderAll();
    } else if (t.matches('select[data-india-rate]')) {
      if (t.value === 'custom') {
        const input = t.closest('.controls-row').querySelector('input[data-custom-rate]');
        state.customRate = true;
        state.indiaRate = typedRate(input);
        renderAll();
        input.focus();
      } else {
        state.customRate = false;
        state.indiaRate = Number(t.value);
        renderAll();
      }
    } else if (t.id === 'us-rate') {
      state.usRate = Number(t.value);
      renderAll();
    } else if (t.matches('input[data-rate-lot]')) {
      const value = Number(t.value);
      if (value > 0) state.rateOverrides[t.dataset.rateLot] = value;
      else delete state.rateOverrides[t.dataset.rateLot];
      renderAll();
    }
  });
  els.tool.addEventListener('input', (e) => {
    if (!e.target.matches('input[data-custom-rate]')) return;
    state.customRate = true;
    state.indiaRate = typedRate(e.target);
    renderAll();
  });
}

// ── Start ──
skeleton();
fillContactLinks(els.tool);
wireTool();
selectTab(TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'fa');
renderAll();
loadData().then((data) => {
  state.data = data;
  renderAll();
}).catch((err) => {
  els.tool.querySelector('#div-history').innerHTML = `<div class="banner warn" style="margin:0">Could not load
    ${esc(company.short)}'s dividend history (${esc(err.message)}).</div>`;
});
