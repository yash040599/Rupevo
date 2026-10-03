// The synthetic sample export (tests/fixtures, made by scripts/make_sample_export.py), run through
// the parser and the Schedule FA and dividend engines with the published reference data.
// Run with:  node --test "tests/js/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseOpenLots } from '../../site/assets/js/fidelity.js';
import { computeScheduleFA, priceCheck, series } from '../../site/assets/js/schedule-fa.js';
import { computeDividends } from '../../site/assets/js/dividends.js';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const stock = JSON.parse(read('site/data/tax/msft.json'));
const oracle = JSON.parse(read('site/data/tax/orcl.json'));
const fx = JSON.parse(read('site/data/tax/sbi-tt-buy-usd.json'));
const { lots } = parseOpenLots(read('tests/fixtures/fidelity-msft-open-lots-sample.csv'));

test('sample export: 16 lots, half RSU vests and half ESPP purchases', () => {
  assert.equal(lots.length, 16);
  assert.deepEqual(priceCheck(lots, series(stock.closes)), { checked: 16, off: 0, ok: true });
  const result = computeScheduleFA({ lots, prices: series(stock.closes), rates: series(fx.rates),
    dividends: stock.dividends, cy: 2025, today: '2026-10-03' });
  assert.equal(result.final, true);
  assert.equal(result.rows.length + result.excluded.length, 16);
  const types = result.rows.map((r) => r.type);
  assert.deepEqual([...new Set(types)].sort(), ['ESPP', 'RSU']);
  assert.ok(result.rows.every((r) => !r.initial.needsRate), 'every lot has an SBI rate');
  for (const r of result.rows) {
    for (const v of [r.initial.inr, r.peak.inr, r.closing.inr, r.dividends.inr]) {
      assert.ok(Number.isInteger(v) && v >= 0);
    }
    assert.ok(r.peak.inr >= r.closing.inr, 'the peak is at least the 31 December value');
  }
  assert.equal(result.account.closing.inr, result.totals.closing);
  assert.ok(result.totals.dividends > 0, 'Microsoft paid dividends in 2025');
});

test('sample export: dividends for FY 2025-26 add up across the forms', () => {
  const r = computeDividends({ lots, dividends: stock.dividends, rates: series(fx.rates), fy: 2025,
    today: '2026-10-03', indiaRate: 0.312 });
  assert.equal(r.final, true);
  assert.equal(r.rows.length, 4, 'Microsoft pays quarterly');
  assert.ok(r.rows.every((x) => x.rate && x.rate.date <= x.rateDate && x.rateDate < x.pay));
  assert.equal(r.quarters.reduce((a, b) => a + b, 0), r.totals.income);
  assert.ok(Math.abs(r.totals.taxPaid - r.totals.income * 0.25) <= r.rows.length, '25% US tax, rounded per payment');
  assert.equal(r.relief, r.totals.taxPaid, 'at 31.2% the whole US tax is credited');
});

test('Oracle data: four quarterly payments in FY 2025-26 with payment dates', () => {
  const holder = [{ id: 'L1', acquired: '2024-08-15', quantity: 10, costPerShare: 140 }];
  const r = computeDividends({ lots: holder, dividends: oracle.dividends, rates: series(fx.rates), fy: 2025,
    today: '2026-10-03', indiaRate: 0.312 });
  assert.equal(r.rows.length, 4);
  assert.ok(r.rows.every((x) => x.payKnown && x.perShare === 0.5));
  assert.ok(Math.abs(r.totals.grossUsd - 20) < 1e-9);
});
