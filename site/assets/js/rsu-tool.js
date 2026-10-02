// RSU tool on the company pages (e.g. tax/rsu/fidelity/msft/): reads the
// broker export in the browser and shows the Schedule FA rows to fill in.
// The file never leaves the device: it is parsed here and kept in memory.
import './tax.js';
import { esc, loadJSON, siteUrl, toast } from './core.js';
import { fmtDay, istWallClock } from './fy.js';
import { parseOpenLots } from './fidelity.js';
import { classifyLot, computeScheduleFA, priceCheck, returnOptions, scheduleFaCsv, series } from './schedule-fa.js';

const COUNTRY = '2 - United States of America';
const COMPANIES = {
  MSFT: {
    name: 'Microsoft Corporation', short: 'Microsoft', address: 'One Microsoft Way, Redmond, Washington',
    zip: '98052', nature: 'Listed company', data: 'data/tax/msft.json', esppDiscount: 0.1,
    sample: 'assets/samples/fidelity-msft-open-lots-sample.csv',
  },
};
const BROKERS = {
  fidelity: { name: 'Fidelity Stock Plan Services, LLC', address: '245 Summer Street, Boston, Massachusetts', zip: '02210' },
};
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const app = document.getElementById('app');
const company = COMPANIES[app.dataset.company];
const broker = BROKERS[app.dataset.broker];
const els = {
  drop: document.getElementById('dropzone'),
  file: document.getElementById('file-input'),
  sample: document.getElementById('sample-btn'),
  status: document.getElementById('load-status'),
  step3: document.getElementById('step3-card'),
  year: document.getElementById('year-select'),
  yearNote: document.getElementById('year-note'),
  results: document.getElementById('results'),
};
const state = { lots: null, label: '', sample: false, esppBasis: 'fmv', rateOverrides: {}, data: null };
const today = () => istWallClock().toISOString().slice(0, 10);

// ── Formatting ──
const inrFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const rupees = (n) => (n === null || n === undefined ? '—' : `₹${inrFmt.format(n)}`);
const usd = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shares = (q) => q.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const dmy = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const longDate = (iso) => fmtDay(new Date(`${iso}T00:00:00Z`));
const rateText = (r) => (r ? `₹${r.rate.toFixed(2)}${r.manual ? ' (entered by you)' : ` (SBI, ${longDate(r.date)})`}` : '—');
const copyVal = (n) => (n === null || n === undefined ? '<span class="muted">—</span>'
  : `<button class="copy-val" type="button" data-copy="${n}" title="Copy ${n}">${rupees(n)}</button>`);
const copyText = (s) => `<button class="copy-val" type="button" data-copy="${esc(s)}" title="Copy">${esc(s)}</button>`;

// ── Loading ──
let dataPromise = null;
function loadData() {
  dataPromise ||= Promise.all([loadJSON(siteUrl(company.data)), loadJSON(siteUrl('data/tax/sbi-tt-buy-usd.json'))])
    .then(([stock, fx]) => ({
      stock, fx, prices: series(stock.closes), rates: series(fx.rates), dividends: stock.dividends,
    }))
    .catch((err) => { dataPromise = null; throw err; });
  return dataPromise;
}

function showStatus(html, cls = '') {
  els.status.innerHTML = `<div class="status-line ${cls}" style="margin-top:12px">${html}</div>`;
}

// A file that cannot be used also clears the previous file's results.
function fail(html) {
  showStatus(html, 'bad');
  Object.assign(state, { lots: null, result: null });
  els.step3.hidden = true;
  els.results.hidden = true;
  els.results.innerHTML = '';
}

async function useText(text, label, sample = false) {
  let parsed;
  try {
    parsed = parseOpenLots(text);
  } catch (err) {
    fail(esc(err.message));
    return;
  }
  if (parsed.currency && parsed.currency !== 'USD') {
    fail(`This export shows values in ${esc(parsed.currency)}. In Fidelity's share details window, choose
      <strong>Asset currency</strong> before clicking <strong>Export</strong>, so the values are in US dollars.`);
    return;
  }
  showStatus('Loading exchange rates and prices…');
  try {
    state.data = await loadData();
  } catch (err) {
    fail(`Could not load the exchange rates and prices (${esc(err.message)}). Please try again.`);
    return;
  }
  const check = priceCheck(parsed.lots, state.data.prices);
  if (!check.ok) {
    fail(`The cost per share in this file does not match ${esc(company.short)}'s share price in US dollars on
      the dates the shares were acquired (${check.off} of ${check.checked} lots are far off). Check that this is
      your ${esc(company.short)} export, saved with <strong>Asset currency</strong> selected.`);
    return;
  }
  Object.assign(state, { lots: parsed.lots, label, sample, rateOverrides: {} });

  const types = parsed.lots.map((l) => classifyLot(l, state.data.prices, { esppDiscount: company.esppDiscount }).type);
  const rsu = types.filter((t) => t === 'RSU').length;
  const totalShares = parsed.lots.reduce((a, l) => a + l.quantity, 0);
  const first = parsed.lots[0].acquired;
  const last = parsed.lots[parsed.lots.length - 1].acquired;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  showStatus(`${sample ? 'Loaded the <strong>sample export</strong> (made-up quantities, real Microsoft prices)'
    : `Loaded <strong>${esc(label)}</strong>`}: ${plural(parsed.lots.length, 'lot')}
    (${plural(rsu, 'RSU vest')}, ${plural(types.length - rsu, 'ESPP purchase')}), ${shares(totalShares)} shares,
    acquired ${esc(longDate(first))} – ${esc(longDate(last))}.${parsed.skipped.length
    ? ` Skipped ${plural(parsed.skipped.length, 'row')} without a quantity or cost (line ${parsed.skipped.map((s) => s.line).join(', ')}).`
    : ''}`, 'ok');

  if (!els.year.options.length) {
    els.year.innerHTML = returnOptions(today()).map((o) => `<option value="${o.cy}"${o.isDefault ? ' selected' : ''}>
      ${o.fyLabel} return (${o.yearLabel}, filed in ${o.filedIn}): shares held Jan–Dec ${o.cy}</option>`).join('');
  }
  els.step3.hidden = false;
  render();
}

async function useFile(file) {
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) {
    fail('That file is too large to be a Fidelity export. Please choose “View open lots.csv”.');
    return;
  }
  useText(await file.text(), file.name);
}

// ── Rendering ──
function yearNote(option, res) {
  const parts = [];
  if (option.complete) {
    parts.push(`Covers 1 January – 31 December ${option.cy}. The year is over, so these values are final.`);
  } else {
    parts.push(`${option.cy} is still running, so values are <strong>provisional</strong>: peak so far and value
      as of ${esc(longDate(res?.closeDate || today()))}. Come back after 31 December ${option.cy} for the final figures.`);
  }
  if (option.newAct) {
    parts.push('This is the first return under the Income-tax Act, 2025, and its forms are not out yet. It assumes '
      + 'Schedule FA keeps covering the calendar year, as every return so far has.');
  }
  return parts.join(' ');
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
    items.push(`Dividends: ${r.dividends.items.map((d) => `${usd(d.perShare)} × ${q} shares paid
      ${longDate(d.pay)}${d.payKnown ? '' : ' (ex-date)'} × ${rateText(d.rate)} = ${
      d.exact === null ? '—' : rupees(Math.round(d.exact))}`).join('; ')}`);
  } else {
    items.push(`Dividends: none paid in ${res.cy} on these shares (a lot only gets dividends whose ex-dividend date is after it was acquired).`);
  }
  items.push('Sale proceeds: none, the shares are still held.');
  return `<ul class="working-list">${items.map((t) => `<li>${t}</li>`).join('')}</ul>`;
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
      <td><button class="btn ghost small" type="button" data-working="${i}" aria-expanded="false">Working</button></td>
    </tr>
    <tr class="working" data-working-row="${i}" hidden><td colspan="8">${workingHtml(r, res)}</td></tr>`;
  }).join('');
  const t = res.totals;
  return `<section class="card">
    <div class="card-head"><h2>Schedule FA · Table A3: foreign equity and debt interest</h2>
      <span class="spacer"></span><button class="btn alt small" type="button" id="download-csv">⤓ Download CSV</button></div>
    <p class="small muted" style="margin:0 0 8px">Add one row per lot: ${res.rows.length} in all. These five details are the
      same on every row. Click any value to copy it.</p>
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

function a2Html(res) {
  const a = res.account;
  const amounts = [];
  if (a.dividends > 0) amounts.push(['Dividend', a.dividends]);
  if (a.proceeds > 0) amounts.push(['Proceeds from sale or redemption of financial assets', a.proceeds]);
  const amountRows = amounts.length
    ? amounts.map(([nature, value]) => `<div><span>Nature of amount: <strong>${esc(nature)}</strong></span>${copyVal(value)}</div>`).join('')
    : '<div><span>Nature of amount: <strong>No amount paid/credited</strong></span><span>₹0</span></div>';
  return `<section class="card">
    <div class="card-head"><h2>Schedule FA · Table A2: foreign custodial account</h2></div>
    <p class="small muted" style="margin:0 0 8px">The Fidelity account that holds the shares. Enter it once for each
      kind of amount it received; the details and balances repeat on each row.</p>
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
    <div class="amount-rows">${amountRows}</div>
    <p class="small muted" style="margin:10px 0 0">Use the institution name and address printed on your Fidelity
      statement if they differ. The balances count only the shares in this export: if the account also held cash
      (Fidelity's money-market fund) or shares you have since sold, add those. Your statements show the account's
      value.</p>
  </section>`;
}

function alHtml(res) {
  const { al } = res;
  return `<section class="card">
    <div class="card-head"><h2>Schedule AL: assets and liabilities</h2>
      <span class="hint">only if your total income is above ₹1 crore</span></div>
    <p style="margin:0">Report these shares at cost under <strong>Movable assets → Financial assets → Shares and
      securities</strong>, added to the cost of your other shares: ${copyVal(al.inr)}, the cost of ${al.lots}
      lot${al.lots === 1 ? '' : 's'} held on 31 March ${res.cy + 1}${al.provisional
      ? ` (provisional: lots acquired up to ${esc(longDate(al.asOf))})` : ''}${al.missingRates
      ? `, excluding ${al.missingRates} lot${al.missingRates === 1 ? '' : 's'} still missing a rate` : ''}.</p>
  </section>`;
}

function checklistHtml(res) {
  return `<section class="card">
    <div class="card-head"><h2>Before you file</h2></div>
    <ul class="check-list">
      <li>Use <strong>ITR-2</strong>, or ITR-3 if you have business income. ITR-1 and ITR-4 cannot report foreign assets.</li>
      <li>Schedule FA is for residents who are <strong>ordinarily resident (ROR)</strong>. If you were not ordinarily
        resident (RNOR) or non-resident in this year, you do not fill it in.</li>
      <li><strong>Sold shares since 1 January ${res.cy}?</strong> They are not in this export but must be reported too.
        Support for Fidelity's “Previously held shares” is coming next.</li>
      <li><strong>Dividends are also taxable income.</strong> They go in Schedule OS and Schedule FSI, and the US tax
        withheld is claimed in Schedule TR with Form 67. A guide for that is coming next.</li>
      <li>The tax department receives details of US accounts under FATCA, so keep this export and your Fidelity
        statements with your records.</li>
      <li>The ₹10 lakh penalty for not disclosing foreign assets does not apply when their total value (other than
        immovable property) is ₹20 lakh or less, but they should still be disclosed.</li>
    </ul>
  </section>`;
}

function render() {
  if (!state.lots || !state.data) return;
  const cy = Number(els.year.value);
  const option = returnOptions(today()).find((o) => o.cy === cy);
  let res;
  try {
    res = computeScheduleFA({
      lots: state.lots, prices: state.data.prices, rates: state.data.rates, dividends: state.data.dividends,
      cy, today: today(), esppBasis: state.esppBasis, esppDiscount: company.esppDiscount,
      rateOverrides: state.rateOverrides,
    });
  } catch (err) {
    els.yearNote.innerHTML = option ? yearNote(option, null) : '';
    els.results.hidden = false;
    els.results.innerHTML = `<div class="banner warn">${esc(err.message)}</div>`;
    return;
  }
  els.yearNote.innerHTML = option ? yearNote(option, res) : '';
  state.result = res;

  const notes = [...res.warnings];
  if (res.excluded.length) {
    notes.push(`${res.excluded.length} lot${res.excluded.length === 1 ? ' was' : 's were'} acquired after 31 December
      ${res.cy}, so ${res.excluded.length === 1 ? 'it belongs' : 'they belong'} in the next return's Schedule FA.`);
  }
  const { stock, fx } = state.data;
  els.results.hidden = false;
  els.results.innerHTML = `
    <div class="result-head">
      <span class="chip ${res.final ? 'pos' : 'warn'}"><span class="dot"></span>${res.final
        ? `Final: calendar year ${res.cy}` : `Provisional: ${res.cy} so far`}</span>
      <span class="chip">${res.rows.length} lot${res.rows.length === 1 ? '' : 's'} to report</span>
      <span class="small muted">SBI rates to ${esc(longDate(fx.last))} · ${esc(company.short)} prices to
        ${esc(longDate(stock.last))} · dividends from ${esc(stock.sources?.dividends || 'Nasdaq')}</span>
    </div>
    ${notes.length ? `<div class="banner">${notes.map((n) => `<div>${n}</div>`).join('')}</div>` : ''}
    ${res.rows.length ? a3Html(res) + a2Html(res) : `<div class="banner warn">None of these lots were held during
      ${res.cy}, so there is nothing to report for this return.</div>`}
    ${alHtml(res)}
    ${checklistHtml(res)}`;
}

// ── Events ──
els.file.addEventListener('change', () => { useFile(els.file.files[0]); els.file.value = ''; });
els.sample.addEventListener('click', async (e) => {
  e.preventDefault();
  try {
    const res = await fetch(siteUrl(company.sample), { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    useText(await res.text(), 'sample export', true);
  } catch (err) {
    fail(`Could not load the sample (${esc(err.message)}).`);
  }
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
els.year.addEventListener('change', render);
document.querySelectorAll('input[name="espp-basis"]').forEach((input) => input.addEventListener('change', () => {
  state.esppBasis = input.value;
  render();
}));

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

els.results.addEventListener('click', async (e) => {
  const copyBtn = e.target.closest('button.copy-val');
  if (copyBtn) {
    const ok = await copy(copyBtn.dataset.copy);
    if (ok) {
      copyBtn.classList.add('copied');
      setTimeout(() => copyBtn.classList.remove('copied'), 1200);
      toast(`Copied ${copyBtn.dataset.copy}`);
    }
    return;
  }
  const workBtn = e.target.closest('button[data-working]');
  if (workBtn) {
    const row = els.results.querySelector(`tr[data-working-row="${workBtn.dataset.working}"]`);
    row.hidden = !row.hidden;
    workBtn.setAttribute('aria-expanded', String(!row.hidden));
    return;
  }
  if (e.target.closest('#download-csv') && state.result) {
    const csv = scheduleFaCsv(state.result, { country: COUNTRY, name: company.name, address: company.address,
      zip: company.zip, nature: company.nature });
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `schedule-fa-table-a3-${state.result.cy}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
});
els.results.addEventListener('change', (e) => {
  const input = e.target.closest('input[data-rate-lot]');
  if (!input) return;
  const value = Number(input.value);
  if (value > 0) state.rateOverrides[input.dataset.rateLot] = value;
  else delete state.rateOverrides[input.dataset.rateLot];
  render();
});
