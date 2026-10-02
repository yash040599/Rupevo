// The published sample export, run through the parser and the Schedule FA engine with the
// published reference data, as the "Try with sample data" button does.
// Run with:  node --test "tests/js/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseOpenLots } from '../../site/assets/js/fidelity.js';
import { computeScheduleFA, priceCheck, series } from '../../site/assets/js/schedule-fa.js';

const read = (path) => readFileSync(new URL(`../../site/${path}`, import.meta.url), 'utf8');
const stock = JSON.parse(read('data/tax/msft.json'));
const fx = JSON.parse(read('data/tax/sbi-tt-buy-usd.json'));
const { lots } = parseOpenLots(read('assets/samples/fidelity-msft-open-lots-sample.csv'));

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
