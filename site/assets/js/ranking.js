// Ranking page controller shared by the Nifty 100 and US pages.
// Everything renders from the published snapshot JSON (site/data/*.json). The US page combines
// two snapshots (NASDAQ-100 and NYSE top 100) through us-lists.js.
import {
  DASH, ago, currency, dataUrl, esc, isNum, istDateTime, loadJSON, money, moneyCompact,
  more, num, pct, sleep, store, toast, toned, tradingDay,
} from './core.js';
import { renderShell, showFx, syncCurrencyToggle } from './shell.js';
import { handleRefreshLink, isAdmin, startRefresh } from './admin.js';
import { icon } from './icons.js';
import { openRequestModal } from './request.js';
import { openSheet } from './sheet.js';
import { pageSeed, renderTrivia } from './trivia.js';
import {
  composeView, findElsewhere, matchesQuery, quoteLinks, US_LISTS, US_VIEWS, viewFromHash, viewOf,
} from './us-lists.js';

// ── Small HTML helpers ──
const gradePill = (cls, label, score) => (label
  ? `<span class="grade ${cls}">${esc(label)}${isNum(score) ? `<em>${num(score, 0)}</em>` : ''}</span>`
  : `<span class="muted">${DASH}</span>`);
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
const riskPill = (r) => gradePill(`risk-${slug(r.risk_grade)}`, titleCase(r.risk_grade), r.risk_score);
const titleCase = (s) => String(s || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const section = (title, inner) => `<section><h3>${title}</h3>${inner}</section>`;
const list = (items) => (items?.length
  ? `<ul class="reasons">${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '');
const kv = (pairs) => `<dl class="kv">${pairs
  .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
// The first `n` numbers, and the rest under "N more numbers".
const kvMore = (pairs, n, key) => kv(pairs.slice(0, n)) + (pairs.length > n
  ? more(key, `${pairs.length - n} more numbers`, kv(pairs.slice(n))) : '');
// Ranking tables show this many rows until "Show all"; "More columns" is remembered per browser.
const TOP_ROWS = 25;
const COLUMNS_KEY = 'rupevo-all-columns';
const allColumns = () => store.get(COLUMNS_KEY) === '1';
// Phones get a list (one row per stock), wider screens a table.
const NARROW = window.matchMedia('(max-width: 719px)');
const trendLabel = (state) => ({ GOLDEN_CROSS: 'Golden cross',
  DEATH_CROSS: 'Death cross' }[state] || DASH);
const dipCell = (v) => {
  if (!isNum(v)) return DASH;
  const cls = v >= 18 ? 'neg' : v >= 10 ? '' : 'muted';
  return `<span class="${cls}"${v >= 18 ? ' style="font-weight:700"' : ''}>${v.toFixed(1)}%</span>`;
};
const stockCell = (r) => `<div class="stock">
    <button class="sym" type="button">${esc(r.symbol)}</button>
    <span class="nm" title="${esc(r.name)}">${esc(r.name)}</span></div>`;
// US rows name their exchange when both lists are shown together.
const exTag = (r, ctx) => (ctx.multi && r.exchange ? `<span class="ex-tag ex-${slug(r.exchange)}"
      title="Listed on the ${esc(r.exchange)}">${esc(r.exchange)}</span>` : '');
const usStockCell = (r, ctx) => `<div class="stock">
    <span class="sym-line"><button class="sym" type="button">${esc(r.symbol)}</button>${exTag(r, ctx)}</span>
    <span class="nm" title="${esc(r.name)}">${esc(r.name)}</span></div>`;
const change1m = (r) => (isNum(r.return_1m_pct) ? `<span>${toned(r.return_1m_pct)} <span class="muted">1M</span></span>` : '');
// Price, the day's move and a few chips: the top of a stock's sheet.
const quote = (r, chips) => `<div class="quote">
    <div class="quote-price"><span class="quote-close">${money(r.close)}</span><span class="quote-change">${
      toned(r.change_1d_pct, 2)} <span class="muted">${r.last_date ? esc(tradingDay(r.last_date)) : 'last close'}</span></span></div>
    <div class="chip-row">${chips.filter(Boolean).join('')}</div></div>`;

function bars(rows) {
  return `<div class="bars">${rows.map(({ label, value, note, off }) => `
    <div class="bar-row${off ? ' off' : ''}"><span>${esc(label)}</span>
      <span class="track"><span class="fill" style="width:${isNum(value) ? Math.max(0, Math.min(100, value)) : 0}%;display:block"></span></span>
      <span class="right num">${isNum(value) ? num(value, 0) : DASH}</span>
      ${note ? `<span class="bar-note">${esc(note)}</span>` : ''}</div>`).join('')}</div>`;
}

function range52(r) {
  const { low_52w: lo, high_52w: hi, close } = r;
  if (!isNum(lo) || !isNum(hi) || !isNum(close) || hi <= lo) return '';
  const pos = Math.max(0, Math.min(100, ((close - lo) / (hi - lo)) * 100));
  return section('52-week range', `<div class="range">
      <div class="track"><span class="marker" style="left:${pos.toFixed(1)}%" title="Close ${esc(money(close))}"></span></div>
      <div class="ends"><span>${money(lo)}</span><span>Close ${money(close)}</span><span>${money(hi)}</span></div>
    </div>`);
}

function tile(label, value, sub = '', extra = '') {
  return `<div class="tile"><div class="tile-label">${label}</div>
    ${value ? `<div class="tile-value">${value}</div>` : ''}
    ${sub ? `<div class="tile-sub">${sub}</div>` : ''}${extra}</div>`;
}

function miniBars(rows, { scale } = {}) {
  const max = scale || Math.max(1, ...rows.map((r) => Math.abs(r.value || 0)));
  return `<div style="display:grid;gap:6px">${rows.map((r) => `
    <div class="mini-bar"><span title="${esc(r.title || r.label)}">${r.lead ? '<span class="star" title="Sector leader">★</span> ' : ''}${esc(r.label)}</span>
      <span class="track"><span class="fill ${r.tone || ''}" style="width:${(Math.abs(r.value || 0) / max * 100).toFixed(1)}%;display:block"></span></span>
      <span class="val ${r.tone || ''}">${r.text}</span></div>`).join('')}</div>`;
}

function benchTile(b, value) {
  const trend = b.above_sma_200 === true
    ? '<span class="chip pos">Above its 200-day average</span>'
    : b.above_sma_200 === false ? '<span class="chip neg">Below its 200-day average</span>' : '';
  return tile(esc(b.name), value,
    `${toned(b.change_1d_pct, 2)} on the day · 1M ${toned(b.return_1m_pct)} · 12M ${toned(b.return_12m_pct)}`,
    trend ? `<div style="margin-top:8px">${trend}</div>` : '');
}

// ── Nifty 100 ──
const INDIA_COMPONENTS = [
  ['setup', 'Setup strength'], ['trend', 'Trend structure'], ['relative_strength', 'Relative strength'],
  ['volume', 'Volume participation'], ['trend_strength', 'Trend strength (ADX)'],
  ['volatility_fit', 'Volatility fit'],
];

const INDIA = {
  key: 'india',
  native: 'INR',
  rankedTitle: 'Ranked stocks',
  rankedHint: 'Technical setups first, then 52-week dips',
  othersTitle: 'Not ranked today',
  othersHint: 'No qualifying setup, or not enough history',
  methodHint: 'Setups, technical score and risk, explained',
  searchPlaceholder: 'Search symbol or company',
  filters: [{ key: 'setup_label', all: 'All setups' }, { key: 'sector_label', all: 'All sectors' }],
  // A row of the phone list.
  listRow(r) {
    const dip = r.setup === '52W_DIP';
    const trail = dip
      ? `<span class="grade conv-d" title="Below its 52-week high">${isNum(r.below_52w_high_pct) ? `−${r.below_52w_high_pct.toFixed(1)}%` : 'Dip'}</span><span class="muted">from high</span>`
      : `${r.tech_grade ? gradePill(`conv-${slug(r.tech_grade)}`, r.tech_grade, r.tech_score) : ''}${change1m(r)}`;
    return `<span class="lr-rank">${r.rank}</span>
      <span class="lr-main"><span class="lr-title">${esc(r.symbol)}${r.sector_leader ? '<span class="star" title="Sector leader">★</span>' : ''}</span>
        <span class="lr-sub">${esc(r.name)}</span><span class="lr-sub lr-tag${dip ? ' dip' : ''}">${esc(r.setup_label || '')}</span></span>
      <span class="lr-trail">${trail}</span>`;
  },
  otherRow: (r) => `<span class="lr-main"><span class="lr-title">${esc(r.symbol)}</span><span class="lr-sub">${esc(r.name)}</span>
      <span class="lr-sub">${esc(r.status_reason || '')}</span></span><span class="lr-trail">${change1m(r)}</span>`,
  // The quote line at the top of a stock's sheet.
  sheetTop: (r) => quote(r, [
    r.setup_label ? `<span class="chip">${esc(r.setup_label)}</span>` : '',
    r.tech_grade ? `<span class="chip">Tech ${gradePill(`conv-${slug(r.tech_grade)}`, r.tech_grade, r.tech_score)}</span>` : '',
    r.risk_grade ? `<span class="chip">Risk ${riskPill(r)}</span>` : '',
    r.sector_label ? `<span class="chip">${esc(r.sector_label)}${r.sector_leader ? ' ★' : ''}</span>` : '',
  ]),
  columns: [
    { key: 'rank', label: '#', sort: (r) => r.rank, render: (r) => `<span class="rank-num">${r.rank}</span>` },
    { key: 'symbol', label: 'Stock', sort: (r) => r.symbol, render: stockCell },
    { key: 'sector', label: 'Sector', opt: true, sort: (r) => r.sector_label,
      render: (r) => `${esc(r.sector_label)}${r.sector_leader ? '<br><span class="leader-tag">SECTOR LEADER</span>' : ''}` },
    { key: 'setup', label: 'Setup', sort: (r) => r.setup_label,
      render: (r) => `<span class="setup-tag${r.setup === '52W_DIP' ? ' dip' : ''}">${esc(r.setup_label || DASH)}</span>` },
    { key: 'tech', label: 'Tech score', title: 'Technical strength 0-100 with grade A-D', desc: true,
      sort: (r) => r.tech_score,
      render: (r) => (r.tech_grade ? gradePill(`conv-${slug(r.tech_grade)}`, r.tech_grade, r.tech_score)
        : `<span class="muted" title="52-week dips are a mean-reversion screen and are not graded on technicals">${DASH}</span>`) },
    { key: 'risk', label: 'Risk', title: 'Risk 0-100, higher is riskier', desc: true,
      sort: (r) => r.risk_score, render: riskPill },
    { key: 'close', label: 'Close', align: 'right', desc: true, sort: (r) => r.close, render: (r) => money(r.close) },
    { key: 'd1', label: '1D', align: 'right', opt: true, desc: true, sort: (r) => r.change_1d_pct,
      render: (r) => toned(r.change_1d_pct, 2) },
    { key: 'm1', label: '1M', align: 'right', desc: true, sort: (r) => r.return_1m_pct,
      render: (r) => toned(r.return_1m_pct) },
    { key: 'dip', label: 'Below 52w high', align: 'right', opt: true, desc: true,
      title: 'Distance below the highest close of the last 252 sessions',
      sort: (r) => r.below_52w_high_pct, render: (r) => dipCell(r.below_52w_high_pct) },
    { key: 'rsi', label: 'RSI', align: 'right', opt: true, desc: true, sort: (r) => r.rsi,
      render: (r) => num(r.rsi, 0) },
    { key: 'rs', label: 'RS vs Nifty', align: 'right', opt: true, desc: true,
      title: '60-day return minus the NIFTY 50 return', sort: (r) => r.rs_vs_benchmark_pct,
      render: (r) => toned(r.rs_vs_benchmark_pct) },
    { key: 'why', label: 'Why', cls: 'why', render: (r) => (r.reasons?.length
      ? `${esc(r.reasons[0])}${r.reasons.length > 1 ? ` <span class="muted">+${r.reasons.length - 1} more</span>` : ''}`
      : esc(r.status_reason || '')) },
  ],

  tiles(s) {
    const technical = s.ranked.filter((r) => r.setup !== '52W_DIP').length;
    const dips = s.ranked.length - technical;
    const setups = Object.entries(s.stats.by_setup || {}).sort((a, b) => b[1] - a[1]);
    const sectors = (s.sector_strength || []).slice(0, 4).map((x) => ({
      label: x.label, value: x.mean_rs_pct, lead: x.leader,
      tone: x.mean_rs_pct >= 0 ? 'pos' : 'neg', text: toned(x.mean_rs_pct),
      title: `${x.label}: average 60-day relative strength of ${x.stocks} stocks` }));
    return [
      benchTile(s.benchmark, num(s.benchmark.close, 2, 'en-IN')),
      tile('Ranked today', `${s.stats.ranked}<span class="muted" style="font-size:15px"> / ${s.stats.scanned}</span>`,
        `${technical} technical setup${technical === 1 ? '' : 's'} · ${dips} 52-week dip${dips === 1 ? '' : 's'}`),
      tile('Setups found', '', '', `<ul class="tile-list">${setups.map(([k, v]) =>
        `<li><span>${esc(k)}</span><span class="lead">${v}</span></li>`).join('') || '<li class="muted">None today</li>'}</ul>`),
      tile('<span title="★ Top-3 sectors: their ranked stocks get a +0.5 score bonus">Sector strength vs NIFTY 50</span>',
        '', '', miniBars(sectors)),
    ].join('');
  },

  detail(r) {
    const left = [];
    if (r.status === 'ranked') {
      left.push(section('Why it ranks here', list(r.reasons)));
    } else {
      left.push(section('Status', `<p class="muted" style="margin:0">${esc(r.status_reason)}</p>`
        + (r.reasons?.length ? list(r.reasons) : '')));
    }
    if (r.components && Object.keys(r.components).length) {
      left.push(section(`Technical score · ${num(r.tech_score, 0)} (grade ${esc(r.tech_grade)})`,
        bars(INDIA_COMPONENTS.map(([k, label]) => ({ label, value: r.components[k] })))
        + (r.notes?.length ? `<div style="margin-top:10px">${list(r.notes)}</div>` : '')));
    } else if (r.setup === '52W_DIP') {
      left.push(section('Technical score', '<p class="muted" style="margin:0">Not graded — a 52-week dip is a mean-reversion screen, not a technical setup.</p>'));
    }
    if (r.risk_grade) {
      left.push(section(`Risk · ${esc(titleCase(r.risk_grade))} (${num(r.risk_score, 0)})`,
        r.risk_notes?.length ? list(r.risk_notes) : '<p class="muted" style="margin:0">No elevated risk flags.</p>'));
    }
    const right = [
      range52(r),
      section('Key numbers', kvMore([
        ['Close', money(r.close)], ['Day change', toned(r.change_1d_pct, 2)],
        ['Return 1M', toned(r.return_1m_pct)], ['Return 3M', toned(r.return_3m_pct)],
        ['Return 6M', toned(r.return_6m_pct)], ['Return 12M', toned(r.return_12m_pct)],
        ['RS vs NIFTY (60d)', toned(r.rs_vs_benchmark_pct)], ['Industry (NSE)', esc(r.industry || DASH)],
        ['Momentum (12-1)', toned(r.momentum_12_1_pct)],
        ['RS vs NIFTY (3M)', toned(r.rs_3m_pct)], ['RS vs NIFTY (6M)', toned(r.rs_6m_pct)],
        ['RSI (14)', num(r.rsi, 1)], ['ADX (14)', num(r.adx, 1)],
        ['ATR % of price', pct(r.atr_pct, 2)], ['Volume vs 20-day avg', isNum(r.volume_ratio) ? `${num(r.volume_ratio, 2)}×` : DASH],
        ['EMA 20', money(r.ema_20)], ['SMA 50', money(r.sma_50)], ['SMA 200', money(r.sma_200)],
        ['50/200-day structure', trendLabel(r.trend_state)],
        ['Weekly trend', r.weekly_trend_up === true ? 'Rising' : r.weekly_trend_up === false ? 'Falling' : DASH],
        ['Volatility (90d, ann.)', pct(r.volatility_90d_pct)], ['Max drawdown (1y)', pct(r.max_drawdown_1y_pct)],
        ['Sharpe (1y)', num(r.sharpe_1y, 2)], ['Beta vs NIFTY', num(r.beta, 2)],
        ['Avg daily traded value', moneyCompact(r.avg_turnover)], ['Last trading day', tradingDay(r.last_date)],
      ], 8, `nums-${r.symbol}`)),
      `<div class="links">
        <a href="https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(r.symbol)}" target="_blank" rel="noopener">NSE quote ↗</a>
        <a href="https://finance.yahoo.com/quote/${encodeURIComponent(`${r.symbol}.NS`)}" target="_blank" rel="noopener">Yahoo Finance ↗</a>
      </div>`,
    ];
    return `<div>${left.join('')}</div><div>${right.join('')}</div>`;
  },

  method(s) {
    return `<div class="prose">
      <p>The ranking applies the same technical model the maintainer uses privately to end-of-day
      prices for all ${s.universe.count} constituents of the ${esc(s.universe.name)}
      (constituent list as of ${esc(tradingDay(s.universe.as_of))}). It looks for four classic
      setups, then screens for stocks trading well below their 52-week high.</p>
      <h3>1. Setup detection</h3>
      <table>
        <tr><th>Setup</th><th>What the model looks for</th></tr>
        <tr><td>Breakout</td><td>Close above the 20- and 50-day highs, ideally on 1.5× average volume, above the 50- and 200-day averages.</td></tr>
        <tr><td>Pullback in uptrend</td><td>Price above a rising 200-day average, back within about 3% of the 20-day EMA or 2% of the 50-day average, RSI 40–60.</td></tr>
        <tr><td>Trend continuation</td><td>20-day EMA above the 50-day above the 200-day, without being stretched far above the 20-day EMA.</td></tr>
        <tr><td>Support reversal</td><td>Near the 200-day average or the 52-week low with RSI recovering from oversold, only once the weekly trend has turned up.</td></tr>
      </table>
      <p>Each condition met adds points; the best setup is kept if it scores at least 2. Closing near the
      52-week high adds points to breakouts and trend continuations and subtracts them from pullbacks and reversals.</p>
      <h3>2. Headroom filter</h3>
      <p>For each setup the model measures a volatility-based downside (twice the 14-day ATR, at most 5%)
      and the room left below a cap set near the 52-week high. A setup with less than twice as much room
      above as below is listed under “Not ranked today”. No price levels are published.</p>
      <h3>3. 52-week dips</h3>
      <p>Stocks without a ranked setup that close 10% or more below their highest close of the last
      252 sessions are listed after the setups, deepest first.</p>
      <h3>4. Sector leaders</h3>
      <p>Relative strength is a stock's 60-day return minus the NIFTY 50's. The three sectors with the
      highest average add 0.5 to the scores of their ranked stocks.</p>
      <h3>Technical score and risk</h3>
      <p>The technical score (0–100) blends setup strength (30%), trend structure (21%), relative strength
      (19%), volume participation (12%), trend strength from ADX (10%) and volatility fit (9%). Grades:
      A ≥ 78, B ≥ 62, C ≥ 45, D below. The risk score (0–100, higher is riskier) blends ATR, 90-day
      volatility, 1-year maximum drawdown, beta, liquidity, distance below the 52-week high and a falling
      50/200-day structure: Low below 35, Moderate below 55, High below 72, Very high above.</p>
      <h3>What this is not</h3>
      <p>This is a mechanical screen of price behaviour. It ignores fundamentals, news, results dates and
      your personal situation, and it is not a recommendation to buy or sell anything.</p>
    </div>`;
  },
};

// ── US: NASDAQ-100 and NYSE top 100 ──
const PILLAR_SHORT = {
  'Quality & profitability': 'Quality', Valuation: 'Valuation', 'Growth durability': 'Growth',
  'Long-horizon momentum': 'Momentum', 'Financial strength': 'Strength', 'Risk & drawdown': 'Risk',
};
const BAND_ORDER = ['Excellent', 'Strong', 'Average', 'Weak', 'Poor'];

function pillarExtremes(r) {
  const covered = (r.pillars || []).filter((p) => p.covered && isNum(p.score));
  if (!covered.length) return '';
  const top = covered.reduce((a, b) => (b.score > a.score ? b : a));
  const low = covered.reduce((a, b) => (b.score < a.score ? b : a));
  const name = (p) => PILLAR_SHORT[p.name] || p.name;
  return `Strongest: ${esc(name(top))} ${num(top.score, 0)}`
    + (low !== top ? ` <span class="muted">· Weakest: ${esc(name(low))} ${num(low.score, 0)}</span>` : '');
}
const pillarScore = (r, pillar) => (r.pillars || []).find((p) => p.name === pillar)?.score ?? null;

const US = {
  key: 'us',
  native: 'USD',
  lists: US_LISTS,
  views: US_VIEWS,
  rankedTitle: 'Ranked companies',
  rankedTitleFor: (s) => (s.multi ? 'Ranked companies' : `Ranked companies · ${s.lists?.[0]?.label || ''}`),
  rankedHint: 'Strong and Excellent bands first, then by score',
  othersTitle: 'Not ranked today',
  othersHint: 'Not enough data to score',
  methodHint: 'The six pillars, score bands and risk, explained',
  searchPlaceholder: 'Search ticker or company',
  searchPlaceholderFor: (s) => (s.multi ? 'Search ticker or company'
    : `Search the ${s.lists?.[0]?.label || 'list'}`),
  filters: [{ key: 'band_label', all: 'All bands', order: BAND_ORDER }, { key: 'sector', all: 'All sectors' }],
  listRow: (r, ctx) => `<span class="lr-rank">${r.rank}</span>
      <span class="lr-main"><span class="lr-title">${esc(r.symbol)}${exTag(r, ctx)}</span><span class="lr-sub">${esc(r.name)}</span></span>
      <span class="lr-trail">${gradePill(`band-${slug(r.band_label)}`, r.band_label, r.score)}${change1m(r)}</span>`,
  otherRow: (r) => `<span class="lr-main"><span class="lr-title">${esc(r.symbol)}</span><span class="lr-sub">${esc(r.name)}</span>
      <span class="lr-sub">${esc(r.status_reason || '')}</span></span><span class="lr-trail">${change1m(r)}</span>`,
  sheetTop: (r) => quote(r, [
    r.band_label ? `<span class="chip">Score ${gradePill(`band-${slug(r.band_label)}`, r.band_label, r.score)}</span>` : '',
    r.risk_grade ? `<span class="chip">Risk ${riskPill(r)}</span>` : '',
    r.valuation ? `<span class="chip">${esc(r.valuation)}</span>` : '',
    r.sector ? `<span class="chip">${esc(r.sector)}</span>` : '',
    r.exchange ? `<span class="chip">${esc(r.exchange)}</span>` : '',
  ]),
  columns: [
    { key: 'rank', label: '#', sort: (r) => r.rank,
      render: (r, ctx) => `<span class="rank-num"${ctx.multi && r.list_rank
        ? ` title="#${r.list_rank} in the ${esc(r.list)}"` : ''}>${r.rank}</span>` },
    { key: 'symbol', label: 'Company', sort: (r) => r.symbol, render: usStockCell },
    { key: 'sector', label: 'Sector', opt: true, sort: (r) => r.sector, render: (r) => esc(r.sector || DASH) },
    { key: 'score', label: 'Score', title: 'Long-term composite 0-100 and its band', desc: true,
      sort: (r) => r.score, render: (r) => gradePill(`band-${slug(r.band_label)}`, r.band_label, r.score) },
    { key: 'valuation', label: 'Valuation', title: 'Trailing P/E against the sector median', desc: true,
      sort: (r) => pillarScore(r, 'Valuation'), render: (r) => esc(r.valuation || DASH) },
    { key: 'risk', label: 'Risk', title: 'Risk 0-100, higher is riskier', desc: true,
      sort: (r) => r.risk_score, render: riskPill },
    { key: 'close', label: 'Close', align: 'right', desc: true, sort: (r) => r.close, render: (r) => money(r.close) },
    { key: 'd1', label: '1D', align: 'right', opt: true, desc: true, sort: (r) => r.change_1d_pct,
      render: (r) => toned(r.change_1d_pct, 2) },
    { key: 'm1', label: '1M', align: 'right', desc: true, sort: (r) => r.return_1m_pct,
      render: (r) => toned(r.return_1m_pct) },
    { key: 'mom', label: '12-1 mom.', align: 'right', opt: true, desc: true,
      title: '12-month return excluding the latest month', sort: (r) => r.momentum_12_1_pct,
      render: (r) => toned(r.momentum_12_1_pct) },
    { key: 'dip', label: 'Below 52w high', align: 'right', opt: true, desc: true,
      sort: (r) => r.below_52w_high_pct, render: (r) => dipCell(r.below_52w_high_pct) },
    { key: 'coverage', label: 'Data', align: 'right', opt: true, desc: true,
      title: 'Share of the model that had data', sort: (r) => r.coverage_pct, render: (r) => pct(r.coverage_pct, 0) },
    { key: 'why', label: 'Pillars', cls: 'why', render: pillarExtremes },
  ],

  tiles(s) {
    const bands = BAND_ORDER.map((b) => [b, s.stats.by_band?.[b] || 0]);
    const avgCoverage = s.ranked.length
      ? s.ranked.reduce((a, r) => a + (r.coverage_pct || 0), 0) / s.ranked.length : null;
    const bySector = {};
    for (const r of s.ranked) {
      if (!r.sector || !isNum(r.score)) continue;
      (bySector[r.sector] ||= []).push(r.score);
    }
    const sectors = Object.entries(bySector)
      .filter(([, v]) => v.length >= 2)
      .map(([k, v]) => ({ label: k, value: v.reduce((a, b) => a + b, 0) / v.length, n: v.length }))
      .sort((a, b) => b.value - a.value).slice(0, 4)
      .map((x) => ({ label: x.label, value: x.value, text: num(x.value, 0), title: `${x.label}: ${x.n} companies` }));
    return [
      benchTile(s.benchmark, money(s.benchmark.close)),
      tile('Companies ranked', `${s.stats.ranked}<span class="muted" style="font-size:15px"> / ${s.stats.scanned}</span>`,
        isNum(avgCoverage) ? `Average model coverage ${avgCoverage.toFixed(0)}%` : ''),
      tile('Score bands', '', '', `<ul class="tile-list">${bands.map(([b, n]) =>
        `<li><span class="grade band-${slug(b)}">${b}</span><span class="lead">${n}</span></li>`).join('')}</ul>`),
      tile('Average score by sector', '', '', miniBars(sectors, { scale: 100 })),
    ].join('');
  },

  detail(r) {
    const f = r.fundamentals || {};
    const left = [];
    if (r.status === 'ranked') {
      left.push(section(`Scorecard · ${num(r.score, 0)}/100 (${esc(r.band_label)})`,
        `<p style="margin:0 0 10px">${esc(r.summary)}</p>`
        + bars((r.pillars || []).map((p) => ({
          label: `${p.name} (${p.weight})`, value: p.score, off: !p.covered,
          note: p.covered ? (p.drivers || []).join(' · ') : 'No data — dropped and the other pillars re-weighted',
        })))
        + `<p class="small muted" style="margin:10px 0 0">Model coverage ${pct(r.coverage_pct, 0)}.
          ${r.has_fundamentals ? '' : 'No fundamentals were available, so only price-based pillars are scored.'}</p>`));
      left.push(section(`Risk · ${esc(titleCase(r.risk_grade))} (${num(r.risk_score, 0)})`,
        r.risk_drivers?.length ? list(r.risk_drivers) : '<p class="muted" style="margin:0">No elevated risk flags.</p>'));
    } else {
      left.push(section('Status', `<p class="muted" style="margin:0">${esc(r.status_reason)}</p>`));
    }
    const right = [
      range52(r),
      r.status === 'ranked' ? section('Fundamentals', kvMore([
        ['Market cap', moneyCompact(f.market_cap)], ['P/E (trailing)', num(f.trailing_pe, 1)],
        ['P/E (forward)', num(f.forward_pe, 1)], ['Dividend yield', pct(f.dividend_yield_pct, 2)],
        ['Return on equity', pct(f.roe_pct)], ['Net margin', pct(f.net_margin_pct)],
        ['Revenue growth', toned(f.revenue_growth_pct)],
        ['Debt / equity', isNum(f.debt_to_equity) ? `${num(f.debt_to_equity, 2)}×` : DASH],
        ['EV / EBITDA', num(f.ev_to_ebitda, 1)],
        ['Price / book', num(f.price_to_book, 1)], ['FCF yield', pct(f.fcf_yield_pct)],
        ['Return on assets', pct(f.roa_pct)], ['Gross margin', pct(f.gross_margin_pct)],
        ['Operating margin', pct(f.operating_margin_pct)], ['FCF margin', pct(f.fcf_margin_pct)],
        ['Earnings growth', toned(f.earnings_growth_pct)],
        ['Current ratio', num(f.current_ratio, 2)], ['Beta', num(f.beta, 2)],
        ['Industry', esc(f.industry || DASH)],
        ['Fundamentals as of', f.fetched_at ? tradingDay(f.fetched_at) : DASH],
      ], 8, `fund-${r.symbol}`)) : '',
      section('Price and momentum', kvMore([
        ['Close', money(r.close)], ['Day change', toned(r.change_1d_pct, 2)],
        ['Return 1M', toned(r.return_1m_pct)], ['Return 3M', toned(r.return_3m_pct)],
        ['Return 12M', toned(r.return_12m_pct)], ['RS vs S&P 500 (12M)', toned(r.rs_12m_pct)],
        ['Momentum (12-1)', toned(r.momentum_12_1_pct)], ['RSI (14)', num(r.rsi, 1)],
        ['SMA 50', money(r.sma_50)], ['SMA 200', money(r.sma_200)],
        ['50/200-day structure', trendLabel(r.trend_state)],
        ['Volatility (90d, ann.)', pct(r.volatility_90d_pct)], ['Max drawdown (1y)', pct(r.max_drawdown_1y_pct)],
        ['Sharpe (1y)', num(r.sharpe_1y, 2)], ['Avg daily traded value', moneyCompact(r.avg_turnover)],
        ['Last trading day', tradingDay(r.last_date)],
      ], 6, `price-${r.symbol}`)),
      `<div class="links">${quoteLinks(r).map((l) =>
        `<a href="${esc(l.href)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join('')}</div>`,
    ];
    return `<div>${left.join('')}</div><div>${right.join('')}</div>`;
  },

  method(s) {
    const asOf = (label) => {
      const l = (s.lists || []).find((x) => x.label === label);
      return l?.universe?.as_of ? ` (list as of ${esc(tradingDay(l.universe.as_of))})` : '';
    };
    return `<div class="prose">
      <p>Two lists of large US companies are scored the same way, for a long, buy-and-hold horizon, from
      end-of-day prices and company fundamentals:</p>
      <ul>
        <li><strong>NASDAQ-100</strong>: the 100 largest non-financial companies listed on the Nasdaq
          exchange, as published by Nasdaq${asOf('NASDAQ-100')}.</li>
        <li><strong>NYSE top 100</strong>: the 100 largest US companies listed on the New York Stock Exchange,
          by market value, from Nasdaq's stock screener${asOf('NYSE top 100')}. Common stock only, one share
          class per company. So that companies near #100 do not swap in and out on every refresh, a member
          stays until it falls below #120, and a newcomer joins once it is in the top 80 or a place frees up.</li>
      </ul>
      <p>A company is listed on one exchange: Oracle, Uber and JPMorgan, for example, are on the NYSE, so
      they are in the second list, not the NASDAQ-100. <strong>All US</strong> ranks both lists together in
      the same order as each list; choose an exchange above to see one list with its own ranks. The search
      looks through every company in the list you are viewing.</p>
      <table>
        <tr><th>Pillar</th><th>Weight</th><th>What it measures</th></tr>
        <tr><td>Quality &amp; profitability</td><td>24</td><td>Return on equity and assets, gross, operating and free-cash-flow margins</td></tr>
        <tr><td>Valuation</td><td>18</td><td>P/E relative to the sector median, EV/EBITDA, free-cash-flow yield, price/book</td></tr>
        <tr><td>Growth durability</td><td>17</td><td>Revenue and earnings growth</td></tr>
        <tr><td>Long-horizon momentum</td><td>16</td><td>12-1 month momentum, 12-month return vs the S&amp;P 500, 200-day trend</td></tr>
        <tr><td>Financial strength</td><td>13</td><td>Debt/equity, current ratio, net cash</td></tr>
        <tr><td>Risk &amp; drawdown</td><td>12</td><td>1-year volatility, 3-year maximum drawdown, beta</td></tr>
      </table>
      <p>Missing data never scores zero: a pillar without inputs is dropped and the rest are re-weighted.
      “Data” shows how much of the model had inputs; below 55% a company cannot be banded above Average.</p>
      <p>Bands: Excellent ≥ 76, Strong ≥ 62, Average ≥ 46, Weak ≥ 34, Poor below. Excellent and Strong
      companies are listed first, then Average and Weak, then Poor, by score within each group.
      Valuation compares the trailing P/E with a sector median (for example Technology 30, Financial
      Services 14, Energy 13), so a bank and a software company are each judged against their peers.
      The risk score (0–100, higher is riskier) is the inverse of the risk pillar.</p>
      <h3>What this is not</h3>
      <p>A scorecard of reported numbers and price history. It does not read news, guidance or
      management commentary, and it is not a recommendation to buy or sell anything.</p>
    </div>`;
  },
};

const MARKETS = { india: INDIA, us: US };

// ── Generic table engine ──
function compare(a, b) {
  const an = a === null || a === undefined || a === '' || (typeof a === 'number' && !Number.isFinite(a));
  const bn = b === null || b === undefined || b === '' || (typeof b === 'number' && !Number.isFinite(b));
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  return typeof a === 'string' ? a.localeCompare(b) : a - b;
}

// A list of rows on phones (`listRow`), a sortable table on wider screens (`columns`). A row
// opens `onOpen(row, rowsInOrder)`. `limit`: rows shown until "Show all"; not applied while
// `filtered()` is true (a search). `onRender` gets { shown, matched } for the count.
function makeTable(host, { columns, rows, listRow, empty, sort, filtersFn, context, limit = 0, filtered, onRender, onOpen }) {
  const state = { sort: { ...sort }, all: false, list: [] };

  const sorted = () => {
    const col = columns.find((c) => c.key === state.sort.key);
    const list = filtersFn ? rows().filter(filtersFn) : rows();
    if (!col?.sort) return list;
    return [...list].sort((a, b) => {
      const va = col.sort(a);
      const vb = col.sort(b);
      if (va === null || va === undefined || vb === null || vb === undefined) return compare(va, vb);
      return compare(va, vb) * state.sort.dir;
    });
  };

  const render = () => {
    const list = sorted();
    state.list = list;
    const capped = limit > 0 && !state.all && !filtered?.() && list.length > limit;
    const shown = capped ? list.slice(0, limit) : list;
    const ctx = context ? context() : {};
    const showAll = capped ? `<div class="show-all"><button class="btn alt small" type="button" data-show-all>Show all ${
      list.length}</button></div>` : '';
    if (!shown.length) {
      host.innerHTML = `<p class="empty">${typeof empty === 'function' ? empty() : empty}</p>`;
    } else if (NARROW.matches) {
      host.innerHTML = `<ul class="list rank-list">${shown.map((r) => `<li><button class="list-row" type="button"
        data-symbol="${esc(r.symbol)}">${listRow(r, ctx)}</button></li>`).join('')}</ul>${showAll}`;
    } else {
      const sortState = (c) => (c.key === state.sort.key ? (state.sort.dir > 0 ? 'ascending' : 'descending') : 'none');
      host.innerHTML = `<div class="table-scroll"><table class="rank compact${allColumns() ? ' all-cols' : ''}">
        <thead><tr>${columns.map((c) => `<th class="${c.align === 'right' ? 'right' : ''}${c.opt ? ' opt' : ''}"
          ${c.title ? `title="${esc(c.title)}"` : ''}${c.sort ? ` data-key="${c.key}" aria-sort="${sortState(c)}"` : ''}>${
          c.sort ? `<button class="sort" type="button">${esc(c.label)}</button>` : esc(c.label)}</th>`).join('')}</tr></thead>
        <tbody>${shown.map((r) => `<tr class="row" data-symbol="${esc(r.symbol)}">${columns.map((c) =>
          `<td class="${[c.cls, c.align === 'right' ? 'right' : '', c.opt ? 'opt' : ''].filter(Boolean).join(' ')}">${
            c.render(r, ctx)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${showAll}`;
    }
    onRender?.({ shown: shown.length, matched: list.length });
  };

  host.addEventListener('click', (e) => {
    if (e.target.closest('[data-show-all]')) {
      state.all = true;
      render();
      // Keyboard focus moves to the first newly shown row instead of being lost with the button.
      const next = host.querySelectorAll('[data-symbol]')[limit];
      (next?.querySelector('button.sym') || next)?.focus({ preventScroll: true });
      return;
    }
    const th = e.target.closest('th[data-key]');
    if (th) {
      const key = th.dataset.key;
      const col = columns.find((c) => c.key === key);
      state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: col.desc ? -1 : 1 };
      render();
      host.querySelector(`th[data-key="${key}"] button`)?.focus();
      return;
    }
    const hit = e.target.closest('[data-symbol]');
    if (!hit || e.target.closest('a')) return;
    const row = state.list.find((r) => r.symbol === hit.dataset.symbol);
    if (row) onOpen(row, state.list);
  });
  return { render, list: () => state.list };
}

// ── Page ──
export async function start(marketKey) {
  const M = MARKETS[marketKey];
  // One snapshot per list: the Nifty 100 page has one, the US page two (NASDAQ-100, NYSE top 100).
  const lists = M.lists || [{ key: marketKey }];
  const app = document.getElementById('app');
  let loaded = [];
  let missing = [];
  let view = M.views ? viewFromHash(window.location.hash) : null;
  let snap = null;
  const filters = { query: '' };
  let rankedTable = null;
  let shown = null; // the stock open in the sheet, redrawn when the currency switches

  renderShell(marketKey, { onAdminRefreshed: () => reload(true) });
  currency.configure(M.native, 0);
  syncCurrencyToggle();
  document.querySelectorAll('[data-trivia]').forEach((el) => renderTrivia(el, { seed: pageSeed(), pool: el.dataset.trivia || 'market' }));

  const els = {
    views: app.querySelector('#views'),
    sync: app.querySelector('#sync-bar'),
    notice: app.querySelector('#notice'),
    tiles: app.querySelector('#tiles'),
    rankedCard: app.querySelector('#ranked-card'),
    moreCard: app.querySelector('#more-card'),
  };

  async function loadLists(bust) {
    const results = await Promise.allSettled(lists.map((list) => loadJSON(dataUrl(list.key), { bust })));
    const ok = [];
    const failed = [];
    results.forEach((res, i) => {
      if (res.status === 'fulfilled') ok.push({ list: lists[i], snap: res.value });
      else failed.push({ list: lists[i], error: res.reason });
    });
    return { ok, failed };
  }

  // The snapshot the page shows: the market's own, or on the US page the chosen view of both lists.
  function compose() {
    if (!M.views) return loaded[0]?.snap || null;
    let out = composeView(loaded, view);
    if (!out) {
      view = 'all';
      out = composeView(loaded, view);
      if (window.location.hash) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    }
    return out;
  }

  function setView(key) {
    if (!M.views) return;
    view = viewOf(key).key;
    const hash = view === 'all' ? '' : `#${view}`;
    if (window.location.hash !== hash) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
    }
    snap = compose();
    renderAll();
  }

  function renderViews() {
    if (!M.views || !els.views) return;
    els.views.innerHTML = M.views.map((v) => {
      const s = composeView(loaded, v.key);
      return `<button class="view-btn" type="button" data-view="${v.key}" aria-pressed="${v.key === snap.view}"${
        s ? '' : ' disabled title="Not published yet"'}><span>${esc(v.label)}</span><span class="view-count">${
        s ? s.ranked.length : DASH}</span></button>`;
    }).join('');
  }

  function renderSync() {
    if (!snap) return;
    const ageDays = (Date.now() - new Date(snap.generated_at).getTime()) / 86400000;
    // Lists refreshed at different times (one failed to refresh) each say when.
    const times = (snap.lists || []).map((l) => new Date(l.generated_at).getTime());
    const apart = times.length > 1 && Math.max(...times) - Math.min(...times) > 3600000;
    const perList = apart ? ` · ${snap.lists.map((l) => `${esc(l.label)} ${esc(ago(l.generated_at))}`).join(', ')}` : '';
    els.sync.innerHTML = `
      <span class="sync-dot${ageDays > 4 ? ' warn' : ''}" aria-hidden="true"></span>
      <span class="sync-meta" title="Last synced ${esc(istDateTime(snap.generated_at))} · ${esc(snap.data_source?.prices || '')}">Updated ${
        esc(ago(snap.generated_at))}<span class="sync-extra"> · prices to ${esc(tradingDay(snap.data_through))}${perList}</span></span>
      ${isAdmin()
        ? '<span class="chip info" title="Admin mode is on in this browser">Admin</span><button class="text-btn" id="analyse-btn" type="button">Analyse now</button>'
        : '<button class="text-btn" id="request-btn" type="button" title="Ask the maintainer to refresh this ranking">Request refresh</button>'}`;
    els.sync.querySelector('#analyse-btn')?.addEventListener('click',
      () => startRefresh(marketKey, { onDone: () => reload(true) }));
    els.sync.querySelector('#request-btn')?.addEventListener('click', () => openRequestModal({
      market: marketKey,
      title: snap.multi ? 'US (NASDAQ-100 and NYSE top 100)' : snap.title.replace(/ Ranking$/, ''),
      generatedAt: snap.generated_at, dataThrough: snap.data_through,
    }));
  }

  function renderNotice() {
    const notes = [];
    if (snap.partial) notes.push('<div class="banner warn">This is a partial test snapshot, not the full ranking.</div>');
    if (!snap.fx?.usd_inr) notes.push('<div class="banner">Currency conversion is unavailable for this snapshot.</div>');
    const visible = M.views ? viewOf(snap.view).exchanges : null;
    for (const { label, exchange } of missing) {
      if (visible && !visible.includes(exchange)) continue;
      notes.push(`<div class="banner warn">The ${esc(label || 'ranking')} list could not be loaded right now, so it is
        left out. Reload the page in a minute.</div>`);
    }
    els.notice.innerHTML = notes.join('');
  }

  // Searching one exchange for a company listed on the other says where it is.
  function emptyRanked() {
    const elsewhere = M.views ? findElsewhere(loaded, snap.view, filters.query) : [];
    if (!elsewhere.length) return 'No matches — clear the search or filters.';
    const names = elsewhere.slice(0, 3).map((h) => `<strong>${esc(h.symbol)}</strong> (${esc(h.name)})`).join(', ');
    const where = [...new Set(elsewhere.map((h) => h.label))].join(' and ');
    return `No matches in the ${esc(snap.lists?.[0]?.label || 'list')}. ${names}${elsewhere.length > 3 ? ' and more' : ''}
      ${elsewhere.length === 1 ? 'is' : 'are'} in the ${esc(where)}.
      <button class="btn alt small" type="button" data-view="all">Search all US</button>`;
  }

  function buildRanked() {
    const filterOptions = M.filters.map((f) => {
      const values = [...new Set(snap.ranked.map((r) => r[f.key]).filter(Boolean))];
      values.sort(f.order ? (a, b) => f.order.indexOf(a) - f.order.indexOf(b) : undefined);
      if (filters[f.key] && !values.includes(filters[f.key])) filters[f.key] = '';
      return `<select class="chip-select${filters[f.key] ? ' on' : ''}" data-filter="${f.key}" aria-label="${esc(f.all)}"><option value="">${
        esc(f.all)}</option>${values.map((v) => `<option value="${esc(v)}"${filters[f.key] === v ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>`;
    }).join('');
    const title = M.rankedTitleFor ? M.rankedTitleFor(snap) : M.rankedTitle;
    const placeholder = M.searchPlaceholderFor ? M.searchPlaceholderFor(snap) : M.searchPlaceholder;
    els.rankedCard.innerHTML = `
      <div class="card-head"><h2>${esc(title)} <span class="count-pill">${snap.ranked.length}</span></h2>
        <span class="hint">${esc(M.rankedHint)}</span></div>
      <div class="toolbar">
        <label class="search-field compact">${icon('search', { size: 20 })}<input type="search" id="q"
          placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" value="${esc(filters.query)}"></label>
        <div class="chip-row filters">${filterOptions}
          <button class="chip cols-toggle" type="button" id="cols-btn" aria-pressed="${allColumns()}"
            title="Show or hide the extra columns of numbers">More columns</button></div>
        <span class="count" id="count"></span>
      </div>
      <div id="ranked-table"></div>`;
    const match = (r) => matchesQuery(r, filters.query)
      && M.filters.every((f) => !filters[f.key] || r[f.key] === filters[f.key]);
    const count = els.rankedCard.querySelector('#count');
    rankedTable = makeTable(els.rankedCard.querySelector('#ranked-table'), {
      columns: M.columns, rows: () => snap.ranked, listRow: M.listRow, filtersFn: match,
      sort: { key: 'rank', dir: 1 }, empty: emptyRanked, context: () => ({ multi: Boolean(snap.multi) }),
      // A typed search shows every match, so the stock looked for is never behind "Show all".
      limit: TOP_ROWS, filtered: () => Boolean(filters.query.trim()),
      onRender: ({ shown: n, matched }) => {
        const total = snap.ranked.length;
        count.textContent = n === total ? `${total} shown`
          : n < matched && matched < total ? `Showing ${n} of ${matched} matches`
            : `Showing ${n} of ${total}`;
      },
      onOpen: (row, rowsInOrder) => openStock(row, rowsInOrder),
    });
    els.rankedCard.querySelector('#q').addEventListener('input', (e) => { filters.query = e.target.value; rankedTable.render(); });
    els.rankedCard.querySelectorAll('select[data-filter]').forEach((sel) => sel.addEventListener('change', () => {
      filters[sel.dataset.filter] = sel.value;
      sel.classList.toggle('on', Boolean(sel.value));
      rankedTable.render();
    }));
    els.rankedCard.querySelector('#cols-btn').addEventListener('click', (e) => {
      const on = !allColumns();
      store.set(COLUMNS_KEY, on ? '1' : '0');
      e.currentTarget.setAttribute('aria-pressed', String(on));
      app.querySelectorAll('table.rank').forEach((table) => table.classList.toggle('all-cols', on));
    });
    rankedTable.render();
  }

  // ── Sheets: a stock's details, what changed, stocks not ranked, how the ranking works ──
  const stockSub = (r) => (r.rank ? `#${r.rank}${snap.multi && r.list_rank ? ` · #${r.list_rank} in the ${esc(r.list)}` : ''} · ${esc(r.name)}`
    : `Not ranked · ${esc(r.name)}`);

  function openStock(row, rowsInOrder, { back = null } = {}) {
    const order = rowsInOrder?.includes(row) ? rowsInOrder : [row];
    const show = (i) => {
      const r = order[i];
      shown = { symbol: r.symbol, order, back };
      openSheet({
        title: r.symbol, sub: stockSub(r),
        body: `${M.sheetTop(r)}<div class="detail">${M.detail(r)}</div>`,
        onPrev: i > 0 ? () => show(i - 1) : null,
        onNext: i < order.length - 1 ? () => show(i + 1) : null,
        onBack: back,
        onClose: () => { shown = null; dropParam('stock'); },
      });
    };
    show(order.indexOf(row));
  }

  function changesHtml(c) {
    // With both US lists shown, each rank is the company's rank in its own list.
    const at = (d, n) => `${snap.multi && d.exchange ? `${esc(d.exchange)} ` : ''}#${n}`;
    const item = (d, right) => `<li><span class="sym">${esc(d.symbol)}</span><span class="muted small">${right}</span></li>`;
    const groups = [];
    if (c.new_entries?.length) {
      groups.push(`<div><h3>New in the ranking</h3><ul>${c.new_entries.slice(0, 12).map((d) =>
        item(d, `${at(d, d.rank)}${d.label ? ` · ${esc(d.label)}` : ''}`)).join('')}</ul></div>`);
    }
    if (c.dropped?.length) {
      groups.push(`<div><h3>Left the ranking</h3><ul>${c.dropped.slice(0, 12).map((d) =>
        item(d, `was ${at(d, d.previous_rank)} · ${esc(d.now)}`)).join('')}</ul></div>`);
    }
    if (c.rank_movers?.length) {
      groups.push(`<div><h3>Biggest rank moves</h3><ul>${c.rank_movers.slice(0, 12).map((d) =>
        `<li><span class="sym">${esc(d.symbol)}</span><span class="${d.delta > 0 ? 'pos' : 'neg'}">${d.delta > 0 ? '▲' : '▼'} ${Math.abs(d.delta)}</span>
         <span class="muted small">${at(d, d.previous_rank)} → #${d.rank}</span></li>`).join('')}</ul></div>`);
    }
    if (c.band_changes?.length) {
      groups.push(`<div><h3>Band changes</h3><ul>${c.band_changes.slice(0, 12).map((d) =>
        item(d, `${esc(d.previous)} → ${esc(d.now)}`)).join('')}</ul></div>`);
    }
    return groups.length ? `<div class="changes">${groups.join('')}</div>`
      : `<p class="muted">${c.compared_to ? 'Nothing moved enough to report since the previous refresh.' : esc(c.summary)}</p>`;
  }

  function openOthers() {
    const box = document.createElement('div');
    box.innerHTML = `<ul class="list">${snap.others.map((r) => `<li><button class="list-row" type="button"
      data-symbol="${esc(r.symbol)}">${M.otherRow(r)}</button></li>`).join('')}</ul>`;
    box.addEventListener('click', (e) => {
      const hit = e.target.closest('[data-symbol]');
      const r = hit && snap.others.find((x) => x.symbol === hit.dataset.symbol);
      if (r) openStock(r, snap.others, { back: openOthers });
    });
    openSheet({ title: `${M.othersTitle} (${snap.others.length})`, sub: esc(M.othersHint), body: box });
  }

  const SHEETS = {
    changes: () => {
      const c = snap.changes;
      const since = c.compared_to?.data_through ? ` · vs prices of ${tradingDay(c.compared_to.data_through)}` : '';
      openSheet({ title: 'What changed', sub: esc(`${c.summary || ''}${since}`), body: changesHtml(c) });
    },
    others: openOthers,
    method: () => openSheet({ title: 'How this ranking works', body: M.method(snap) }),
  };

  function renderMore() {
    const rows = [];
    if (snap.changes) rows.push(['changes', 'history', 'What changed', snap.changes.summary || 'Since the previous refresh']);
    if (snap.others?.length) rows.push(['others', 'minus', `${M.othersTitle} (${snap.others.length})`, M.othersHint]);
    rows.push(['method', 'help', 'How this ranking works', M.methodHint]);
    els.moreCard.hidden = false;
    els.moreCard.innerHTML = `<ul class="list nav-list">${rows.map(([key, ic, title, sub]) => `<li><button class="list-row"
      type="button" data-sheet="${key}"><span class="lr-icon">${icon(ic)}</span><span class="lr-main"><span class="lr-title">${
      esc(title)}</span><span class="lr-sub">${esc(sub)}</span></span><span class="lr-chev">${icon('chevron-right')}</span></button></li>`).join('')}</ul>`;
  }

  // ?stock=SYMBOL (a shared link or the site search) opens that stock's sheet.
  function dropParam(name) {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(name)) return;
    url.searchParams.delete(name);
    window.history.replaceState(window.history.state, '', url);
  }

  function openBySymbol(symbol) {
    const find = () => snap?.ranked.find((r) => r.symbol === symbol) || snap?.others?.find((r) => r.symbol === symbol);
    let row = find();
    if (!row && M.views && view !== 'all') {
      setView('all');
      row = find();
    }
    if (!row) {
      toast(`${symbol} is not in this list.`);
      dropParam('stock');
      return;
    }
    openStock(row, snap.ranked.includes(row) ? rankedTable.list() : snap.others);
  }

  function renderMoney() {
    els.tiles.innerHTML = M.tiles(snap);
    rankedTable?.render();
    if (shown) {
      const row = shown.order.find((r) => r.symbol === shown.symbol);
      if (row) openStock(row, shown.order, { back: shown.back });
    }
  }

  function renderAll() {
    currency.configure(M.native, snap.fx?.usd_inr || 0);
    syncCurrencyToggle();
    showFx(snap.fx);
    renderViews();
    renderSync();
    renderNotice();
    buildRanked();
    renderMore();
    els.tiles.innerHTML = M.tiles(snap);
    app.setAttribute('aria-busy', 'false');
  }

  async function reload(waitForNew) {
    const before = new Map(loaded.map(({ list, snap: s }) => [list.key, s.generated_at]));
    for (let attempt = 0; attempt < 9; attempt += 1) {
      try {
        const { ok, failed } = await loadLists(true);
        const changed = ok.some(({ list, snap: s }) => before.get(list.key) !== s.generated_at);
        if (ok.length && (!waitForNew || changed)) {
          loaded = ok;
          missing = failed.map((f) => f.list);
          snap = compose();
          renderAll();
          return true;
        }
      } catch { /* retry below */ }
      await sleep(10000);
    }
    toast('The new data has not reached the site yet — reload the page in a minute.');
    return false;
  }

  currency.onChange(() => { syncCurrencyToggle(); if (snap) renderMoney(); });
  NARROW.addEventListener('change', () => rankedTable?.render());
  window.addEventListener('rupevo:admin-change', renderSync);
  setInterval(renderSync, 60000);
  app.addEventListener('click', (e) => {
    const sheetBtn = e.target.closest('button[data-sheet]');
    if (sheetBtn && snap) {
      SHEETS[sheetBtn.dataset.sheet]?.();
      return;
    }
    const btn = e.target.closest('button[data-view]');
    if (!btn || btn.disabled || !snap) return;
    e.preventDefault();
    // The view re-renders the switch and the table, replacing the clicked button: keep the
    // keyboard focus on the search box (from "Search all US") or on the new switch button.
    const fromTable = Boolean(btn.closest('#ranked-card'));
    setView(btn.dataset.view);
    const target = fromTable ? els.rankedCard.querySelector('#q') : els.views?.querySelector(`[data-view="${view}"]`);
    target?.focus();
  });
  window.addEventListener('hashchange', () => {
    if (M.views && snap && viewFromHash(window.location.hash) !== snap.view) setView(viewFromHash(window.location.hash));
  });
  // The site search shows a stock of this market right here.
  window.addEventListener('rupevo:select', (e) => {
    const it = e.detail;
    if (snap && it?.kind === 'stock' && it.market === marketKey) {
      e.preventDefault();
      openBySymbol(it.sym);
    }
  });

  try {
    const { ok, failed } = await loadLists(false);
    if (!ok.length) throw failed[0]?.error || new Error('no data');
    loaded = ok;
    missing = failed.map((f) => f.list);
    snap = compose();
    renderAll();
    const wanted = new URLSearchParams(window.location.search).get('stock');
    if (wanted) openBySymbol(wanted);
  } catch (err) {
    app.setAttribute('aria-busy', 'false');
    els.notice.innerHTML = `<div class="banner error">The ranking data could not be loaded (${esc(err.message)}).
      Please try again in a few minutes.</div>`;
    els.sync.innerHTML = '<span class="muted">No data available.</span>';
  }
  // Opened from the "Refresh now" link in a refresh-request email.
  handleRefreshLink(marketKey, { onDone: () => reload(true) });
}
