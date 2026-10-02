// Ranking page controller shared by the Nifty 100 and NASDAQ-100 pages.
// Everything renders from the published snapshot JSON (site/data/*.json).
import {
  DASH, ago, currency, dataUrl, esc, isNum, istDateTime, loadJSON, money, moneyCompact,
  num, pct, sleep, toast, toned, tradingDay,
} from './core.js';
import { renderShell, showFx, syncCurrencyToggle } from './shell.js';
import { isAdmin, startRefresh } from './admin.js';
import { openRequestModal } from './request.js';

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
const trendLabel = (state) => ({ GOLDEN_CROSS: 'Golden cross',
  DEATH_CROSS: 'Death cross' }[state] || DASH);
const dipCell = (v) => {
  if (!isNum(v)) return DASH;
  const cls = v >= 18 ? 'neg' : v >= 10 ? '' : 'muted';
  return `<span class="${cls}"${v >= 18 ? ' style="font-weight:700"' : ''}>${v.toFixed(1)}%</span>`;
};
const stockCell = (r, ctx) => `<div class="stock">
    <button class="sym" type="button" aria-expanded="${ctx.open ? 'true' : 'false'}">${esc(r.symbol)}</button>
    <span class="nm" title="${esc(r.name)}">${esc(r.name)}</span></div>`;

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
  rankedHint: 'Technical setups first, then 52-week dips. Click a row for the full breakdown.',
  othersTitle: 'Not ranked today',
  searchPlaceholder: 'Search symbol or company',
  filters: [{ key: 'setup_label', all: 'All setups' }, { key: 'sector_label', all: 'All sectors' }],
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
    { key: 'dip', label: 'Below 52w high', align: 'right', desc: true,
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
  otherColumns: [
    { key: 'symbol', label: 'Stock', sort: (r) => r.symbol, render: stockCell },
    { key: 'sector', label: 'Sector', opt: true, sort: (r) => r.sector_label, render: (r) => esc(r.sector_label) },
    { key: 'status', label: 'Why not ranked', cls: 'why', sort: (r) => r.status_reason,
      render: (r) => esc(r.status_reason) },
    { key: 'close', label: 'Close', align: 'right', desc: true, sort: (r) => r.close, render: (r) => money(r.close) },
    { key: 'm1', label: '1M', align: 'right', desc: true, sort: (r) => r.return_1m_pct,
      render: (r) => toned(r.return_1m_pct) },
    { key: 'dip', label: 'Below 52w high', align: 'right', desc: true, sort: (r) => r.below_52w_high_pct,
      render: (r) => dipCell(r.below_52w_high_pct) },
    { key: 'rs', label: 'RS vs Nifty', align: 'right', opt: true, desc: true,
      sort: (r) => r.rs_vs_benchmark_pct, render: (r) => toned(r.rs_vs_benchmark_pct) },
  ],

  tiles(s) {
    const technical = s.ranked.filter((r) => r.setup !== '52W_DIP').length;
    const dips = s.ranked.length - technical;
    const setups = Object.entries(s.stats.by_setup || {}).sort((a, b) => b[1] - a[1]);
    const sectors = (s.sector_strength || []).slice(0, 6).map((x) => ({
      label: x.label, value: x.mean_rs_pct, lead: x.leader,
      tone: x.mean_rs_pct >= 0 ? 'pos' : 'neg', text: toned(x.mean_rs_pct),
      title: `${x.label}: average 60-day relative strength of ${x.stocks} stocks` }));
    return [
      benchTile(s.benchmark, num(s.benchmark.close, 2, 'en-IN')),
      tile('Ranked today', `${s.stats.ranked}<span class="muted" style="font-size:15px"> / ${s.stats.scanned}</span>`,
        `${technical} technical setup${technical === 1 ? '' : 's'} · ${dips} 52-week dip${dips === 1 ? '' : 's'}`),
      tile('Setups found', '', '', `<ul class="tile-list">${setups.map(([k, v]) =>
        `<li><span>${esc(k)}</span><span class="lead">${v}</span></li>`).join('') || '<li class="muted">None today</li>'}</ul>`),
      tile('Sector strength vs NIFTY 50', '', '', miniBars(sectors)
        + '<div class="tile-sub">★ Top-3 sectors: their ranked stocks get a +0.5 score bonus</div>'),
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
      section('Key numbers', kv([
        ['Close', money(r.close)], ['Day change', toned(r.change_1d_pct, 2)],
        ['Return 1M', toned(r.return_1m_pct)], ['Return 3M', toned(r.return_3m_pct)],
        ['Return 6M', toned(r.return_6m_pct)], ['Return 12M', toned(r.return_12m_pct)],
        ['Momentum (12-1)', toned(r.momentum_12_1_pct)], ['RS vs NIFTY (60d)', toned(r.rs_vs_benchmark_pct)],
        ['RS vs NIFTY (3M)', toned(r.rs_3m_pct)], ['RS vs NIFTY (6M)', toned(r.rs_6m_pct)],
        ['RSI (14)', num(r.rsi, 1)], ['ADX (14)', num(r.adx, 1)],
        ['ATR % of price', pct(r.atr_pct, 2)], ['Volume vs 20-day avg', isNum(r.volume_ratio) ? `${num(r.volume_ratio, 2)}×` : DASH],
        ['EMA 20', money(r.ema_20)], ['SMA 50', money(r.sma_50)], ['SMA 200', money(r.sma_200)],
        ['50/200-day structure', trendLabel(r.trend_state)],
        ['Weekly trend', r.weekly_trend_up === true ? 'Rising' : r.weekly_trend_up === false ? 'Falling' : DASH],
        ['Volatility (90d, ann.)', pct(r.volatility_90d_pct)], ['Max drawdown (1y)', pct(r.max_drawdown_1y_pct)],
        ['Sharpe (1y)', num(r.sharpe_1y, 2)], ['Beta vs NIFTY', num(r.beta, 2)],
        ['Avg daily traded value', moneyCompact(r.avg_turnover)],
        ['Industry (NSE)', esc(r.industry || DASH)], ['Last trading day', tradingDay(r.last_date)],
      ])),
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

// ── NASDAQ-100 ──
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
  rankedTitle: 'Ranked companies',
  rankedHint: 'Strong and Excellent bands first, then by score. Click a row for the full scorecard.',
  othersTitle: 'Not ranked today',
  searchPlaceholder: 'Search ticker or company',
  filters: [{ key: 'band_label', all: 'All bands', order: BAND_ORDER }, { key: 'sector', all: 'All sectors' }],
  columns: [
    { key: 'rank', label: '#', sort: (r) => r.rank, render: (r) => `<span class="rank-num">${r.rank}</span>` },
    { key: 'symbol', label: 'Company', sort: (r) => r.symbol, render: stockCell },
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
  otherColumns: [
    { key: 'symbol', label: 'Company', sort: (r) => r.symbol, render: stockCell },
    { key: 'status', label: 'Why not ranked', cls: 'why', sort: (r) => r.status_reason,
      render: (r) => esc(r.status_reason) },
    { key: 'close', label: 'Close', align: 'right', desc: true, sort: (r) => r.close, render: (r) => money(r.close) },
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
      .sort((a, b) => b.value - a.value).slice(0, 6)
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
      r.status === 'ranked' ? section('Fundamentals', kv([
        ['Market cap', moneyCompact(f.market_cap)], ['P/E (trailing)', num(f.trailing_pe, 1)],
        ['P/E (forward)', num(f.forward_pe, 1)], ['EV / EBITDA', num(f.ev_to_ebitda, 1)],
        ['Price / book', num(f.price_to_book, 1)], ['FCF yield', pct(f.fcf_yield_pct)],
        ['Dividend yield', pct(f.dividend_yield_pct, 2)], ['Return on equity', pct(f.roe_pct)],
        ['Return on assets', pct(f.roa_pct)], ['Gross margin', pct(f.gross_margin_pct)],
        ['Operating margin', pct(f.operating_margin_pct)], ['Net margin', pct(f.net_margin_pct)],
        ['FCF margin', pct(f.fcf_margin_pct)], ['Revenue growth', toned(f.revenue_growth_pct)],
        ['Earnings growth', toned(f.earnings_growth_pct)],
        ['Debt / equity', isNum(f.debt_to_equity) ? `${num(f.debt_to_equity, 2)}×` : DASH],
        ['Current ratio', num(f.current_ratio, 2)], ['Beta', num(f.beta, 2)],
        ['Industry', esc(f.industry || DASH)],
        ['Fundamentals as of', f.fetched_at ? tradingDay(f.fetched_at) : DASH],
      ])) : '',
      section('Price and momentum', kv([
        ['Close', money(r.close)], ['Day change', toned(r.change_1d_pct, 2)],
        ['Return 1M', toned(r.return_1m_pct)], ['Return 3M', toned(r.return_3m_pct)],
        ['Return 12M', toned(r.return_12m_pct)], ['Momentum (12-1)', toned(r.momentum_12_1_pct)],
        ['RS vs S&P 500 (12M)', toned(r.rs_12m_pct)], ['RSI (14)', num(r.rsi, 1)],
        ['SMA 50', money(r.sma_50)], ['SMA 200', money(r.sma_200)],
        ['50/200-day structure', trendLabel(r.trend_state)],
        ['Volatility (90d, ann.)', pct(r.volatility_90d_pct)], ['Max drawdown (1y)', pct(r.max_drawdown_1y_pct)],
        ['Sharpe (1y)', num(r.sharpe_1y, 2)], ['Avg daily traded value', moneyCompact(r.avg_turnover)],
        ['Last trading day', tradingDay(r.last_date)],
      ])),
      `<div class="links">
        <a href="https://www.nasdaq.com/market-activity/stocks/${encodeURIComponent(r.symbol.toLowerCase())}" target="_blank" rel="noopener">Nasdaq ↗</a>
        <a href="https://finance.yahoo.com/quote/${encodeURIComponent(r.symbol)}" target="_blank" rel="noopener">Yahoo Finance ↗</a>
      </div>`,
    ];
    return `<div>${left.join('')}</div><div>${right.join('')}</div>`;
  },

  method(s) {
    return `<div class="prose">
      <p>Every ${esc(s.universe.name)} company (constituent list as of ${esc(tradingDay(s.universe.as_of))})
      is scored for a long, buy-and-hold horizon from end-of-day prices and company fundamentals.</p>
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

function makeTable(host, { columns, rows, detail, empty, sort, filtersFn }) {
  const state = { sort: { ...sort }, open: new Set() };
  host.innerHTML = `<div class="table-scroll"><table class="rank">
      <thead><tr>${columns.map((c) => `<th class="${c.align === 'right' ? 'right' : ''}${c.opt ? ' opt' : ''}"
        ${c.title ? `title="${esc(c.title)}"` : ''}${c.sort ? ` data-key="${c.key}"` : ''}>
        ${c.sort ? `<button class="sort" type="button">${esc(c.label)}</button>` : esc(c.label)}</th>`).join('')}</tr></thead>
      <tbody></tbody></table></div>`;
  const tbody = host.querySelector('tbody');
  const headers = [...host.querySelectorAll('th[data-key]')];

  const render = () => {
    const col = columns.find((c) => c.key === state.sort.key);
    let list = filtersFn ? rows().filter(filtersFn) : rows();
    if (col?.sort) {
      list = [...list].sort((a, b) => {
        const va = col.sort(a);
        const vb = col.sort(b);
        const nullA = va === null || va === undefined;
        const nullB = vb === null || vb === undefined;
        if (nullA || nullB) return compare(va, vb);
        return compare(va, vb) * state.sort.dir;
      });
    }
    headers.forEach((th) => th.setAttribute('aria-sort', th.dataset.key === state.sort.key
      ? (state.sort.dir > 0 ? 'ascending' : 'descending') : 'none'));
    tbody.innerHTML = list.length ? list.map((r) => {
      const open = state.open.has(r.symbol);
      return `<tr class="row${open ? ' open' : ''}" data-symbol="${esc(r.symbol)}">${columns.map((c) =>
        `<td class="${[c.cls, c.align === 'right' ? 'right' : '', c.opt ? 'opt' : ''].filter(Boolean).join(' ')}">${
          c.render(r, { open })}</td>`).join('')}</tr>${open ? detailRow(r) : ''}`;
    }).join('') : `<tr><td colspan="${columns.length}" class="empty">${empty}</td></tr>`;
    return list.length;
  };
  const detailRow = (r) => `<tr class="detail-row"><td colspan="${columns.length}"><div class="detail">${detail(r)}</div></td></tr>`;

  headers.forEach((th) => th.querySelector('button').addEventListener('click', () => {
    const key = th.dataset.key;
    const col = columns.find((c) => c.key === key);
    state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: col.desc ? -1 : 1 };
    render();
  }));
  tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr.row');
    if (!tr || e.target.closest('a')) return;
    const sym = tr.dataset.symbol;
    const row = rows().find((r) => r.symbol === sym);
    if (!row) return;
    const btn = tr.querySelector('button.sym');
    if (state.open.has(sym)) {
      state.open.delete(sym);
      tr.classList.remove('open');
      if (tr.nextElementSibling?.classList.contains('detail-row')) tr.nextElementSibling.remove();
      btn?.setAttribute('aria-expanded', 'false');
    } else {
      state.open.add(sym);
      tr.classList.add('open');
      tr.insertAdjacentHTML('afterend', detailRow(row));
      btn?.setAttribute('aria-expanded', 'true');
    }
  });
  return { render };
}

// ── Page ──
export async function start(marketKey) {
  const M = MARKETS[marketKey];
  const app = document.getElementById('app');
  let snap = null;
  const filters = { query: '' };
  let rankedTable = null;
  let othersTable = null;

  renderShell(marketKey, { onAdminRefreshed: () => reload(true) });
  currency.configure(M.native, 0);
  syncCurrencyToggle();

  const els = {
    sync: app.querySelector('#sync-bar'),
    notice: app.querySelector('#notice'),
    tiles: app.querySelector('#tiles'),
    changes: app.querySelector('#changes'),
    rankedCard: app.querySelector('#ranked-card'),
    othersCard: app.querySelector('#others-card'),
    method: app.querySelector('#method-body'),
  };

  function renderSync() {
    if (!snap) return;
    const ageDays = (Date.now() - new Date(snap.generated_at).getTime()) / 86400000;
    els.sync.innerHTML = `
      <span class="chip ${ageDays > 4 ? 'warn' : 'pos'}"><span class="dot"></span>Last synced ${esc(istDateTime(snap.generated_at))}</span>
      <span class="sync-meta">${esc(ago(snap.generated_at))} · prices through ${esc(tradingDay(snap.data_through))} · ${esc(snap.data_source?.prices || '')}</span>
      <span class="spacer"></span>
      <span class="sync-actions">${isAdmin()
        ? '<span class="chip info" title="Admin mode is on in this browser">Admin</span><button class="btn" id="analyse-btn" type="button">Analyse now</button>'
        : '<button class="btn alt" id="request-btn" type="button" title="Ask the maintainer to refresh this ranking">Request refresh</button>'}</span>`;
    els.sync.querySelector('#analyse-btn')?.addEventListener('click',
      () => startRefresh(marketKey, { onDone: () => reload(true) }));
    els.sync.querySelector('#request-btn')?.addEventListener('click', () => openRequestModal({
      market: marketKey, title: snap.title.replace(/ Ranking$/, ''),
      generatedAt: snap.generated_at, dataThrough: snap.data_through,
    }));
  }

  function renderNotice() {
    const notes = [];
    if (snap.partial) notes.push('<div class="banner warn">This is a partial test snapshot, not the full ranking.</div>');
    if (!snap.fx?.usd_inr) notes.push('<div class="banner">Currency conversion is unavailable for this snapshot.</div>');
    els.notice.innerHTML = notes.join('');
  }

  function renderChanges() {
    const c = snap.changes;
    if (!c) { els.changes.hidden = true; return; }
    els.changes.hidden = false;
    const item = (d, right) => `<li><span class="sym">${esc(d.symbol)}</span><span class="muted small">${right}</span></li>`;
    const groups = [];
    if (c.new_entries?.length) {
      groups.push(`<div><h3>New in the ranking</h3><ul>${c.new_entries.slice(0, 12).map((d) =>
        item(d, `#${d.rank}${d.label ? ` · ${esc(d.label)}` : ''}`)).join('')}</ul></div>`);
    }
    if (c.dropped?.length) {
      groups.push(`<div><h3>Left the ranking</h3><ul>${c.dropped.slice(0, 12).map((d) =>
        item(d, `was #${d.previous_rank} · ${esc(d.now)}`)).join('')}</ul></div>`);
    }
    if (c.rank_movers?.length) {
      groups.push(`<div><h3>Biggest rank moves</h3><ul>${c.rank_movers.slice(0, 12).map((d) =>
        `<li><span class="sym">${esc(d.symbol)}</span><span class="${d.delta > 0 ? 'pos' : 'neg'}">${d.delta > 0 ? '▲' : '▼'} ${Math.abs(d.delta)}</span>
         <span class="muted small">#${d.previous_rank} → #${d.rank}</span></li>`).join('')}</ul></div>`);
    }
    if (c.band_changes?.length) {
      groups.push(`<div><h3>Band changes</h3><ul>${c.band_changes.slice(0, 12).map((d) =>
        item(d, `${esc(d.previous)} → ${esc(d.now)}`)).join('')}</ul></div>`);
    }
    const since = c.compared_to?.data_through ? ` vs. prices of ${esc(tradingDay(c.compared_to.data_through))}` : '';
    els.changes.innerHTML = `<div class="card-head"><h2>What changed</h2>
        ${c.compared_to ? `<span class="hint">${esc(c.summary)}${since}</span>` : ''}</div>
      ${groups.length ? `<div class="changes">${groups.join('')}</div>`
        : `<p class="muted" style="margin:0">${c.compared_to ? 'Nothing moved enough to report since the previous refresh.' : esc(c.summary)}</p>`}`;
  }

  function buildRanked() {
    const filterOptions = M.filters.map((f) => {
      const values = [...new Set(snap.ranked.map((r) => r[f.key]).filter(Boolean))];
      values.sort(f.order ? (a, b) => f.order.indexOf(a) - f.order.indexOf(b) : undefined);
      return `<select data-filter="${f.key}" aria-label="${esc(f.all)}"><option value="">${esc(f.all)}</option>${
        values.map((v) => `<option value="${esc(v)}"${filters[f.key] === v ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>`;
    }).join('');
    els.rankedCard.innerHTML = `
      <div class="card-head"><h2>${esc(M.rankedTitle)} (${snap.ranked.length})</h2>
        <span class="hint">${esc(M.rankedHint)}</span></div>
      <div class="toolbar">
        <input type="search" id="q" placeholder="${esc(M.searchPlaceholder)}" aria-label="${esc(M.searchPlaceholder)}" value="${esc(filters.query)}">
        ${filterOptions}
        <span class="count" id="count"></span>
      </div>
      <div id="ranked-table"></div>`;
    const match = (r) => {
      const q = filters.query.trim().toLowerCase();
      if (q && !r.symbol.toLowerCase().includes(q) && !String(r.name || '').toLowerCase().includes(q)) return false;
      return M.filters.every((f) => !filters[f.key] || r[f.key] === filters[f.key]);
    };
    rankedTable = makeTable(els.rankedCard.querySelector('#ranked-table'), {
      columns: M.columns, rows: () => snap.ranked, detail: M.detail, filtersFn: match,
      sort: { key: 'rank', dir: 1 }, empty: 'No matches — clear the search or filters.',
    });
    const count = els.rankedCard.querySelector('#count');
    const refresh = () => {
      const shown = rankedTable.render();
      count.textContent = shown === snap.ranked.length ? `${shown} shown` : `Showing ${shown} of ${snap.ranked.length}`;
    };
    els.rankedCard.querySelector('#q').addEventListener('input', (e) => { filters.query = e.target.value; refresh(); });
    els.rankedCard.querySelectorAll('select[data-filter]').forEach((sel) => sel.addEventListener('change', () => {
      filters[sel.dataset.filter] = sel.value;
      refresh();
    }));
    rankedTable.refresh = refresh;
    refresh();
  }

  function buildOthers() {
    if (!snap.others?.length) { els.othersCard.hidden = true; othersTable = null; return; }
    els.othersCard.hidden = false;
    els.othersCard.innerHTML = `<details class="fold"><summary><h2>${esc(M.othersTitle)} (${snap.others.length})</h2>
        <span class="hint muted small">No qualifying setup or not enough history</span></summary>
        <div id="others-table"></div></details>`;
    othersTable = makeTable(els.othersCard.querySelector('#others-table'), {
      columns: M.otherColumns, rows: () => snap.others, detail: M.detail,
      sort: { key: 'symbol', dir: 1 }, empty: 'Every stock is ranked today.',
    });
    othersTable.render();
  }

  function renderMoney() {
    els.tiles.innerHTML = M.tiles(snap);
    rankedTable?.refresh();
    othersTable?.render();
  }

  function renderAll() {
    currency.configure(M.native, snap.fx?.usd_inr || 0);
    syncCurrencyToggle();
    showFx(snap.fx);
    renderSync();
    renderNotice();
    renderChanges();
    buildRanked();
    buildOthers();
    els.tiles.innerHTML = M.tiles(snap);
    els.method.innerHTML = M.method(snap);
    app.setAttribute('aria-busy', 'false');
  }

  async function reload(waitForNew) {
    const previous = snap?.generated_at;
    for (let attempt = 0; attempt < 9; attempt += 1) {
      try {
        const fresh = await loadJSON(dataUrl(marketKey), { bust: true });
        if (!waitForNew || fresh.generated_at !== previous) {
          snap = fresh;
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
  window.addEventListener('rupevo:admin-change', renderSync);
  setInterval(renderSync, 60000);

  try {
    snap = await loadJSON(dataUrl(marketKey));
    renderAll();
  } catch (err) {
    app.setAttribute('aria-busy', 'false');
    els.notice.innerHTML = `<div class="banner error">The ranking data could not be loaded (${esc(err.message)}).
      Please try again in a few minutes.</div>`;
    els.sync.innerHTML = '<span class="muted">No data available.</span>';
  }
}
