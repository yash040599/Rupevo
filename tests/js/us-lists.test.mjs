// Tests for combining the US rankings (NASDAQ-100 and NYSE top 100). Synthetic rows only.
// Run with:  node --test "tests/js/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  composeView, findElsewhere, matchesQuery, quoteLinks, rankTogether, US_LISTS, viewFromHash, yahooSymbol,
} from '../../site/assets/js/us-lists.js';

const row = (symbol, band_label, score, extra = {}) => ({
  symbol, name: `${symbol} Corp`, band_label, score, coverage_pct: 90, status: 'ranked', ...extra,
});
const snapOf = (rows, extra = {}) => ({
  title: 'X Ranking', generated_at: '2026-10-03T20:00:00+05:30', data_through: '2026-10-02',
  fx: { usd_inr: 88 }, universe: { name: 'X', as_of: '2026-10-02', count: rows.length },
  stats: { scanned: rows.length + 1, evaluated: rows.length + 1, errors: 0, without_fundamentals: 0 },
  ranked: rows.map((r, i) => ({ ...r, rank: i + 1 })),
  others: [{ symbol: 'NEW', name: 'New Listing', rank: null, status: 'insufficient_data' }],
  changes: { summary: 'No notable changes', compared_to: { data_through: '2026-10-01' },
    new_entries: [], dropped: [], rank_movers: [{ symbol: rows[0].symbol, previous_rank: 5, rank: 1, delta: 4 }],
    band_changes: [] },
  ...extra,
});
const [NASDAQ, NYSE] = US_LISTS;
const nasdaq = snapOf([row('AAPL', 'Strong', 70), row('MSFT', 'Average', 60), row('TSLA', 'Poor', 30)]);
const nyse = snapOf([row('ORCL', 'Excellent', 80), row('UBER', 'Average', 64), row('BRK.B', 'Weak', 40)],
  { generated_at: '2026-10-03T19:00:00+05:30', changes: { summary: 'First snapshot — changes appear after the next refresh.',
    new_entries: [], dropped: [], rank_movers: [], band_changes: [] } });
const loaded = [{ list: NASDAQ, snap: nasdaq }, { list: NYSE, snap: nyse }];

test('views from the URL hash', () => {
  assert.equal(viewFromHash('#nyse'), 'nyse');
  assert.equal(viewFromHash('#NASDAQ'), 'nasdaq');
  assert.equal(viewFromHash(''), 'all');
  assert.equal(viewFromHash('#fa'), 'all');
});

test('lists ranked together follow the pipeline order: band group, score, coverage, symbol', () => {
  const rows = [row('B', 'Average', 64), row('A', 'Strong', 63), row('C', 'Average', 64, { coverage_pct: 95 }),
    row('D', 'Poor', 99), row('E', 'Excellent', 77)];
  assert.deepEqual(rankTogether(rows).map((r) => r.symbol), ['E', 'A', 'C', 'B', 'D']);
});

test('all US: both lists in one ranking, each row keeping its exchange and list rank', () => {
  const v = composeView(loaded, 'all');
  assert.equal(v.multi, true);
  assert.deepEqual(v.ranked.map((r) => [r.rank, r.symbol, r.exchange, r.list_rank]), [
    [1, 'ORCL', 'NYSE', 1], [2, 'AAPL', 'NASDAQ', 1], [3, 'UBER', 'NYSE', 2], [4, 'MSFT', 'NASDAQ', 2],
    [5, 'BRK.B', 'NYSE', 3], [6, 'TSLA', 'NASDAQ', 3]]);
  assert.equal(v.others.length, 2);
  assert.deepEqual(v.stats.by_band, { Excellent: 1, Strong: 1, Average: 2, Weak: 1, Poor: 1 });
  assert.equal(v.stats.scanned, 8);
  assert.equal(v.generated_at, '2026-10-03T19:00:00+05:30', 'the older sync time of the two');
  assert.equal(v.universe.name, 'NASDAQ-100 and NYSE top 100');
  assert.match(v.changes.summary, /^NASDAQ-100: No notable changes · NYSE top 100: First snapshot/);
  assert.deepEqual(v.changes.rank_movers.map((d) => [d.symbol, d.exchange]), [['AAPL', 'NASDAQ']]);
  // The published snapshots are not modified.
  assert.equal(nasdaq.ranked[0].rank, 1);
  assert.equal(nasdaq.ranked[0].exchange, undefined);
});

test('one exchange: only its companies, with the ranks of its own list', () => {
  const v = composeView(loaded, 'nyse');
  assert.equal(v.multi, false);
  assert.equal(v.title, 'X Ranking');
  assert.deepEqual(v.ranked.map((r) => [r.rank, r.symbol, r.exchange]), [[1, 'ORCL', 'NYSE'], [2, 'UBER', 'NYSE'],
    [3, 'BRK.B', 'NYSE']]);
  assert.equal(v.changes.summary, 'First snapshot — changes appear after the next refresh.');
  assert.equal(composeView([{ list: NASDAQ, snap: nasdaq }], 'nyse'), null, 'NYSE list not published');
});

test('search covers both lists, and a one-exchange view points to the other', () => {
  assert.ok(matchesQuery(row('ORCL', 'Excellent', 80), 'orc'));
  assert.ok(matchesQuery({ symbol: 'X', name: 'Oracle Corporation' }, 'oracle'));
  assert.equal(composeView(loaded, 'all').ranked.filter((r) => matchesQuery(r, 'orcl')).length, 1);
  assert.equal(composeView(loaded, 'nasdaq').ranked.filter((r) => matchesQuery(r, 'orcl')).length, 0);
  assert.deepEqual(findElsewhere(loaded, 'nasdaq', 'orcl'),
    [{ symbol: 'ORCL', name: 'ORCL Corp', exchange: 'NYSE', label: 'NYSE top 100' }]);
  assert.deepEqual(findElsewhere(loaded, 'all', 'orcl'), []);
  assert.deepEqual(findElsewhere(loaded, 'nasdaq', ''), []);
});

test('quote links: the exchange page, then Yahoo Finance with its share-class format', () => {
  assert.equal(yahooSymbol('BRK.B'), 'BRK-B');
  assert.deepEqual(quoteLinks({ symbol: 'BRK.B', exchange: 'NYSE' }).map((l) => l.href), [
    'https://www.nyse.com/quote/XNYS:BRK.B', 'https://finance.yahoo.com/quote/BRK-B']);
  assert.equal(quoteLinks({ symbol: 'AAPL', exchange: 'NASDAQ' })[0].href,
    'https://www.nasdaq.com/market-activity/stocks/aapl');
});
