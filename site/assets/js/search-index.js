// The site-wide search: Nifty 100 and US stocks, mutual funds and their groups, and the site's
// own pages and tools. Pure functions (no DOM); tested in tests/js/search-index.test.mjs.

export const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();

// Pages and tools: title, what it is, where it lives (relative to the site root) and extra words.
export const PAGES = [
  ['Nifty 100 ranking', "India's 100 largest companies, ranked", 'india/', 'india nse stocks shares technical'],
  ['US stock ranking', 'NASDAQ-100 and NYSE top 100', 'us/', 'usa america stocks shares nasdaq nyse'],
  ['NASDAQ-100', 'US stock ranking', 'us/#nasdaq', 'nasdaq 100'],
  ['NYSE top 100', 'US stock ranking', 'us/#nyse', 'new york stock exchange'],
  ['Mutual fund comparison', 'Direct plans ranked within their group', 'mf/', 'mf compare direct plan index active'],
  ['SIP split by age', 'How much in each kind of fund', 'mf/#plan', 'sip allocation age risk asset debt equity'],
  ['Lump sum check', 'Are markets cheap or expensive?', 'mf/#lumpsum', 'lumpsum valuation pe stp invest at once'],
  ['Tax tools', 'Help with your income-tax return', 'tax/', 'itr income tax'],
  ['RSU taxation', 'Foreign RSUs in your ITR', 'tax/rsu/', 'rsu restricted stock units vesting perquisite'],
  ['Microsoft shares at Fidelity', 'Schedule FA, dividends and capital gains', 'tax/rsu/fidelity/msft/', 'msft microsoft fidelity schedule fa espp dividend capital gains form 67'],
  ['Oracle shares at Fidelity', 'Schedule FA, dividends and capital gains', 'tax/rsu/fidelity/orcl/', 'orcl oracle fidelity schedule fa espp dividend capital gains form 67'],
].map(([title, sub, href, words]) => ({ kind: 'page', title, sub, href, key: norm(`${title} ${sub} ${words}`) }));

const stock = (r, market, list) => ({
  kind: 'stock', market, sym: r.symbol, title: r.symbol, sub: r.name || '',
  badge: r.exchange || 'NSE', rank: r.rank || null,
  meta: r.rank ? `#${r.rank} · ${list}` : 'Not ranked',
  href: `${market}/?stock=${encodeURIComponent(r.symbol)}`,
  key: norm(`${r.symbol} ${r.name}`), symKey: norm(r.symbol),
});

/**
 * Index the snapshots: `india` (data/india.json), `us` (an array of { snap, label } for the US
 * lists) and `mf` (data/mf.json). Any of them may be missing.
 */
export function buildIndex({ india = null, us = [], mf = null } = {}) {
  const items = [...PAGES];
  if (india) {
    for (const r of [...(india.ranked || []), ...(india.others || [])]) items.push(stock(r, 'india', 'Nifty 100'));
  }
  for (const { snap, label } of us) {
    for (const r of [...(snap?.ranked || []), ...(snap?.others || [])]) items.push(stock(r, 'us', label));
  }
  for (const g of mf?.groups || []) {
    const ranked = g.funds.filter((f) => f.rank).length;
    items.push({
      kind: 'group', title: g.label, sub: `${g.kind === 'index' ? 'Index funds' : 'Active funds'} · ${g.funds.length} direct plans`,
      href: `mf/#${g.key}`, group: g.key, key: norm(`${g.label} ${g.short} ${g.kind === 'index' ? 'index' : 'active'} funds`),
    });
    for (const f of g.funds) {
      items.push({
        kind: 'fund', title: f.name, sub: `${f.amc} · ${g.short}`, code: f.code, group: g.key, rank: f.rank || null,
        meta: f.rank ? `#${f.rank} of ${ranked}` : 'Not ranked',
        href: `mf/?fund=${f.code}#${g.key}`, key: norm(`${f.name} ${f.amc} ${g.short}`),
      });
    }
  }
  return items;
}

const CAPS = { page: 4, group: 4, stock: 8, fund: 8 };

/** The best matches for `query`, a mix of kinds, best first. */
export function searchIndex(items, query, { limit = 18 } = {}) {
  const q = norm(query);
  if (!q) return [];
  const words = q.split(' ');
  const scored = [];
  for (const it of items) {
    const key = ` ${it.key}`;
    if (!words.every((w) => key.includes(w))) continue;
    const title = norm(it.title);
    let score;
    if (it.symKey === q) score = 100;
    else if (it.symKey?.startsWith(q)) score = 85;
    // "nifty 50" starts "Nifty 50 index funds" as whole words, and "Nifty 500" only partly.
    else if (title === q || title.startsWith(`${q} `)) score = 80;
    else if (title.startsWith(q)) score = 75;
    else if (key.includes(` ${q} `) || key.endsWith(` ${q}`)) score = 65;
    else if (key.includes(` ${q}`)) score = 60;
    else if (words.every((w) => key.includes(` ${w}`))) score = 45;
    else score = 20;
    if (it.kind === 'page' || it.kind === 'group') score += 4;
    if (it.rank) score += 3 - Math.min(3, it.rank / 50);
    scored.push([score, it]);
  }
  // Ties go to the closer match: the shorter title.
  scored.sort((a, b) => b[0] - a[0] || a[1].title.length - b[1].title.length || a[1].title.localeCompare(b[1].title));
  const used = {};
  const out = [];
  for (const [, it] of scored) {
    used[it.kind] = (used[it.kind] || 0) + 1;
    if (used[it.kind] > CAPS[it.kind]) continue;
    out.push(it);
    if (out.length >= limit) break;
  }
  return out;
}
