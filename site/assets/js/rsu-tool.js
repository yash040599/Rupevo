// RSU tool on the company pages (tax/rsu/fidelity/msft/, orcl/): reads the
// broker export in the browser and shows, in tabs, the Schedule FA values and
// the dividend income with its foreign tax credit. The file never leaves the
// device: it is parsed here and kept in memory.
import './tax.js';
import { esc, loadJSON, siteUrl, toast } from './core.js';
import { fillContactLinks } from './shell.js';
import { fmtDay, istWallClock } from './fy.js';
import { parseOpenLots } from './fidelity.js';
import { classifyLot, computeScheduleFA, priceCheck, returnOptions, scheduleFaCsv, series } from './schedule-fa.js';
import { computeDividends, DTAA, QUARTERS } from './dividends.js';

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
// Surcharge on dividend income is capped at 15%, so 35.88% is the highest rate on it.
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
const TABS = ['fa', 'dividends', 'selling'];
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MIN_BUSY_MS = 600;

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
const state = {
  lots: null, label: '', esppBasis: 'fmv', rateOverrides: {}, data: null, fa: null, div: null,
  indiaRate: 0.312, customRate: false, usRate: DTAA.rate, historyAll: false,
};
const today = () => istWallClock().toISOString().slice(0, 10);

// ── Formatting ──
const inrFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const rupees = (n) => (n === null || n === undefined ? '—' : `₹${inrFmt.format(n)}`);
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
        <button class="tab" type="button" role="tab" id="tab-dividends" aria-controls="panel-dividends" data-tab="dividends">
          <span class="tab-title">Dividends</span><span class="tab-sub">OS · FSI · TR · Form 67</span></button>
        <button class="tab" type="button" role="tab" id="tab-selling" aria-controls="panel-selling" data-tab="selling">
          <span class="tab-title">Selling shares</span><span class="tab-sub">Capital gains · next</span></button>
      </div>
    </section>

    <div class="tab-panel" role="tabpanel" id="panel-fa" aria-labelledby="tab-fa" tabindex="-1">
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

    <div class="tab-panel" role="tabpanel" id="panel-dividends" aria-labelledby="tab-dividends" tabindex="-1" hidden>
      <section class="card" id="div-controls" hidden>
        <p class="small muted" id="div-period" style="margin:0 0 10px"></p>
        <div class="controls-row">
          <label class="field">Your Indian tax rate on this income
            <select id="india-rate">${TAX_RATES.map(([v, label]) => `<option value="${v}"${v === state.indiaRate
              ? ' selected' : ''}>${label}</option>`).join('')}<option value="custom">Another rate…</option></select>
          </label>
          <label class="field" id="custom-rate-wrap" hidden>Rate in %
            <input type="number" id="custom-rate" min="0" max="50" step="0.01" inputmode="decimal" placeholder="e.g. 32">
          </label>
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

    <div class="tab-panel" role="tabpanel" id="panel-selling" aria-labelledby="tab-selling" tabindex="-1" hidden>
      ${sellingHtml()}
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
        <p><strong>Sale proceeds.</strong> Zero here, because this export holds only shares you still own.</p>
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
        <p><strong>Which shares.</strong> A lot receives a dividend if it was acquired before the ex-dividend date.
          Shares you sold are not in this export: if you sold any during the year, add the dividends they received
          before the sale (your Fidelity statements list every payment).</p>
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

function sellingHtml() {
  return `<section class="card">
    <div class="card-head"><h2>Selling shares: coming next</h2></div>
    <p style="margin:0 0 10px">This tab will work out the capital gains on ${esc(company.short)} shares you sold, from
      Fidelity's <strong>Previously held shares</strong> export:</p>
    <ul class="check-list">
      <li><strong>Schedule CG.</strong> Held more than 24 months: long-term, taxed at 12.5% without indexation.
        Otherwise short-term, at your slab rate.</li>
      <li><strong>Values.</strong> The sale price converted at SBI's TT buying rate on the last day of the month before
        the sale (Rule 115), against the cost: the value at vesting or purchase that was taxed as salary.</li>
      <li><strong>Schedule FA.</strong> The sale proceeds for the lots you sold.</li>
    </ul>
    <p class="small muted" style="margin:10px 0 0">Want it sooner? Contact me at
      <a data-contact data-contact-subject="Rupevo RSU tax: selling shares"></a>.</p>
  </section>`;
}

function itrChecklistHtml() {
  const rows = [
    ['Schedule FA', 'The shares (Table A3) and the Fidelity account (Table A2)', 'fa', 'Foreign assets'],
    ['Schedule AL', 'Only if your total income is above ₹1 crore: the cost of the shares', 'fa', 'Foreign assets'],
    ['Schedule OS', 'Dividend income, gross, with its quarterly breakup', 'dividends', 'Dividends'],
    ['Schedule FSI', 'The dividends and the US tax paid on them', 'dividends', 'Dividends'],
    ['Schedule TR', 'The foreign tax credit claimed under section 90', 'dividends', 'Dividends'],
    ['Form 67', 'Filed separately on the e-filing portal, before the ITR', 'dividends', 'Dividends'],
    ['Schedule CG', 'Gains on shares you sold', 'selling', 'Selling shares (next)'],
  ];
  return `<section class="card">
    <div class="card-head"><h2>Your ITR checklist for ${esc(company.short)} shares</h2></div>
    <div class="table-scroll"><table class="fa checklist-table">
      <thead><tr><th class="left">Where in the ITR</th><th class="left">What goes there</th><th class="left">On this page</th></tr></thead>
      <tbody>${rows.map(([where, what, tab, label]) => `<tr><td class="left"><strong>${where}</strong></td>
        <td class="left">${what}</td><td class="left"><a href="#${tab}" data-goto="${tab}">${label}</a></td></tr>`).join('')}
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

// ── Loading the file ──
function setDrop(stateName, name = '') {
  els.drop.dataset.state = stateName;
  if (els.dropName) els.dropName.textContent = name;
}

function showStatus(html, cls = '') {
  els.status.innerHTML = html ? `<div class="status-line ${cls}" style="margin-top:12px">${html}</div>` : '';
}

// A file that cannot be used also clears the previous file's results.
function fail(html) {
  showStatus(html, 'bad');
  state.lots = null;
  setDrop('idle');
  renderAll();
}

async function useText(text, label) {
  let parsed;
  try {
    parsed = parseOpenLots(text);
  } catch (err) {
    fail(esc(err.message));
    return false;
  }
  if (parsed.currency && parsed.currency !== 'USD') {
    fail(`This export shows values in ${esc(parsed.currency)}. Indian tax needs the US-dollar values, each converted
      at SBI's rate for its own date. In Fidelity's share details window, choose <strong>Asset currency</strong>
      before clicking <strong>Export</strong>.`);
    return false;
  }
  try {
    state.data = await loadData();
  } catch (err) {
    fail(`Could not load the exchange rates and prices (${esc(err.message)}). Please try again.`);
    return false;
  }
  const check = priceCheck(parsed.lots, state.data.prices);
  if (!check.ok) {
    fail(`The cost per share in this file does not match ${esc(company.short)}'s share price in US dollars on
      the dates the shares were acquired (${check.off} of ${check.checked} lots are far off). Check that this is
      your ${esc(company.short)} export, saved with <strong>Asset currency</strong> selected.`);
    return false;
  }
  Object.assign(state, { lots: parsed.lots, label, rateOverrides: {} });

  const types = parsed.lots.map((l) => classifyLot(l, state.data.prices, { esppDiscount: company.esppDiscount }).type);
  const rsu = types.filter((t) => t === 'RSU').length;
  const kinds = [rsu && plural(rsu, 'RSU vest'), types.length - rsu && plural(types.length - rsu, 'ESPP purchase')]
    .filter(Boolean).join(', ');
  const totalShares = parsed.lots.reduce((a, l) => a + l.quantity, 0);
  const first = parsed.lots[0].acquired;
  const last = parsed.lots[parsed.lots.length - 1].acquired;
  showStatus(`Loaded <strong>${esc(label)}</strong>: ${plural(parsed.lots.length, 'lot')} (${kinds}),
    ${shares(totalShares)} shares, acquired ${esc(longDate(first))} – ${esc(longDate(last))}.${parsed.skipped.length
    ? ` Skipped ${plural(parsed.skipped.length, 'row')} without a quantity or cost (line ${parsed.skipped.map((s) => s.line).join(', ')}).`
    : ''}`, 'ok');
  els.tool.querySelector('#espp-basis').hidden = rsu === types.length;
  renderAll();
  return true;
}

// Only the latest file picked may update the drop zone and scroll the page.
let loadSeq = 0;

async function useFile(file) {
  if (!file) return;
  const seq = ++loadSeq;
  if (file.size > MAX_FILE_BYTES) {
    fail('That file is too large to be a Fidelity export. Please choose “View open lots.csv”.');
    return;
  }
  setDrop('busy', file.name);
  showStatus('');
  const started = Date.now();
  let ok = false;
  try {
    const text = await file.text();
    if (seq !== loadSeq) return;
    ok = await useText(text, file.name);
  } catch (err) {
    if (seq === loadSeq) fail(`Could not read the file (${esc(err.message)}).`);
  }
  // Keep the spinner up long enough to be seen: the file is read in milliseconds.
  const wait = MIN_BUSY_MS - (Date.now() - started);
  if (wait > 0) await new Promise((resolve) => { setTimeout(resolve, wait); });
  if (!ok || seq !== loadSeq) return;
  setDrop('done', file.name);
  document.getElementById('tool-top').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Rendering ──
function renderAll() {
  const cy = Number(els.tool.querySelector('#year-select').value);
  const option = returnOptions(today()).find((o) => o.cy === cy);
  renderFa(cy, option);
  renderDividends(cy, option);
  renderHistory(cy);
}

function placeholder(what) {
  return `<section class="card empty-state">
    <p style="margin:0"><strong>Load your Fidelity export in step 2</strong> to see ${what}. The file is read on your
      device and never uploaded.</p>
    <p style="margin:8px 0 0"><a href="#step2" data-scroll="step2">Go to step 2 ↑</a></p>
  </section>`;
}

function newActNote(option) {
  return option?.newAct ? ' This is the first return under the Income-tax Act, 2025, and its forms are not out yet.' : '';
}

function renderFa(cy, option) {
  const head = els.tool.querySelector('#fa-head');
  const out = els.tool.querySelector('#fa-results');
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
    return;
  }
  state.fa = res;
  head.hidden = false;
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
  const basis = {
    cost: 'value at vesting, from your export',
    close: 'closing price on the purchase day',
    paid: 'price you paid',
    estimated: 'estimated from the price paid',
  }[r.basis];
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
  }[p.kind];
  items.push(p.fallback
    ? `Peak value: no closing price yet after acquisition, so the acquisition value is used: ${rupees(p.inr)}`
    : `Peak value, the highest rupee value on any day of the period: ${peakDetail} = ${rupees(p.inr)}`);
  items.push(`Closing value: ${usd(r.closing.price)} close on ${longDate(r.closing.date)} × ${q} shares ×
    ${rateText(r.closing.rate)} = ${rupees(r.closing.inr)}`);
  if (r.dividends.items.length) {
    items.push(`Dividends: ${r.dividends.items.map((d) => `${money(d.perShare, 4)} × ${q} shares paid
      ${longDate(d.pay)}${d.payKnown ? '' : ' (ex-date)'} × ${rateText(d.rate)} = ${
      d.exact === null ? '—' : rupees(Math.round(d.exact))}`).join('; ')}`);
  } else {
    items.push(`Dividends: none paid in ${res.cy} on these shares (a lot only gets dividends whose ex-dividend date is after it was acquired).`);
  }
  items.push('Sale proceeds: none, the shares are still held.');
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
        the list, then type the <strong>amount</strong>, here the dividends credited to the account during
        ${res.cy}${amounts.length > 1 ? `. The account received more than one kind of amount, so add one A2 row for
        each; the details and balances above repeat on every row` : ''}.</p>
      ${amounts.map(([nature, value]) => `<dl class="fixed-fields pair">
        <div><dt>Nature of amount</dt><dd>${copyText(nature)}</dd></div>
        <div><dt>Amount</dt><dd>${copyVal(value)}</dd></div>
      </dl>`).join('')}
    </div>
    <p class="small muted" style="margin:10px 0 0">Use the institution name and address printed on your Fidelity
      statement if they differ. The balances count only the shares in this export: if the account also held cash
      (Fidelity's money-market fund) or shares you have since sold, add those. Your statements show the account's
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
        class="type-badge ${r.type === 'ESPP' ? 'espp' : ''}">${r.type}</span>${shares(r.lot.quantity)} shares</span></td>
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
  return `<section class="card">
    <div class="card-head"><h2>Schedule FA · Table A3: foreign equity and debt interest</h2>
      <span class="spacer"></span><button class="btn alt small" type="button" id="download-csv">⤓ Download CSV</button></div>
    <p class="small muted" style="margin:0 0 8px">Add one row per lot: ${res.rows.length} in all. These five details are
      the same on every row. Click any value to copy it; <strong>Show maths</strong> opens the working for a row.</p>
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
      <li><strong>Sold shares since 1 January ${res.cy}?</strong> They are not in this export but must be reported too.
        Support for Fidelity's “Previously held shares” is coming next.</li>
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
    out.innerHTML = `<section class="card"><p style="margin:0">None of the shares in this export received a
      ${esc(company.short)} dividend paid in ${fyLabel(fy)}, so there is no dividend income to report from them.</p>${upcoming}</section>`;
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
        shares in this export, before and after the US tax. Each payment is converted at SBI's rate on the last day of
        the month before it was paid (Rule 115).</p>
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
  useFile(els.file.files[0]);
  els.file.value = '';
});
['dragenter', 'dragover'].forEach((type) => els.drop.addEventListener(type, (e) => {
  e.preventDefault();
  els.drop.classList.add('drag');
}));
['dragleave', 'drop'].forEach((type) => els.drop.addEventListener(type, () => els.drop.classList.remove('drag')));
els.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  useFile(e.dataTransfer?.files?.[0]);
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

function downloadCsv() {
  const csv = scheduleFaCsv(state.fa, { country: COUNTRY, name: company.name, address: company.address,
    zip: company.zip, nature: company.nature });
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `schedule-fa-table-a3-${company.short.toLowerCase()}-${state.fa.cy}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
      selectTab(goto.dataset.goto);
      document.getElementById('tool-top').scrollIntoView({ behavior: 'smooth', block: 'start' });
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

  els.tool.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'year-select') {
      renderAll();
    } else if (t.name === 'espp-basis') {
      state.esppBasis = t.value;
      renderFa(Number(els.tool.querySelector('#year-select').value),
        returnOptions(today()).find((o) => o.cy === Number(els.tool.querySelector('#year-select').value)));
    } else if (t.id === 'india-rate') {
      const custom = t.value === 'custom';
      els.tool.querySelector('#custom-rate-wrap').hidden = !custom;
      if (custom) {
        const typed = Number(els.tool.querySelector('#custom-rate').value);
        state.indiaRate = typed > 0 ? typed / 100 : null;
        els.tool.querySelector('#custom-rate').focus();
      } else {
        state.indiaRate = Number(t.value);
      }
      renderAll();
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
    if (e.target.id !== 'custom-rate') return;
    const typed = Number(e.target.value);
    state.indiaRate = typed > 0 && typed <= 50 ? typed / 100 : null;
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
