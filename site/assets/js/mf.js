// Mutual fund comparison page. Renders data/mf.json (pipeline/mf.py): groups of direct-plan funds
// ranked against their peers with the reasons, the SIP split by age and risk (mf-plan.js) and the
// lump-sum valuation check.
import {
  DASH, ago, dataUrl, esc, isNum, istDateTime, loadJSON, signedPct, sleep, store, toast, tradingDay,
} from './core.js';
import { renderShell } from './shell.js';
import { handleRefreshLink, isAdmin, startRefresh } from './admin.js';
import { openRequestModal } from './request.js';
import { pageSeed, renderTrivia } from './trivia.js';
import {
  AGE_BANDS, RISK_LEVELS, allocation, equityShare, findInOtherGroups, groupFromHash, lagOf, matchesFund,
  rupees, splitAmount, trackingGapValue,
} from './mf-plan.js';

const PLAN_KEY = 'rupevo-mf-plan';
const ASSUMED_INDEX_RETURN = 12;
const COMPONENTS = {
  index: [['tracking', 'Gap to the index', 50], ['steadiness', 'Tracking error', 20],
    ['cost', 'Expense ratio', 20], ['size', 'Fund size', 10]],
  active: [['consistency', 'Consistency', 30], ['returns', '3- and 5-year returns', 20],
    ['risk_adjusted', 'Return per unit of risk', 20], ['downside', 'Worst fall', 15], ['cost', 'Expense ratio', 15]],
};
const STATUS_LABEL = { too_new: 'Too new', no_history: 'No data', no_tracking: 'No data', no_score: 'No score', stale: 'Stale' };
const VALUATION_ORDER = ['nifty50', 'nifty100', 'next50', 'nifty500', 'totalmarket', 'largemid250', 'midcap150',
  'smallcap250', 'nifty100ew', 'nifty50ew'];
const ZONE_CHIP = { low: 'pos', mid: 'info', high: 'warn' };
const ZONE_RULE = {
  low: 'Rule of thumb: a lump sum can go in at once or over a short spell.',
  mid: 'Rule of thumb: either works; spreading it over 3 to 6 months is a common middle path.',
  high: 'Rule of thumb: spread a lump sum over 6 to 12 months.',
};

// ── Formatting ──
const signed = (v, digits) => `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}%`;
const pct2 = (v) => (isNum(v) ? signed(v, 2) : DASH);
const pct1 = (v) => (isNum(v) ? signed(v, 1) : DASH);
const gapPct = (v) => (isNum(v) ? signedPct(v, 2) : DASH);
const fall = (v) => (isNum(v) ? `−${Math.abs(v).toFixed(1)}%` : DASH);
const crore = (v) => (isNum(v) ? `₹${Math.round(v).toLocaleString('en-IN')} Cr` : DASH);
// Banded on the score as shown (rounded), so a displayed 80 is never coloured as below 80.
const scoreClass = (s) => {
  const shown = Math.round(s);
  return shown >= 80 ? 'conv-a' : shown >= 65 ? 'conv-b' : shown >= 50 ? 'conv-c' : 'conv-d';
};
const list = (items, cls = 'reasons') => (items?.length
  ? `<ul class="${cls}">${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '');
const section = (title, inner) => `<section><h3>${title}</h3>${inner}</section>`;
const kv = (pairs) => `<dl class="kv">${pairs
  .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
const isOpen = (card, fallback) => {
  const fold = card.querySelector(':scope > details.fold');
  return fold ? fold.open : fallback;
};
const td = (f, period) => f.tracking_difference?.[period];
const gapCell = (v) => (isNum(v) ? `<span class="${Math.abs(v) <= 0.2 ? 'pos' : Math.abs(v) >= 0.6 ? 'neg' : ''}">${gapPct(v)}</span>` : DASH);

function bars(rows) {
  return `<div class="bars">${rows.map(({ label, value }) => `
    <div class="bar-row${isNum(value) ? '' : ' off'}"><span>${esc(label)}</span>
      <span class="track"><span class="fill" style="width:${isNum(value) ? Math.max(0, Math.min(100, value)) : 0}%;display:block"></span></span>
      <span class="right num">${isNum(value) ? Math.round(value) : DASH}</span></div>`).join('')}</div>`;
}

function percentileText(ix) {
  if (!isNum(ix.percentile) || !ix.points) return 'Not enough history yet.';
  const since = ix.since ? tradingDay(ix.since).replace(/^\d+\s/, '') : 'April 2021';
  if (ix.percentile <= 0) return `Lower than at every month-end since ${since}.`;
  if (ix.percentile >= 100) return `Higher than at every month-end since ${since}.`;
  return ix.percentile < 50
    ? `Lower than at ${Math.round(100 - ix.percentile)}% of month-ends since ${since}.`
    : `Higher than at ${Math.round(ix.percentile)}% of month-ends since ${since}.`;
}

// ── Page ──
const app = document.getElementById('app');
const els = {
  sync: app.querySelector('#sync-bar'),
  notice: app.querySelector('#notice'),
  nav: app.querySelector('#group-nav'),
  verdict: app.querySelector('#verdict-card'),
  funds: app.querySelector('#funds-card'),
  plan: app.querySelector('#plan-card'),
  lumpsum: app.querySelector('#lumpsum-card'),
  method: app.querySelector('#method-body'),
};
const state = {
  snap: null, group: null, query: '', open: new Set(), sort: { key: 'rank', dir: 1 },
  plan: { age: 'u30', risk: 'balanced', amount: 10000 }, calc: { amount: 10000, years: 15 },
};
try {
  const saved = JSON.parse(store.get(PLAN_KEY) || '{}');
  if (AGE_BANDS.some((b) => b.key === saved.age)) state.plan.age = saved.age;
  if (RISK_LEVELS.some((r) => r.key === saved.risk)) state.plan.risk = saved.risk;
  if (isNum(saved.amount) && saved.amount >= 0) state.plan.amount = saved.amount;
} catch { /* ignore */ }

const current = () => state.snap.groups.find((g) => g.key === state.group);
const groupByKey = (key) => state.snap?.groups.find((g) => g.key === key);
const valuationOf = (g) => state.snap.valuation?.indices?.find((v) => v.key === g.valuation) || null;

renderShell('mf', { showCurrency: false, onAdminRefreshed: () => reload(true) });
document.querySelectorAll('[data-trivia]').forEach((el) => renderTrivia(el, { seed: pageSeed(), pool: el.dataset.trivia || 'market' }));

function zoneChip(ix, asButton = false) {
  if (!ix?.zone) return '';
  const inner = `<span class="dot"></span>${esc(ix.name)} P/E ${isNum(ix.pe) ? ix.pe.toFixed(1) : DASH}: ${esc(ix.zone_label)}`;
  return asButton
    ? `<button class="chip ${ZONE_CHIP[ix.zone]} chip-btn" type="button" data-scroll="lumpsum-card"
        title="See the lump-sum check below">${inner}</button>`
    : `<span class="chip ${ZONE_CHIP[ix.zone]}">${inner}</span>`;
}

function groupLink(key, label) {
  const g = groupByKey(key);
  if (!g) return '';
  return `<button class="linkish small" type="button" data-group="${esc(key)}" data-scroll="verdict-card">${
    esc(label || g.short)} ${g.kind === 'index' ? 'index funds' : 'funds'} →</button>`;
}

// ── Sync bar and notices ──
function renderSync() {
  const snap = state.snap;
  if (!snap) return;
  const ageDays = (Date.now() - new Date(snap.generated_at).getTime()) / 86400000;
  els.sync.innerHTML = `
    <span class="chip ${ageDays > 9 ? 'warn' : 'pos'}"><span class="dot"></span>Last synced ${esc(istDateTime(snap.generated_at))}</span>
    <span class="sync-meta">${esc(ago(snap.generated_at))} · NAVs and returns through ${esc(tradingDay(snap.data_through))} · AMFI data</span>
    <span class="spacer"></span>
    <span class="sync-actions">${isAdmin()
      ? '<span class="chip info" title="Admin mode is on in this browser">Admin</span><button class="btn" id="analyse-btn" type="button">Analyse now</button>'
      : '<button class="btn alt" id="request-btn" type="button" title="Ask the maintainer to refresh this comparison">Request refresh</button>'}</span>`;
  els.sync.querySelector('#analyse-btn')?.addEventListener('click', () => startRefresh('mf', { onDone: () => reload(true) }));
  els.sync.querySelector('#request-btn')?.addEventListener('click', () => openRequestModal({
    market: 'mf', title: 'Mutual Fund Comparison', generatedAt: snap.generated_at,
    dataThrough: snap.data_through, dataNoun: 'NAVs',
  }));
}

function renderNotice() {
  const notes = [];
  if (state.snap.partial) notes.push('<div class="banner warn">This is a partial test snapshot, not the full comparison.</div>');
  els.notice.innerHTML = notes.join('');
}

// ── Group switch (buttons; a grouped dropdown on phones) ──
function renderNav() {
  const kinds = [['index', 'Index funds'], ['active', 'Active funds']];
  const row = (kind, title) => {
    const groups = state.snap.groups.filter((g) => g.kind === kind);
    if (!groups.length) return '';
    return `<div class="group-row"><span class="group-kind">${title}</span>
      <div class="view-switch" role="group" aria-label="${title}">${groups.map((g) => `
        <button class="view-btn" type="button" data-group="${esc(g.key)}" aria-pressed="${g.key === state.group}"
          title="${esc(g.label)}: ${g.stats.ranked} of ${g.stats.funds} ranked"><span>${esc(g.short)}</span><span
          class="view-count">${g.stats.ranked}</span></button>`).join('')}</div></div>`;
  };
  const options = kinds.map(([kind, title]) => `<optgroup label="${title}">${state.snap.groups
    .filter((g) => g.kind === kind).map((g) => `<option value="${esc(g.key)}"${g.key === state.group ? ' selected' : ''}>${
      esc(g.short)} (${g.stats.ranked} ranked)</option>`).join('')}</optgroup>`).join('');
  els.nav.innerHTML = `<label class="field group-select">Fund group<select id="group-select">${options}</select></label>
    ${kinds.map(([kind, title]) => row(kind, title)).join('')}`;
  els.nav.querySelector('#group-select').addEventListener('change', (e) => selectGroup(e.target.value));
}

// ── Verdict: the top-ranked fund and how the decision was made ──
function renderVerdict() {
  const g = current();
  const ranked = g.funds.filter((f) => f.rank);
  const top = ranked[0];
  const val = valuationOf(g);
  const head = `<div class="verdict-head">
      <div><div class="eyebrow">${g.kind === 'index' ? 'Index funds' : 'Active funds'}${g.benchmark
        ? ` · ${g.kind === 'index' ? 'tracking' : 'benchmark'} ${esc(g.benchmark)}` : ''}</div>
        <h2 class="verdict-title">${esc(g.label)}</h2>
        <p class="verdict-about">${esc(g.about)} ${g.stats.funds} direct plan${g.stats.funds === 1 ? '' : 's'}, ${
          g.stats.ranked} ranked.</p></div>
      ${zoneChip(val, true)}
    </div>`;
  if (!top) {
    els.verdict.innerHTML = `${head}<p class="muted">None of these funds can be ranked yet:
      ${g.kind === 'index' ? 'index funds are compared once they have a 1-year record.'
        : 'active funds are compared once they have 5 years of history.'}</p>`;
    return;
  }
  const how = g.kind === 'index'
    ? `All ${g.stats.funds} funds here hold the same shares as the index, so what separates them is how faithfully
      and how cheaply they copy it. Each is scored out of 100: the gap between its return and the index's over 1 and
      3 years (50%), how steadily it tracks day to day (20%), its expense ratio (20%) and its size (10%).`
    : `These funds follow the same SEBI rules, but each manager picks different shares. The ${g.stats.ranked} with
      at least 5 years of history are scored out of 100 against each other: how often their 3-year return beat the
      category median at month-ends over the last 5 years (30%), 3- and 5-year returns (20%), return per unit of
      risk (20%), the worst fall in 5 years (15%) and the expense ratio (15%).`;
  const next = ranked.slice(1, 3).map((f) => `#${f.rank} ${esc(f.name)} (${f.score.toFixed(1)})`).join(', ');
  els.verdict.innerHTML = `${head}
    <div class="verdict-top">
      <div class="verdict-rank">#1</div>
      <div><div class="verdict-label">Top ranked of ${ranked.length}</div>
        <div class="verdict-name">${esc(top.name)}</div>
        <div class="small muted">${esc(top.amc)} · score ${top.score.toFixed(1)} out of 100</div></div>
      <button class="btn alt small verdict-open" type="button" data-open="${top.code}">Full breakdown</button>
    </div>
    <h3>How we decided</h3>
    <p>${how}</p>
    <h3>Why ${esc(top.name)} comes first</h3>
    ${list(top.reasons)}
    ${top.notes?.length ? list(top.notes, 'reasons notes') : ''}
    <div class="facts">${g.kind === 'index' ? indexFacts(g, top) : activeFacts(g, top)}</div>
    ${g.kind === 'index' ? gapCalc(g, top, ranked) : indexCheck(g)}
    <p class="small muted">${next ? `Next: ${next}. ` : ''}Rank 1 is where these rules land on the latest data, not a
      promise: scores move as returns, costs and fund sizes change. Check the scheme documents, exit load and taxes
      before investing.</p>`;
  bindGapCalc(g, top, ranked);
}

const fact = (label, value, sub) => `<div class="fact"><div class="fact-label">${label}</div>
  <div class="fact-value">${value}</div><div class="fact-sub">${sub}</div></div>`;

function indexFacts(g, top) {
  const s = g.stats;
  const three = isNum(td(top, '3y'));
  const own = three ? td(top, '3y') : td(top, '1y');
  return [
    fact('Gap to the index', isNum(own) ? `${Math.abs(own).toFixed(2)}%` : DASH,
      `${three ? 'a year over 3 years' : 'over 1 year'} · typical fund ${pct2(three ? s.median_gap_3y : s.median_gap_1y)}`),
    fact('Expense ratio', pct2(top.ter), `a year · median ${pct2(s.median_ter)}`),
    fact('Tracking error', pct2(top.tracking_error), `day-to-day wobble · median ${pct2(s.median_te)}`),
    fact('Fund size', crore(top.aum_cr), 'assets under management'),
  ].join('');
}

function activeFacts(g, top) {
  const s = g.stats;
  const c = top.consistency || {};
  return [
    fact('Consistency', c.of ? `${c.beat} of ${c.of}` : DASH, 'rolling 3-year periods above the median'),
    fact('5-year return', pct1(top.returns['5y']), `a year · median fund ${pct1(s.median_return_5y)}`),
    fact('Worst fall, 5 years', fall(top.max_drawdown), `median fund ${fall(s.median_drawdown)}`),
    fact('Expense ratio', pct2(top.ter), `a year · median ${pct2(s.median_ter)}`),
  ].join('');
}

function gapCalc() {
  return `<div class="gap-calc">
    <h3>What the gap is worth</h3>
    <div class="gap-inputs">
      <label>A SIP of ₹ <input type="number" id="gap-amount" min="500" step="500" inputmode="numeric"
        value="${state.calc.amount}" aria-label="Monthly SIP in rupees"></label>
      <label>a month for <input type="number" id="gap-years" min="1" max="40" inputmode="numeric"
        value="${state.calc.years}" aria-label="Years"> years</label>
    </div>
    <div id="gap-out"></div>
    <p class="small muted">Assumes the index returns ${ASSUMED_INDEX_RETURN}% a year and each fund keeps its
      3-year gap (its 1-year gap if that is all it has). For illustration, not a forecast.</p>
  </div>`;
}

function bindGapCalc(g, top, ranked) {
  if (g.kind !== 'index') return;
  const out = els.verdict.querySelector('#gap-out');
  const typical = isNum(td(top, '3y')) ? g.stats.median_gap_3y : g.stats.median_gap_1y;
  const widest = ranked.filter((f) => isNum(lagOf(f))).reduce((w, f) => (!w || Math.abs(lagOf(f)) > Math.abs(lagOf(w)) ? f : w), null);
  const update = () => {
    const amount = Math.max(0, Number(els.verdict.querySelector('#gap-amount').value) || 0);
    const years = Math.max(1, Math.min(40, Number(els.verdict.querySelector('#gap-years').value) || 1));
    state.calc = { amount, years };
    const own = -Math.abs(lagOf(top) ?? 0);
    const rows = [];
    if (isNum(typical)) {
      rows.push(['the typical fund here', typical, trackingGapValue(amount, years, ASSUMED_INDEX_RETURN, own, -Math.abs(typical))]);
    }
    if (widest && widest.code !== top.code) {
      rows.push([`${widest.name}, the widest gap here`, Math.abs(lagOf(widest)),
        trackingGapValue(amount, years, ASSUMED_INDEX_RETURN, own, -Math.abs(lagOf(widest)))]);
    }
    out.innerHTML = rows.length ? `<ul class="reasons">${rows.map(([who, gapSize, diff]) => `<li>
      ${esc(top.name)} would end about <strong>${rupees(Math.max(0, diff))}</strong> ahead of ${esc(who)}:
      a gap of ${gapSize.toFixed(2)}% a year against its ${Math.abs(own).toFixed(2)}%.</li>`).join('')}</ul>`
      : '<p class="small muted">Only one fund has a record here, so there is nothing to compare yet.</p>';
  };
  els.verdict.querySelectorAll('#gap-amount, #gap-years').forEach((input) => input.addEventListener('input', update));
  update();
}

function indexCheck(g) {
  const s = g.stats;
  const ic = g.index_check;
  const proxyGroup = ic ? groupByKey(ic.group) : null;
  const beat = s.beat_benchmark_5y?.of
    ? `Over 5 years, ${s.beat_benchmark_5y.beat} of ${s.beat_benchmark_5y.of} funds in this category beat their
      benchmark (AMFI returns, direct plans).` : '';
  const check = ic
    ? `For comparison, <strong>${esc(ic.name)}</strong>, a ${esc(proxyGroup?.short || '')} index fund with an expense
      ratio of ${pct2(ic.ter)}, would rank <strong>#${ic.would_rank} of ${ic.of}</strong> here on the same rules
      (it beat the category median in ${ic.consistency.beat} of ${ic.consistency.of} rolling 3-year periods).`
    : '';
  if (!beat && !check) return '';
  return `<div class="gap-calc"><h3>Index check: is an active fund worth it here?</h3>
    <p>${check} ${beat}</p></div>`;
}

// ── Funds table ──
const rankCell = (f) => (f.rank ? `<span class="rank-num">${f.rank}</span>` : `<span class="muted">${DASH}</span>`);
const fundCell = (f, open) => `<div class="stock fund-cell">
    <button class="sym" type="button" aria-expanded="${open ? 'true' : 'false'}">${esc(f.name)}</button>
    <span class="nm">${esc(f.amc)}${f.notes?.length ? ` · <span class="warn-text" title="${esc(f.notes.join(' '))}">note</span>` : ''}</span></div>`;
const scoreCell = (f) => (isNum(f.score)
  ? `<span class="grade ${scoreClass(f.score)}" title="Score ${f.score.toFixed(1)} out of 100">${Math.round(f.score)}</span>`
  : `<span class="chip" title="${esc(f.status_reason || '')}">${esc(STATUS_LABEL[f.status] || 'Not ranked')}</span>`);
const absOrNull = (v) => (isNum(v) ? Math.abs(v) : null);

const COLUMNS = {
  index: [
    { key: 'rank', label: '#', sort: (f) => f.rank, render: rankCell },
    { key: 'name', label: 'Fund', cls: 'fund', sort: (f) => f.name, render: fundCell },
    { key: 'score', label: 'Score', desc: true, title: 'Score out of 100', sort: (f) => f.score, render: scoreCell },
    { key: 'gap1', label: 'Gap 1Y', right: true, title: "1-year return minus the index's total return (smaller is better)",
      sort: (f) => absOrNull(td(f, '1y')), render: (f) => gapCell(td(f, '1y')) },
    { key: 'gap3', label: 'Gap 3Y', right: true, title: 'The same, a year, over 3 years',
      sort: (f) => absOrNull(td(f, '3y')), render: (f) => gapCell(td(f, '3y')) },
    { key: 'te', label: 'Tracking error', right: true, opt: true, title: 'How far daily returns stray from the index',
      sort: (f) => f.tracking_error, render: (f) => pct2(f.tracking_error) },
    { key: 'ter', label: 'Expense', right: true, title: 'Expense ratio, a year (direct plan)', sort: (f) => f.ter, render: (f) => pct2(f.ter) },
    { key: 'aum', label: 'Size', right: true, opt: true, desc: true, sort: (f) => f.aum_cr, render: (f) => crore(f.aum_cr) },
  ],
  active: [
    { key: 'rank', label: '#', sort: (f) => f.rank, render: rankCell },
    { key: 'name', label: 'Fund', cls: 'fund', sort: (f) => f.name, render: fundCell },
    { key: 'score', label: 'Score', desc: true, title: 'Score out of 100', sort: (f) => f.score, render: scoreCell },
    { key: 'cons', label: 'Consistency', right: true, desc: true,
      title: 'Rolling 3-year periods in which it beat the category median', sort: (f) => f.consistency?.pct,
      render: (f) => (f.consistency?.of ? `${f.consistency.beat}/${f.consistency.of}` : DASH) },
    { key: 'r3', label: '3Y', right: true, desc: true, opt: true, title: '3-year return, a year (direct plan)',
      sort: (f) => f.returns['3y'], render: (f) => pct1(f.returns['3y']) },
    { key: 'r5', label: '5Y', right: true, desc: true, title: '5-year return, a year (direct plan)',
      sort: (f) => f.returns['5y'], render: (f) => pct1(f.returns['5y']) },
    { key: 'dd', label: 'Worst fall', right: true, desc: true, opt: true, title: 'Largest fall from a peak in 5 years',
      sort: (f) => f.max_drawdown, render: (f) => fall(f.max_drawdown) },
    { key: 'ter', label: 'Expense', right: true, title: 'Expense ratio, a year (direct plan)', sort: (f) => f.ter, render: (f) => pct2(f.ter) },
    { key: 'aum', label: 'Size', right: true, opt: true, desc: true, sort: (f) => f.aum_cr, render: (f) => crore(f.aum_cr) },
  ],
};

function compare(a, b) {
  const an = a === null || a === undefined || a === '';
  const bn = b === null || b === undefined || b === '';
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  return typeof a === 'string' ? a.localeCompare(b) : a - b;
}

function sortedFunds(g, columns) {
  const col = columns.find((c) => c.key === state.sort.key) || columns[0];
  const rows = g.funds.filter((f) => matchesFund(f, state.query));
  return rows.sort((a, b) => {
    const va = col.sort(a);
    const vb = col.sort(b);
    if (va === null || va === undefined || vb === null || vb === undefined) return compare(va, vb);
    return compare(va, vb) * state.sort.dir || compare(a.rank, b.rank);
  });
}

function detail(f, g) {
  const left = [section(f.rank ? 'Why it ranks here' : 'Why it is not ranked',
    `${f.status_reason ? `<p class="muted" style="margin:0 0 8px">${esc(f.status_reason)}</p>` : ''}${list(f.reasons)}`)];
  if (f.notes?.length) left.push(section('Worth knowing', list(f.notes)));
  const ret = (p) => `${pct1(f.returns[p])} <span class="muted">vs ${pct1(f.benchmark_returns?.[p])}</span>`;
  const numbers = [
    ['Return 1 year', ret('1y')], ['Return 3 years, a year', ret('3y')],
    ['Return 5 years, a year', ret('5y')], ['Return 10 years, a year', ret('10y')],
  ];
  if (g.kind === 'index') {
    numbers.push(['Gap 1 year', gapPct(td(f, '1y'))], ['Gap 3 years, a year', gapPct(td(f, '3y'))],
      ['Gap 5 years, a year', gapPct(td(f, '5y'))],
      ['Tracking error', `${pct2(f.tracking_error)}${f.tracking_error_as_of ? ` <span class="muted">(${esc(tradingDay(f.tracking_error_as_of))})</span>` : ''}`]);
  } else {
    numbers.push(['Consistency', f.consistency?.of ? `${f.consistency.beat} of ${f.consistency.of} (${pct1(f.consistency.pct)})` : DASH],
      ['Volatility, 5 years', pct1(f.volatility)], ['Worst fall, 5 years', fall(f.max_drawdown)],
      ['Return per unit of risk', isNum(f.return_per_risk) ? f.return_per_risk.toFixed(2) : DASH]);
  }
  numbers.push(
    ['Expense ratio', `${pct2(f.ter)}${f.ter_date ? ` <span class="muted">(${esc(tradingDay(f.ter_date))})</span>` : ''}`],
    ['Fund size', crore(f.aum_cr)],
    ['NAV', isNum(f.nav) ? `₹${f.nav.toLocaleString('en-IN', { maximumFractionDigits: 4 })} <span class="muted">(${esc(tradingDay(f.nav_date))})</span>` : DASH],
    ['Direct plan since', f.since ? esc(tradingDay(f.since)) : DASH],
    ['Riskometer', esc(f.riskometer || DASH)], ['Benchmark', esc(f.benchmark || DASH)],
    ['AMFI scheme code', esc(String(f.code))], ['ISIN', esc(f.isin || DASH)],
  );
  const right = [
    section(`Score breakdown${isNum(f.score) ? ` · ${f.score.toFixed(1)}` : ''}`,
      bars(COMPONENTS[g.kind].map(([k, label, w]) => ({ label: `${label} (${w}%)`, value: f.components?.[k] })))),
    section('Key numbers', kv(numbers)),
  ];
  return `<div>${left.join('')}</div><div>${right.join('')}</div>`;
}

function renderFunds() {
  const g = current();
  const columns = COLUMNS[g.kind];
  els.funds.hidden = false;
  els.funds.innerHTML = `<details class="fold"${isOpen(els.funds, true) ? ' open' : ''}>
    <summary><h2>All ${esc(g.label)} (${g.funds.length})</h2>
      <span class="hint">Ranked funds first. Click a fund for its full breakdown.</span></summary>
    <div class="toolbar">
      <input type="search" id="fund-q" placeholder="Search fund or fund house" aria-label="Search fund or fund house"
        value="${esc(state.query)}">
      <span class="count" id="fund-count"></span>
    </div>
    <div class="table-scroll"><table class="rank">
      <thead><tr>${columns.map((c) => `<th class="${[c.right ? 'right' : '', c.opt ? 'opt' : ''].join(' ').trim()}"
        ${c.title ? `title="${esc(c.title)}"` : ''} data-key="${c.key}"><button class="sort" type="button">${esc(c.label)}</button></th>`).join('')}</tr></thead>
      <tbody></tbody></table></div>
    <div id="elsewhere"></div></details>`;
  els.funds.querySelector('#fund-q').addEventListener('input', (e) => { state.query = e.target.value; renderRows(); });
  els.funds.querySelectorAll('th[data-key]').forEach((th) => th.querySelector('button').addEventListener('click', () => {
    const col = columns.find((c) => c.key === th.dataset.key);
    state.sort = state.sort.key === col.key ? { key: col.key, dir: -state.sort.dir } : { key: col.key, dir: col.desc ? -1 : 1 };
    renderRows();
  }));
  els.funds.querySelector('tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr.row');
    if (!tr || e.target.closest('a')) return;
    toggleFund(Number(tr.dataset.code));
  });
  renderRows();
}

function renderRows() {
  const g = current();
  const columns = COLUMNS[g.kind];
  const rows = sortedFunds(g, columns);
  els.funds.querySelectorAll('th[data-key]').forEach((th) => th.setAttribute('aria-sort', th.dataset.key === state.sort.key
    ? (state.sort.dir > 0 ? 'ascending' : 'descending') : 'none'));
  els.funds.querySelector('tbody').innerHTML = rows.length ? rows.map((f) => {
    const open = state.open.has(f.code);
    return `<tr class="row${open ? ' open' : ''}${f.rank ? '' : ' unranked'}" data-code="${f.code}">${columns.map((c) =>
      `<td class="${[c.cls, c.right ? 'right' : '', c.opt ? 'opt' : ''].filter(Boolean).join(' ')}">${c.render(f, open)}</td>`).join('')}</tr>${
      open ? `<tr class="detail-row"><td colspan="${columns.length}"><div class="detail">${detail(f, g)}</div></td></tr>` : ''}`;
  }).join('') : `<tr><td colspan="${columns.length}" class="empty">No fund here matches “${esc(state.query)}”.</td></tr>`;
  els.funds.querySelector('#fund-count').textContent = rows.length === g.funds.length
    ? `${rows.length} funds` : `Showing ${rows.length} of ${g.funds.length}`;
  const elsewhere = rows.length ? [] : findInOtherGroups(state.snap.groups, g.key, state.query).slice(0, 6);
  els.funds.querySelector('#elsewhere').innerHTML = elsewhere.length
    ? `<p class="small" style="margin:8px 0 4px">Found in other groups:</p><div class="footer-row">${elsewhere.map(({ group, fund }) =>
      `<button class="btn alt small" type="button" data-group="${esc(group.key)}" data-open="${fund.code}">${
        esc(fund.name)} · ${esc(group.short)}${fund.rank ? ` #${fund.rank}` : ''}</button>`).join('')}</div>` : '';
}

function toggleFund(code, forceOpen = false) {
  if (state.open.has(code) && !forceOpen) state.open.delete(code); else state.open.add(code);
  renderRows();
}

// ── SIP split by age and risk ──
function renderPlan() {
  const { age, risk, amount } = state.plan;
  const slices = allocation(age, risk);
  const amounts = splitAmount(amount, slices);
  const equity = equityShare(age, risk);
  const riskHint = RISK_LEVELS.find((r) => r.key === risk)?.hint || '';
  const ageHint = AGE_BANDS.find((b) => b.key === age)?.horizon || '';
  const seg = (field, items, chosen) => items.map((item) => `<button class="view-btn" type="button" data-plan="${field}"
    data-value="${item.key}" aria-pressed="${item.key === chosen}">${esc(item.label)}</button>`).join('');
  const small = groupByKey('smallcap')?.stats.median_drawdown;
  const large = groupByKey('largecap')?.stats.median_drawdown;
  els.plan.hidden = false;
  els.plan.innerHTML = `<details class="fold"${isOpen(els.plan, true) ? ' open' : ''}>
    <summary><h2>SIP split by age and risk</h2><span class="hint">A rule-of-thumb starting point, by fund category</span></summary>
    <div class="plan-grid">
      <div class="plan-controls">
        <div><div class="seg-label">Your age</div><div class="view-switch seg" role="group" aria-label="Your age">${seg('age', AGE_BANDS, age)}</div>
          <p class="small muted seg-hint">${esc(ageHint)}</p></div>
        <div><div class="seg-label">How much risk can you take?</div><div class="view-switch seg" role="group" aria-label="Risk appetite">${seg('risk', RISK_LEVELS, risk)}</div>
          <p class="small muted seg-hint">${esc(riskHint)}</p></div>
        <label class="field">Monthly SIP in rupees
          <input type="number" id="plan-amount" min="0" step="500" inputmode="numeric" value="${amount}"></label>
      </div>
      <div class="plan-result">
        <div class="split-bar" role="img" aria-label="${esc(slices.filter((s) => s.pct).map((s) => `${s.label} ${s.pct}%`).join(', '))}">${
          slices.filter((s) => s.pct).map((s) => `<span class="slice-${s.key}" style="width:${s.pct}%" title="${esc(s.label)}: ${s.pct}%"></span>`).join('')}</div>
        <table class="split-table"><tbody>${slices.map((s, i) => `
          <tr${s.pct ? '' : ' class="zero"'}><td><span class="dot slice-${s.key}"></span></td>
            <td><strong>${esc(s.label)}</strong><div class="small muted">${esc(s.detail)}</div>
              ${s.pct && s.groups.length ? `<div class="slice-links">${s.groups.map((k) => groupLink(k)).join(' ')}</div>` : ''}</td>
            <td class="right num"><strong>${s.pct}%</strong></td>
            <td class="right num">${rupees(amounts[i])}</td></tr>`).join('')}</tbody></table>
        <p class="small muted" style="margin:8px 0 0">Shares ${equity}% · debt and safe savings ${100 - equity}%.</p>
      </div>
    </div>
    <div class="prose">
      <h3>How the split is built</h3>
      <ol>
        <li><strong>Shares versus safety.</strong> The share in equity funds is about 100 minus your age for a balanced
          investor, 15 points less if you are cautious and 15 more if you are aggressive. Money you will need within about
          five years belongs in the debt slice, whatever your age.</li>
        <li><strong>A low-cost core.</strong> The biggest equity slice goes to a large-cap index fund: it owns India's
          largest companies for the lowest cost, and its return stays within a small gap of the index.</li>
        <li><strong>A manager with room to move.</strong> A flexi-cap fund can shift between company sizes.</li>
        <li><strong>Mid and small caps for long horizons.</strong> They have grown faster over long stretches but fall
          harder${isNum(small) && isNum(large) ? `: in the last 5 years the median small-cap fund's worst fall was
          ${Math.abs(small).toFixed(0)}%, against ${Math.abs(large).toFixed(0)}% for large-cap funds` : ''}. Their
          slices shrink as you get older or more cautious.</li>
        <li><strong>The cushion.</strong> EPF, PPF, fixed deposits or debt funds make up the rest. Once a year, move money
          back to your split.</li>
      </ol>
      <p class="small muted">A general rule of thumb for illustration, not advice for your situation: it does not know
        your goals, income, loans, emergency fund or existing investments.</p>
    </div></details>`;
  els.plan.querySelector('#plan-amount').addEventListener('change', (e) => {
    state.plan.amount = Math.max(0, Math.round(Number(e.target.value) || 0));
    savePlan();
    renderPlan();
  });
}

function savePlan() {
  store.set(PLAN_KEY, JSON.stringify(state.plan));
}

// ── Lump sum check ──
function renderLumpSum() {
  const v = state.snap.valuation;
  const indices = (v?.indices || []).slice().sort((a, b) => VALUATION_ORDER.indexOf(a.key) - VALUATION_ORDER.indexOf(b.key));
  if (!indices.length) { els.lumpsum.hidden = true; return; }
  els.lumpsum.hidden = false;
  const row = (ix) => {
    const lo = ix.min;
    const hi = ix.max;
    const spread = isNum(lo) && isNum(hi) && hi > lo;
    const at = (x) => Math.max(0, Math.min(100, ((x - lo) / (hi - lo)) * 100)).toFixed(1);
    const linked = state.snap.groups.filter((g) => g.valuation === ix.key);
    return `<div class="val-row">
      <div class="val-name"><strong>${esc(ix.name)}</strong>
        <span class="small muted">P/E ${isNum(ix.pe) ? ix.pe.toFixed(1) : DASH} on ${esc(tradingDay(ix.date))}</span></div>
      <div class="val-range">${spread ? `<div class="range pe-range"><div class="track">
          ${isNum(ix.median) ? `<span class="tick" style="left:${at(ix.median)}%" title="Median ${ix.median.toFixed(1)}"></span>` : ''}
          <span class="marker" style="left:${at(ix.pe)}%" title="Now ${ix.pe.toFixed(1)}"></span></div>
          <div class="ends"><span>low ${lo.toFixed(1)}</span><span>median ${isNum(ix.median) ? ix.median.toFixed(1) : DASH}</span><span>high ${hi.toFixed(1)}</span></div></div>`
        : '<span class="small muted">Not enough history yet.</span>'}</div>
      <div class="val-zone">${zoneChip(ix) || '<span class="chip">No reading</span>'}
        <span class="small muted">${esc(percentileText(ix))}</span></div>
      <div class="val-rule small">${esc(ZONE_RULE[ix.zone] || 'Not enough history to judge.')}${linked.length
        ? ` <span class="val-groups">${linked.map((g) => groupLink(g.key)).join(' ')}</span>` : ''}</div>
    </div>`;
  };
  els.lumpsum.innerHTML = `<details class="fold"${isOpen(els.lumpsum, true) ? ' open' : ''}>
    <summary><h2>Lump sum check: are markets cheap or expensive?</h2>
      <span class="hint">Index P/E against its own history${v.as_of ? ` · ${esc(tradingDay(v.as_of))}` : ''}</span></summary>
    <div class="prose" style="max-width:none">
      <p>Lump sum or spread it out? A 2012 Vanguard study of the US, UK and Australian markets found that investing a
        lump sum at once beat spreading it over 12 months about two times in three, because markets rise more often than
        they fall. Spreading it out, for example through a systematic transfer plan (STP) from a liquid fund, mainly
        limits regret if prices drop soon after. A common middle path uses valuations as a tie-breaker: invest sooner
        when an index is cheaper than usual, and spread the money out when it is more expensive than usual. A SIP already
        spreads money over time, so this check matters little for SIPs.</p>
    </div>
    <div class="val-list">${indices.map(row).join('')}</div>
    <p class="small muted" style="margin:10px 0 0">Each index's price-to-earnings ratio (P/E) is compared with its own
      P/E at every month-end since April 2021: NSE has computed index P/E from consolidated profits since 31 March 2021,
      so earlier figures are not comparable. “Cheaper than usual” means lower than at least 70% of those month-ends,
      “more expensive than usual” higher than at least 70%. P/E is a rough gauge: profits can change quickly, and cheap
      can get cheaper. The Sensex group uses the Nifty 50 reading. Factor indices (momentum, low volatility, alpha) are
      left out: they swap most of their stocks at each rebalance, so their P/E history says little.</p>
  </details>`;
}

// ── How it works ──
function renderMethod() {
  const s = state.snap;
  const m = s.model || {};
  els.method.innerHTML = `<div class="prose">
    <p>The comparison covers ${s.stats.funds} direct-plan equity funds from ${s.stats.amcs} fund houses in
      ${s.stats.groups} groups, using AMFI data up to ${esc(tradingDay(s.data_through))}. Only direct plans (growth
      option) are compared: they pay no distributor commission, so they cost less than regular plans of the same fund.
      ETFs are left out (they have no direct plan and are bought on the stock exchange), as are index funds with an
      ELSS lock-in.</p>
    <h3>Index funds: same index, so cost and accuracy decide</h3>
    <p>Funds that track the same index hold the same shares. A fund is placed in a group by the index in its name
      (AMFI's benchmark label is occasionally wrong), and is scored on fixed scales so that a group where every fund is
      expensive scores low across the board:</p>
    <div class="table-scroll"><table>
      <tr><th>Part</th><th>Weight</th><th>What it measures</th><th>Scale</th></tr>
      <tr><td>Gap to the index</td><td>${m.index_weights?.tracking ?? 50}%</td><td>The fund's return minus the index's total
        return (with dividends) over 1 year and, a year, over 3 years, from AMFI's return data. A gap either way counts:
        an index fund's job is to match its index, and a fund ahead of it has usually held cash or traded at different
        times, which can as easily cost it later. A fund with only a 1-year record is pulled halfway toward the group's
        typical fund.</td><td>0% scores 100, 1% or more scores 0</td></tr>
      <tr><td>Tracking error</td><td>${m.index_weights?.steadiness ?? 20}%</td><td>How far its daily returns stray from the
        index's, published daily by AMFI.</td><td>0% scores 100, 0.5% or more scores 0</td></tr>
      <tr><td>Expense ratio</td><td>${m.index_weights?.cost ?? 20}%</td><td>The direct plan's current total expense ratio
        from AMFI: the part of the gap you can expect to continue.</td><td>0% scores 100, 1% or more scores 0</td></tr>
      <tr><td>Fund size</td><td>${m.index_weights?.size ?? 10}%</td><td>Assets under management. Larger index funds trade
        more cheaply and are less likely to be merged or closed.</td><td>₹10 crore scores 0, ₹10,000 crore or more 100</td></tr>
    </table></div>
    <p>A fund needs a 1-year return to be ranked.</p>
    <h3>Active funds: compared with their category</h3>
    <p>Active funds in one SEBI category follow the same rules but hold different shares. Each part is a percentile
      within the category (100 = best of the ranked funds), except consistency, which is a straight percentage:</p>
    <div class="table-scroll"><table>
      <tr><th>Part</th><th>Weight</th><th>What it measures</th></tr>
      <tr><td>Consistency</td><td>${m.active_weights?.consistency ?? 30}%</td><td>At each of the last ${m.lookback_months ?? 60}
        month-ends, the fund's 3-year return is compared with the category median: the share of those periods in which
        it was above the median. It rewards funds that do well most of the time, not in one lucky stretch.</td></tr>
      <tr><td>Returns</td><td>${m.active_weights?.returns ?? 20}%</td><td>3- and 5-year returns of the direct plan (AMFI).</td></tr>
      <tr><td>Return per unit of risk</td><td>${m.active_weights?.risk_adjusted ?? 20}%</td><td>5-year return divided by the
        volatility of monthly returns.</td></tr>
      <tr><td>Worst fall</td><td>${m.active_weights?.downside ?? 15}%</td><td>The largest fall from a peak in the last
        5 years, from daily NAVs.</td></tr>
      <tr><td>Expense ratio</td><td>${m.active_weights?.cost ?? 15}%</td><td>The direct plan's current expense ratio.</td></tr>
    </table></div>
    <p>A fund needs ${m.min_active_years ?? 5} years of history (at least ${m.min_windows ?? 24} rolling periods) to be
      ranked; younger funds are listed with their numbers but no rank. Each category also shows where a low-cost index
      fund would rank on the same rules, and how many funds beat their benchmark over 5 years.</p>
    <h3>Notes</h3>
    <ul>
      <li>A missing input never scores zero: that part is dropped and the others re-weighted.</li>
      <li>Small funds (under ₹${m.small_fund_crore?.index ?? 100} crore for index funds, ₹${m.small_fund_crore?.active ?? 500}
        crore for active funds) are flagged.</li>
      <li>Sources: AMFI's scheme list, fund performance data, expense ratios and tracking error; NAV history from
        mfapi.in (a free mirror of AMFI's NAVs); index P/E from NSE. Refreshed automatically every Saturday.</li>
    </ul>
    <h3>What this is not</h3>
    <p>A mechanical comparison of published numbers. It does not look at portfolios, fund managers, exit loads or
      taxes, or at your goals and situation, and past returns do not predict future ones. It is not a recommendation to
      invest in any fund.</p>
  </div>`;
}

// ── Wiring ──
function renderGroup() {
  renderNav();
  renderVerdict();
  renderFunds();
}

function renderAll() {
  renderSync();
  renderNotice();
  renderGroup();
  renderPlan();
  renderLumpSum();
  renderMethod();
  app.setAttribute('aria-busy', 'false');
}

function selectGroup(key, { openCode = null, scroll = null } = {}) {
  if (!groupByKey(key)) return;
  if (key !== state.group) {
    state.group = key;
    state.open.clear();
    state.sort = { key: 'rank', dir: 1 };
    if (openCode === null) state.query = '';
  }
  if (openCode !== null) {
    state.query = '';
    state.open.add(openCode);
  }
  const hash = `#${key}`;
  if (window.location.hash !== hash) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
  renderGroup();
  if (scroll) document.getElementById(scroll)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

app.addEventListener('click', (e) => {
  const groupBtn = e.target.closest('button[data-group]');
  if (groupBtn && state.snap) {
    e.preventDefault();
    const code = groupBtn.dataset.open ? Number(groupBtn.dataset.open) : null;
    selectGroup(groupBtn.dataset.group, { openCode: code, scroll: groupBtn.dataset.scroll || (code !== null ? 'funds-card' : null) });
    return;
  }
  const openBtn = e.target.closest('button[data-open]');
  if (openBtn && state.snap) {
    state.query = '';
    renderFunds();
    toggleFund(Number(openBtn.dataset.open), true);
    document.getElementById('funds-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const scrollBtn = e.target.closest('button[data-scroll]');
  if (scrollBtn) {
    document.getElementById(scrollBtn.dataset.scroll)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const planBtn = e.target.closest('button[data-plan]');
  if (planBtn && state.snap) {
    state.plan[planBtn.dataset.plan] = planBtn.dataset.value;
    savePlan();
    renderPlan();
  }
});

window.addEventListener('hashchange', () => {
  if (!state.snap) return;
  const key = groupFromHash(window.location.hash, state.snap.groups, state.group);
  if (key !== state.group) selectGroup(key);
});
window.addEventListener('rupevo:admin-change', renderSync);
setInterval(renderSync, 60000);

async function reload(waitForNew) {
  const before = state.snap?.generated_at;
  for (let attempt = 0; attempt < 9; attempt += 1) {
    try {
      const snap = await loadJSON(dataUrl('mf'), { bust: true });
      if (!waitForNew || snap.generated_at !== before) {
        state.snap = snap;
        if (!groupByKey(state.group)) state.group = groupFromHash(window.location.hash, snap.groups);
        renderAll();
        return true;
      }
    } catch { /* retry below */ }
    await sleep(10000);
  }
  toast('The new data has not reached the site yet — reload the page in a minute.');
  return false;
}

try {
  state.snap = await loadJSON(dataUrl('mf'));
  state.group = groupFromHash(window.location.hash, state.snap.groups);
  renderAll();
} catch (err) {
  app.setAttribute('aria-busy', 'false');
  els.notice.innerHTML = `<div class="banner error">The fund data could not be loaded (${esc(err.message)}).
    Please try again in a few minutes.</div>`;
  els.sync.innerHTML = '<span class="muted">No data available.</span>';
  els.nav.hidden = true;
  els.verdict.hidden = true;
}
// Opened from the "Refresh now" link in a refresh-request email.
handleRefreshLink('mf', { onDone: () => reload(true) });
