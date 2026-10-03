// Tests for the dividend engine. Synthetic lots, dividends and rates only.
// Run with:  node --test "tests/js/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeDividends, DTAA, monthEndBefore, QUARTERS, quarterOf } from '../../site/assets/js/dividends.js';
import { series } from '../../site/assets/js/schedule-fa.js';

/** Weekday values between two dates. */
function weekdays(from, to, valueOf) {
  const out = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push([iso, valueOf(iso)]);
  }
  return out;
}

// ₹80 until May 2025, ₹85 from June, ₹90 from December 2025.
const RATES = series(weekdays('2025-01-01', '2026-06-30', (d) => {
  if (d >= '2025-12-01') return 90;
  if (d >= '2025-06-01') return 85;
  return 80;
}));
const LOTS = [
  { id: 'L1', acquired: '2024-01-10', quantity: 10 },
  { id: 'L2', acquired: '2025-08-20', quantity: 2 }, // bought on an ex-dividend date
];
const DIVIDENDS = [
  { ex: '2025-03-20', pay: '2025-03-31', amount: 1 }, // previous financial year
  { ex: '2025-05-15', pay: '2025-06-12', amount: 1 },
  { ex: '2025-08-20', pay: '2025-09-11', amount: 1 },
  { ex: '2025-11-20', pay: '2025-12-11', amount: 2 },
  { ex: '2026-02-19', pay: '2026-03-12', amount: 2 },
  { ex: '2026-03-10', pay: '2026-03-20', amount: 1 },
  { ex: '2026-03-25', pay: '2026-04-10', amount: 1 }, // next financial year
];

test('Rule 115 date: the last day of the month before payment', () => {
  assert.equal(monthEndBefore('2026-06-11'), '2026-05-31');
  assert.equal(monthEndBefore('2026-01-15'), '2025-12-31');
  assert.equal(monthEndBefore('2024-03-05'), '2024-02-29');
});

test('Schedule OS periods for advance-tax interest', () => {
  assert.equal(QUARTERS.length, 5);
  const q = (iso) => quarterOf(iso, 2025);
  assert.deepEqual(['2025-04-01', '2025-06-15', '2025-06-16', '2025-09-15', '2025-09-16', '2025-12-15',
    '2025-12-16', '2026-03-15', '2026-03-16', '2026-03-31'].map(q), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
});

test('a financial year of dividends: eligibility, conversion and form values', () => {
  const r = computeDividends({ lots: LOTS, dividends: DIVIDENDS, rates: RATES, fy: 2025, today: '2026-06-01',
    indiaRate: 0.312 });
  assert.equal(r.final, true);
  assert.deepEqual(r.rows.map((x) => x.pay), ['2025-06-12', '2025-09-11', '2025-12-11', '2026-03-12', '2026-03-20']);
  // L2 was bought on the August ex-date, so that payment is on 10 shares only.
  assert.deepEqual(r.rows.map((x) => x.shares), [10, 10, 12, 12, 12]);
  // 31 May 2025 was a Saturday: the rate from Friday 30 May applies.
  assert.equal(r.rows[0].rateDate, '2025-05-31');
  assert.deepEqual(r.rows[0].rate, { date: '2025-05-30', rate: 80 });
  assert.deepEqual(r.rows.map((x) => x.gross), [800, 850, 2040, 2160, 1080]);
  assert.deepEqual(r.rows.map((x) => x.tax), [200, 213, 510, 540, 270]);
  assert.equal(r.totals.income, 6930);
  assert.equal(r.totals.taxPaid, 1733);
  assert.deepEqual(r.quarters, [800, 850, 2040, 2160, 1080]);
  assert.equal(r.quarters.reduce((a, b) => a + b, 0), r.totals.income);
  // Credit: the US tax paid, which is below the Indian tax on the same income.
  assert.equal(r.taxIndia, Math.round(6930 * 0.312));
  assert.equal(r.relief, 1733);
  assert.equal(DTAA.article, 10);
});

test('the credit is capped by the Indian tax and by the treaty rate', () => {
  const low = computeDividends({ lots: LOTS, dividends: DIVIDENDS, rates: RATES, fy: 2025, today: '2026-06-01',
    indiaRate: 0.208 });
  assert.equal(low.relief, Math.round(6930 * 0.208));
  // Without a W-8BEN the US withholds 30%, but only the treaty's 25% is creditable.
  const noForm = computeDividends({ lots: LOTS, dividends: DIVIDENDS, rates: RATES, fy: 2025, today: '2026-06-01',
    usRate: 0.3, indiaRate: 0.3588 });
  assert.equal(noForm.totals.taxPaid, 240 + 255 + 612 + 648 + 324);
  assert.equal(noForm.relief, Math.round(6930 * 0.25));
});

test('a year in progress counts only payments already made', () => {
  const r = computeDividends({ lots: LOTS, dividends: DIVIDENDS, rates: RATES, fy: 2025, today: '2026-03-15',
    indiaRate: 0.312 });
  assert.equal(r.final, false);
  assert.equal(r.rows.length, 4);
  assert.deepEqual(r.upcoming.map((d) => d.pay), ['2026-03-20']);
  assert.equal(r.quarters[4], 0);
  assert.equal(computeDividends({ lots: LOTS, dividends: DIVIDENDS, rates: RATES, fy: 2025, today: '2026-06-01' }).relief,
    null, 'no credit without an Indian tax rate');
});

test('sold lots get dividends with an ex-date while they were held', () => {
  const lots = [
    ...LOTS,
    { id: 'S1', acquired: '2024-01-10', quantity: 5, sold: '2025-11-20' }, // sold on the November ex-date
    { id: 'S2', acquired: '2024-01-10', quantity: 4, sold: '2025-11-19' }, // sold the day before it
  ];
  const r = computeDividends({ lots, dividends: DIVIDENDS, rates: RATES, fy: 2025, today: '2026-06-01' });
  // May and August: both sold lots; November: S1 only (sold on the ex-date); later: neither.
  assert.deepEqual(r.rows.map((x) => x.shares), [19, 19, 17, 12, 12]);
});
