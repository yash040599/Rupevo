// The US page shows two published rankings, the NASDAQ-100 (data/us.json) and the NYSE top 100
// (data/us-nyse.json): together, or one exchange at a time. Pure functions, unit-tested in
// tests/js/us-lists.test.mjs.

export const US_LISTS = [
  { key: 'us', exchange: 'NASDAQ', label: 'NASDAQ-100' },
  { key: 'us-nyse', exchange: 'NYSE', label: 'NYSE top 100' },
];

export const US_VIEWS = [
  { key: 'all', label: 'All US', exchanges: ['NASDAQ', 'NYSE'] },
  { key: 'nasdaq', label: 'NASDAQ-100', exchanges: ['NASDAQ'] },
  { key: 'nyse', label: 'NYSE top 100', exchanges: ['NYSE'] },
];

export const viewOf = (key) => US_VIEWS.find((v) => v.key === key) || US_VIEWS[0];

/** "#nyse" → 'nyse', "#nasdaq" → 'nasdaq', anything else → 'all'. */
export function viewFromHash(hash) {
  const key = String(hash || '').replace(/^#/, '').toLowerCase();
  return US_VIEWS.some((v) => v.key === key) ? key : 'all';
}

// The pipeline lists Excellent and Strong first, then Average and Weak, then Poor; by score
// within each group, then by model coverage. Lists ranked together follow the same order.
const TIER = { Excellent: 0, Strong: 0, Average: 1, Weak: 1, Poor: 2 };
export const tierOf = (row) => TIER[row.band_label] ?? 3;

export function rankTogether(rows) {
  return [...rows].sort((a, b) => tierOf(a) - tierOf(b)
    || (b.score ?? 0) - (a.score ?? 0)
    || (b.coverage_pct ?? 0) - (a.coverage_pct ?? 0)
    || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
}

/** Search on ticker or company name, as on the other ranking pages. */
export function matchesQuery(row, query) {
  const q = String(query || '').trim().toLowerCase();
  return !q || row.symbol.toLowerCase().includes(q) || String(row.name || '').toLowerCase().includes(q);
}

/** Companies matching `query` in the lists the view leaves out (for "ORCL is on the NYSE"). */
export function findElsewhere(loaded, viewKey, query) {
  if (!String(query || '').trim()) return [];
  const view = viewOf(viewKey);
  return loaded.filter(({ list }) => !view.exchanges.includes(list.exchange))
    .flatMap(({ list, snap }) => [...(snap.ranked || []), ...(snap.others || [])]
      .filter((r) => matchesQuery(r, query))
      .map((r) => ({ symbol: r.symbol, name: r.name, exchange: list.exchange, label: list.label })));
}

const sum = (snaps, pick) => snaps.reduce((a, s) => a + (Number(pick(s)) || 0), 0);
const oldest = (values) => values.filter(Boolean).sort()[0] || null;

function mergeChanges(parts, multi) {
  const tagged = ({ list, snap }, key) => (snap.changes?.[key] || []).map((d) => ({ ...d, exchange: list.exchange }));
  const withChanges = parts.filter((p) => p.snap.changes);
  if (!withChanges.length) return null;
  const all = (key) => withChanges.flatMap((p) => tagged(p, key));
  if (!multi) return { ...withChanges[0].snap.changes, ...Object.fromEntries(
    ['new_entries', 'dropped', 'rank_movers', 'band_changes'].map((k) => [k, all(k)])) };
  const compared = withChanges.map((p) => p.snap.changes.compared_to).filter((c) => c?.data_through);
  return {
    compared_to: compared.sort((a, b) => (a.data_through < b.data_through ? -1 : 1))[0],
    summary: withChanges.map(({ list, snap }) => `${list.label}: ${snap.changes.summary}`).join(' · '),
    new_entries: all('new_entries'),
    dropped: all('dropped'),
    rank_movers: all('rank_movers').sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.rank - b.rank),
    band_changes: all('band_changes'),
  };
}

/**
 * One snapshot-shaped object for the ranking page from the lists that loaded
 * (`loaded`: [{ list, snap }]) and a view key. Rows carry their exchange and
 * their rank in their own list (`list_rank`); with both lists, `rank` is the
 * rank among all of them. Returns null when no list of the view has loaded.
 */
export function composeView(loaded, viewKey) {
  const view = viewOf(viewKey);
  const parts = loaded.filter(({ list }) => view.exchanges.includes(list.exchange));
  if (!parts.length) return null;
  const multi = parts.length > 1;
  const tag = (r, list) => ({ ...r, exchange: r.exchange || list.exchange, list: list.label, list_rank: r.rank });
  let ranked = parts.flatMap(({ list, snap }) => (snap.ranked || []).map((r) => tag(r, list)));
  if (multi) ranked = rankTogether(ranked).map((r, i) => ({ ...r, rank: i + 1 }));
  const others = parts.flatMap(({ list, snap }) => (snap.others || []).map((r) => tag(r, list)))
    .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  const byBand = {};
  for (const r of ranked) if (r.band_label) byBand[r.band_label] = (byBand[r.band_label] || 0) + 1;

  const snaps = parts.map((p) => p.snap);
  const newestFirst = [...snaps].sort((a, b) => (a.generated_at < b.generated_at ? 1 : -1));
  const first = snaps[0];
  return {
    ...first,
    view: view.key,
    multi,
    title: multi ? 'US Ranking' : first.title,
    generated_at: oldest(snaps.map((s) => s.generated_at)),
    data_through: oldest(snaps.map((s) => s.data_through)),
    partial: snaps.some((s) => s.partial),
    fx: (newestFirst.find((s) => s.fx?.usd_inr) || first).fx,
    universe: multi
      ? { name: parts.map((p) => p.list.label).join(' and '), as_of: oldest(snaps.map((s) => s.universe?.as_of)),
        count: sum(snaps, (s) => s.universe?.count) }
      : first.universe,
    lists: parts.map(({ list, snap }) => ({ ...list, universe: snap.universe, generated_at: snap.generated_at,
      data_through: snap.data_through, ranked: (snap.ranked || []).length })),
    stats: {
      scanned: sum(snaps, (s) => s.stats?.scanned),
      evaluated: sum(snaps, (s) => s.stats?.evaluated),
      ranked: ranked.length,
      not_ranked: others.length,
      errors: sum(snaps, (s) => s.stats?.errors),
      by_band: byBand,
      without_fundamentals: sum(snaps, (s) => s.stats?.without_fundamentals),
    },
    ranked,
    others,
    changes: mergeChanges(parts, multi),
  };
}

/** Yahoo Finance writes share classes with a dash (BRK-B). */
export const yahooSymbol = (symbol) => String(symbol).replace(/\./g, '-');

/** Quote pages for a row: its exchange's own page, then Yahoo Finance. */
export function quoteLinks(row) {
  const sym = String(row.symbol);
  const own = row.exchange === 'NYSE'
    ? { label: 'NYSE', href: `https://www.nyse.com/quote/XNYS:${encodeURIComponent(sym)}` }
    : { label: 'Nasdaq', href: `https://www.nasdaq.com/market-activity/stocks/${encodeURIComponent(sym.toLowerCase())}` };
  return [own, { label: 'Yahoo Finance', href: `https://finance.yahoo.com/quote/${encodeURIComponent(yahooSymbol(sym))}` }];
}
