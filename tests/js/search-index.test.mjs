// Tests for the site-wide search index. Synthetic snapshots only.
// Run with:  node --test "tests/js/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildIndex, norm, PAGES, searchIndex } from '../../site/assets/js/search-index.js';

const india = {
  ranked: [
    { symbol: 'TCS', name: 'Tata Consultancy Services Ltd.', rank: 1 },
    { symbol: 'TATAMOTORS', name: 'Tata Motors Ltd.', rank: 2 },
    { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd.', rank: 3 },
  ],
  others: [{ symbol: 'NEWCO', name: 'New Listing Ltd.', rank: null }],
};
const nasdaq = { ranked: [{ symbol: 'AAPL', name: 'Apple Inc.', rank: 1, exchange: 'NASDAQ' }], others: [] };
const fund = (code, name, amc, rank) => ({ code, name, amc, rank });
const mf = {
  groups: [
    { key: 'nifty50', label: 'Nifty 50 index funds', short: 'Nifty 50', kind: 'index',
      funds: [fund(1, 'Navi Nifty 50 Index Fund', 'Navi', 1), fund(2, 'HDFC Nifty 50 Index Fund', 'HDFC', 2)] },
    { key: 'nifty50ew', label: 'Nifty 50 Equal Weight index funds', short: 'Nifty 50 EW', kind: 'index',
      funds: [fund(3, 'DSP Nifty 50 Equal Weight Index Fund', 'DSP', 1)] },
    { key: 'nifty500', label: 'Nifty 500 index funds', short: 'Nifty 500', kind: 'index',
      funds: [fund(4, 'Motilal Oswal Nifty 500 Index Fund', 'Motilal Oswal', 1)] },
    { key: 'flexi', label: 'Flexi cap funds', short: 'Flexi cap', kind: 'active',
      funds: [fund(5, 'Parag Parikh Flexi Cap Fund', 'PPFAS', 1), fund(6, 'Old Fund', 'X', null)] },
    { key: 'gold', label: 'Gold funds', short: 'Gold', kind: 'metal',
      funds: [fund(7, 'SBI Gold Fund', 'SBI', 1)] },
  ],
};
const items = buildIndex({ india, us: [{ snap: nasdaq, label: 'NASDAQ-100' }], mf });
const titles = (q, opts) => searchIndex(items, q, opts).map((it) => it.title);

test('norm folds case, accents and punctuation', () => {
  assert.equal(norm('  Nifty-50 (Index) '), 'nifty 50 index');
  assert.equal(norm('Café'), 'cafe');
  assert.equal(norm(null), '');
});

test('the index holds pages, stocks of both markets, groups and funds with their links', () => {
  assert.equal(items.filter((it) => it.kind === 'page').length, PAGES.length);
  const tcs = items.find((it) => it.sym === 'TCS');
  assert.equal(tcs.href, 'india/?stock=TCS');
  assert.equal(tcs.meta, '#1 · Nifty 100');
  assert.equal(items.find((it) => it.sym === 'NEWCO').meta, 'Not ranked');
  const aapl = items.find((it) => it.sym === 'AAPL');
  assert.equal(aapl.href, 'us/?stock=AAPL');
  assert.equal(aapl.badge, 'NASDAQ');
  assert.equal(items.find((it) => it.kind === 'group' && it.group === 'flexi').href, 'mf/#flexi');
  assert.equal(items.find((it) => it.kind === 'group' && it.group === 'gold').sub, 'Metal funds · 1 direct plans');
  const ppfas = items.find((it) => it.code === 5);
  assert.equal(ppfas.href, 'mf/?fund=5#flexi');
  assert.equal(ppfas.meta, '#1 of 1');
  assert.equal(items.find((it) => it.code === 6).meta, 'Not ranked');
});

test('missing snapshots leave just the pages', () => {
  assert.deepEqual(buildIndex(), PAGES);
  assert.deepEqual(buildIndex({ us: [{ snap: null, label: 'X' }] }), PAGES);
});

test('an exact symbol comes first, then symbols that start with it', () => {
  assert.deepEqual(titles('tcs').slice(0, 1), ['TCS']);
  assert.deepEqual(titles('tata').slice(0, 2), ['TATAMOTORS', 'TCS']);
  assert.equal(titles('tatam')[0], 'TATAMOTORS');
  assert.equal(titles('AAPL')[0], 'AAPL');
});

test('whole-word matches beat partial ones, and the closer title wins a tie', () => {
  assert.deepEqual(titles('nifty 50').slice(0, 3),
    ['Nifty 50 index funds', 'Nifty 50 Equal Weight index funds', 'Nifty 500 index funds']);
  assert.deepEqual(searchIndex(items, 'nifty 50').filter((it) => it.kind === 'fund').map((it) => it.title),
    ['Navi Nifty 50 Index Fund', 'DSP Nifty 50 Equal Weight Index Fund', 'HDFC Nifty 50 Index Fund',
      'Motilal Oswal Nifty 500 Index Fund']);
});

test('funds are found by name, fund house and group', () => {
  assert.equal(titles('parag')[0], 'Parag Parikh Flexi Cap Fund');
  assert.ok(titles('ppfas').includes('Parag Parikh Flexi Cap Fund'));
  assert.ok(titles('flexi cap').includes('Flexi cap funds'));
  assert.ok(titles('hdfc').includes('HDFC Nifty 50 Index Fund'));
  assert.equal(titles('hdfc')[0], 'HDFCBANK');
});

test('pages and tools are found by their extra words', () => {
  assert.equal(titles('sip')[0], 'SIP split by age');
  assert.ok(titles('schedule fa').includes('Microsoft shares at Fidelity'));
  assert.ok(titles('lumpsum').includes('Lump sum check'));
});

test('every word must match, in any order', () => {
  assert.ok(titles('fund navi').includes('Navi Nifty 50 Index Fund'));
  assert.deepEqual(titles('navi apple'), []);
});

test('empty queries find nothing, and the results are capped per kind and in total', () => {
  assert.deepEqual(titles(''), []);
  assert.deepEqual(titles('   '), []);
  const many = buildIndex({ india: { ranked: Array.from({ length: 30 }, (_, i) => ({ symbol: `ABC${i}`, name: 'Abc Ltd.', rank: i + 1 })) } });
  assert.equal(searchIndex(many, 'abc').length, 8);
  assert.equal(searchIndex(items, 'fund', { limit: 3 }).length, 3);
});
