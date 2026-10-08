// Tests for the mutual fund page's pure helpers: the SIP split, SIP maths and lookups.
// Run with:  node --test "tests/js/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGE_BANDS, RISK_LEVELS, SLICES, SPLITS, allocation, equityShare, findInOtherGroups, groupFromHash, lagOf,
  matchesFund, sipValue, splitAmount, trackingGapValue,
} from '../../site/assets/js/mf-plan.js';

const AGE_MIDPOINT = { u30: 25, '30s': 37, '45s': 52, '60p': 65 };

test('every split covers every slice and adds up to 100%', () => {
  for (const band of AGE_BANDS) {
    for (const risk of RISK_LEVELS) {
      const row = SPLITS[band.key][risk.key];
      assert.equal(row.length, SLICES.length, `${band.key}/${risk.key}`);
      assert.equal(row.reduce((a, b) => a + b, 0), 100, `${band.key}/${risk.key}`);
      assert.ok(row.every((p) => p >= 0 && p % 5 === 0), `${band.key}/${risk.key}: whole 5% steps`);
    }
  }
});

test('shares follow "100 minus age", 15 points either side of balanced', () => {
  for (const band of AGE_BANDS) {
    const balanced = equityShare(band.key, 'balanced');
    assert.ok(Math.abs(balanced - (100 - AGE_MIDPOINT[band.key])) <= 3, `${band.key}: ${balanced}`);
    assert.equal(equityShare(band.key, 'cautious'), balanced - 15);
    assert.equal(equityShare(band.key, 'aggressive'), balanced + 15);
  }
});

test('risk shrinks with age: no slice of shares grows as you get older', () => {
  const order = AGE_BANDS.map((b) => b.key);
  for (const risk of RISK_LEVELS) {
    for (let i = 1; i < order.length; i += 1) {
      const younger = allocation(order[i - 1], risk.key);
      const older = allocation(order[i], risk.key);
      for (const key of ['mid', 'small']) {
        const y = younger.find((s) => s.key === key).pct;
        const o = older.find((s) => s.key === key).pct;
        assert.ok(o <= y, `${risk.key} ${key}: ${order[i]} ${o}% > ${order[i - 1]} ${y}%`);
      }
      assert.ok(equityShare(order[i], risk.key) < equityShare(order[i - 1], risk.key));
    }
  }
  assert.equal(allocation('60p', 'cautious').find((s) => s.key === 'small').pct, 0);
  assert.equal(allocation('nope', 'balanced'), null);
});

test('the biggest share slice is the low-cost core', () => {
  for (const band of AGE_BANDS) {
    for (const risk of RISK_LEVELS) {
      const slices = allocation(band.key, risk.key).filter((s) => s.equity);
      const core = slices.find((s) => s.key === 'core').pct;
      assert.ok(slices.every((s) => s.pct <= core), `${band.key}/${risk.key}`);
    }
  }
});

test('an amount splits into whole rupees that add up', () => {
  const slices = allocation('u30', 'balanced');
  assert.deepEqual(splitAmount(10000, slices), [3500, 2000, 1000, 1000, 2500]);
  const odd = splitAmount(1003, slices);
  assert.equal(odd.reduce((a, b) => a + b, 0), 1003);
  assert.deepEqual(splitAmount(-5, slices), [0, 0, 0, 0, 0]);
});

test('SIP maths', () => {
  assert.equal(sipValue(1000, 1, 0), 12000);
  // Brute force: add each month's instalment at the start of the month, then grow it a month.
  const brute = (monthly, years, pct) => {
    const rate = (1 + pct / 100) ** (1 / 12) - 1;
    let value = 0;
    for (let m = 0; m < years * 12; m += 1) value = (value + monthly) * (1 + rate);
    return value;
  };
  for (const [years, pct] of [[15, 12], [5, 7.5], [30, -2]]) {
    const want = brute(10000, years, pct);
    assert.ok(Math.abs(sipValue(10000, years, pct) - want) < want * 1e-9, `${years}y at ${pct}%`);
  }
  const gap = trackingGapValue(10000, 15, 12, -0.19, -0.42);
  assert.ok(gap > 85000 && gap < 100000, String(gap));
  assert.ok(trackingGapValue(10000, 15, 12, -0.5, -0.2) < 0, 'a wider gap ends with less');
});

test('the gap a fund is compared on: 3 years when published, else 1 year', () => {
  assert.equal(lagOf({ tracking_difference: { '1y': -0.1, '3y': -0.2 } }), -0.2);
  assert.equal(lagOf({ tracking_difference: { '1y': -0.1, '3y': null } }), -0.1);
  assert.equal(lagOf({}), null);
});

const groups = [
  { key: 'nifty50', funds: [{ code: 1, name: 'UTI Nifty 50 Index Fund', amc: 'UTI', rank: 1 }] },
  { key: 'midcap', funds: [{ code: 2, name: 'HDFC Mid Cap Fund', amc: 'HDFC', rank: 2 },
    { code: 3, name: 'UTI Mid Cap Fund', amc: 'UTI', rank: null }] },
];

test('groups from the URL hash', () => {
  assert.equal(groupFromHash('#midcap', groups), 'midcap');
  assert.equal(groupFromHash('#MIDCAP', groups), 'midcap');
  assert.equal(groupFromHash('#nope', groups), 'nifty50');
  assert.equal(groupFromHash('', groups.slice(1)), 'midcap', 'falls back to the first group');
});

test('search by fund name, fund house or code, across groups', () => {
  assert.ok(matchesFund(groups[1].funds[0], 'hdfc mid'));
  assert.ok(matchesFund(groups[1].funds[0], 'HDFC-Mid'));
  assert.ok(matchesFund(groups[1].funds[0], '2'));
  assert.ok(!matchesFund(groups[1].funds[0], 'small'));
  assert.ok(matchesFund(groups[1].funds[0], ''));
  const found = findInOtherGroups(groups, 'nifty50', 'uti');
  assert.deepEqual(found.map((h) => h.fund.code), [3]);
  assert.deepEqual(findInOtherGroups(groups, 'nifty50', '  '), []);
});
