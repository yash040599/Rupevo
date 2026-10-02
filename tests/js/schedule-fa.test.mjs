// Tests for the Schedule FA engine. Synthetic prices, rates and lots only.
// Run with:  node --test "tests/js/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyLot, computeScheduleFA, firstOnOrAfter, lastOnOrBefore, priceCheck, rateOn, returnOptions,
  scheduleFaCsv, series,
} from '../../site/assets/js/schedule-fa.js';

/** Weekday closes between two dates, from a function of the date. */
function weekdays(from, to, valueOf) {
  const out = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    const iso = d.toISOString().slice(0, 10);
    if (dow !== 0 && dow !== 6) out.push([iso, valueOf(iso)]);
  }
  return out;
}

// Flat $100 all year, a single $150 spike on 2025-06-16, $120 from 2025-10-01.
const PRICES = series(weekdays('2024-01-01', '2026-03-31', (d) => {
  if (d === '2025-06-16') return 150;
  if (d >= '2025-10-01') return 120;
  return 100;
}));
// ₹80 until June 2025, ₹85 from 2025-06-02, ₹90 from 2025-12-01; no rate on 2025-12-31.
const RATES = series(weekdays('2024-01-01', '2026-03-31', (d) => {
  if (d >= '2025-12-01') return 90;
  if (d >= '2025-06-02') return 85;
  return 80;
}).filter(([d]) => d !== '2025-12-31'));
const DIVIDENDS = [
  { ex: '2025-05-15', pay: '2025-06-12', amount: 1 },
  { ex: '2025-11-20', pay: '2025-12-11', amount: 2 },
  { ex: '2026-02-19', pay: '2026-03-12', amount: 3 },
];
const lot = (id, acquired, quantity, costPerShare, extra = {}) => (
  { id, acquired, quantity, costPerShare, costBasis: quantity * costPerShare, grantDate: null, source: 'DO', ...extra });

test('series lookups', () => {
  const s = series([['2025-01-02', 1], ['2025-01-03', 2], ['2025-01-06', 3]]);
  assert.equal(lastOnOrBefore(s, '2025-01-05'), 1);
  assert.equal(lastOnOrBefore(s, '2025-01-01'), -1);
  assert.equal(firstOnOrAfter(s, '2025-01-04'), 2);
  assert.equal(firstOnOrAfter(s, '2025-02-01'), 3);
  assert.deepEqual(rateOn(s, '2025-01-05'), { date: '2025-01-03', rate: 2 });
  assert.equal(rateOn(s, '2024-12-31'), null);
});

test('return options: previous and current FY, next FY once its calendar year starts', () => {
  const oct = returnOptions('2026-10-02');
  assert.deepEqual(oct.map((o) => [o.fyLabel, o.yearLabel, o.cy, o.isDefault, o.complete]), [
    ['FY 2025-26', 'AY 2026-27', 2025, false, true],
    ['FY 2026-27', 'tax year 2026-27', 2026, true, false],
  ]);
  const feb = returnOptions('2027-02-10');
  assert.deepEqual(feb.map((o) => [o.cy, o.isDefault, o.complete]), [
    [2025, false, true], [2026, true, true], [2027, false, false]]);
  assert.deepEqual(returnOptions('2027-04-01').map((o) => o.cy), [2026, 2027]);
});

test('ESPP lots are recognised by their discount to the close and valued at FMV', () => {
  const espp = lot('E', '2025-03-31', 1, 90, { grantDate: '2025-01-02', source: 'SP' });
  assert.deepEqual(classifyLot(espp, PRICES), { type: 'ESPP', fmvPerShare: 100, basis: 'close', basisDate: '2025-03-31' });
  assert.equal(classifyLot(espp, PRICES, { esppBasis: 'paid' }).fmvPerShare, 90);
  const rsu = lot('R', '2025-03-31', 1, 99.5);
  assert.equal(classifyLot(rsu, PRICES).type, 'RSU');
  // A grant date alone is not enough: an RSU at market price stays an RSU.
  assert.equal(classifyLot({ ...rsu, grantDate: '2024-03-01' }, PRICES).type, 'RSU');
  const old = lot('O', '2010-03-31', 1, 9, { grantDate: '2010-01-02', source: 'SP' });
  assert.deepEqual(classifyLot(old, PRICES), { type: 'ESPP', fmvPerShare: 10, basis: 'estimated' });
});

test('completed year: initial, peak, 31 December and dividends per lot', () => {
  const lots = [
    lot('L1', '2024-08-15', 10, 95),     // held all of 2025
    lot('L2', '2025-08-15', 2, 100),     // acquired after the June spike
    lot('L3', '2025-11-20', 1, 120),     // acquired on an ex-dividend date
    lot('L4', '2026-02-17', 5, 120),     // acquired after the year
  ];
  const r = computeScheduleFA({ lots, prices: PRICES, rates: RATES, dividends: DIVIDENDS, cy: 2025, today: '2026-10-02' });
  assert.equal(r.final, true);
  assert.deepEqual(r.excluded.map((x) => x.lot.id), ['L4']);
  const [a, b, c] = r.rows;

  assert.equal(a.initial.inr, 10 * 95 * 80);
  assert.equal(a.peak.date, '2025-06-16');
  assert.equal(a.peak.inr, 10 * 150 * 85);
  // 31 Dec 2025 has no SBI rate, so the previous working day's rate applies.
  assert.equal(a.closing.rate.date, '2025-12-30');
  assert.equal(a.closing.inr, 10 * 120 * 90);
  // Dividends paid in 2025 at the payment-date rate: $1 (June) and $2 (December).
  assert.equal(a.dividends.inr, 10 * 1 * 85 + 10 * 2 * 90);
  assert.equal(a.proceeds.inr, 0);

  assert.equal(b.peak.price, 120, 'the June spike was before L2 was acquired');
  assert.equal(b.peak.date, '2025-12-01', 'same dollar price as October, but a weaker rupee');
  assert.equal(b.peak.inr, 2 * 120 * 90);
  assert.equal(b.dividends.inr, 2 * 2 * 90);
  assert.equal(c.dividends.inr, 0, 'shares acquired on the ex-date get no dividend');

  // Table A2: the account peak is not the June price spike (10 shares × $150 × ₹85) but
  // 1 December, once L2 and L3 had joined and the rupee had weakened (13 shares × $120 × ₹90).
  assert.equal(r.account.peak.date, '2025-12-01');
  assert.equal(r.account.peak.inr, 13 * 120 * 90);
  assert.equal(r.account.closing.inr, (10 + 2 + 1) * 120 * 90);
  assert.equal(r.account.dividends, a.dividends.inr + b.dividends.inr);

  // Schedule AL on 31 March 2026 includes L4 (acquired in Feb 2026).
  assert.equal(r.al.provisional, false);
  assert.equal(r.al.lots, 4);
  assert.equal(r.al.inr, 10 * 95 * 80 + 2 * 100 * 85 + 1 * 120 * 85 + 5 * 120 * 90);

  for (const row of r.rows) {
    for (const v of [row.initial.inr, row.peak.inr, row.closing.inr, row.dividends.inr]) {
      assert.ok(Number.isInteger(v), 'portal values are whole rupees');
    }
  }
});

test('year in progress: provisional values up to the last price and paid dividends only', () => {
  const lots = [lot('L1', '2024-08-15', 10, 95)];
  const r = computeScheduleFA({ lots, prices: PRICES, rates: RATES, dividends: DIVIDENDS, cy: 2026, today: '2026-03-01' });
  assert.equal(r.final, false);
  assert.equal(r.closeDate, '2026-03-31', 'closing uses the latest price available');
  assert.equal(r.rows[0].closing.rate.date, '2026-03-31');
  assert.equal(r.rows[0].dividends.inr, 0, 'the March 2026 dividend is not paid yet');
  assert.equal(r.al.provisional, true);
  assert.equal(r.al.asOf, '2026-03-01');
});

test('account totals and Schedule AL add up the whole-rupee lot values shown in Table A3', () => {
  // Half-share lots at ₹83.33: each 31 Dec value is ₹4,999.80, so rounding each lot (3 × ₹5,000)
  // and rounding the sum (₹14,999) differ.
  const rates = series(RATES.dates.map((d) => [d, 83.33]));
  const lots = [
    lot('L1', '2025-01-15', 0.5, 100),
    lot('L2', '2025-02-14', 0.5, 100),
    lot('L3', '2025-03-14', 0.5, 100),
  ];
  const r = computeScheduleFA({ lots, prices: PRICES, rates, dividends: DIVIDENDS, cy: 2025, today: '2026-10-02' });
  const sumOf = (pick) => r.rows.reduce((a, row) => a + pick(row), 0);
  assert.notEqual(Math.round(sumOf((row) => row.closing.exact)), sumOf((row) => row.closing.inr),
    'the fixture should make the two ways of rounding differ');
  assert.equal(r.account.closing.inr, 15000);
  assert.equal(r.account.closing.inr, r.totals.closing);
  assert.equal(r.account.dividends, r.totals.dividends);
  assert.equal(r.al.inr, r.totals.initial);
});

test('the peak is the highest rupee value, which can be the 31 December value', () => {
  // Dollar peak in March, but by 31 December the rupee has fallen so far that the year-end
  // value is higher in rupees. 31 December has no price (a holiday) but has an SBI rate.
  const prices = series(weekdays('2025-01-01', '2025-12-31', (d) => (d === '2025-03-03' ? 110 : 100))
    .filter(([d]) => d !== '2025-12-31'));
  const rates = series([...weekdays('2025-01-01', '2025-12-30', () => 80), ['2025-12-31', 95]]);
  const r = computeScheduleFA({ lots: [lot('L1', '2025-01-02', 10, 100)], prices, rates, dividends: [],
    cy: 2025, today: '2026-01-10' });
  const [a] = r.rows;
  assert.equal(a.closing.inr, 10 * 100 * 95);
  assert.equal(a.peak.kind, 'closing', 'not the March dollar peak (10 × $110 × ₹80)');
  assert.equal(a.peak.inr, a.closing.inr);
  // The account's highest daily value (₹88,000 in March) is below its closing balance.
  assert.equal(r.account.peak.inr, r.account.closing.inr);
});

test('a lot acquired during the year peaks at no less than its initial value', () => {
  // Vested on the June spike day at $155, above that day's $150 close.
  const r = computeScheduleFA({ lots: [lot('V', '2025-06-16', 1, 155)], prices: PRICES, rates: RATES,
    dividends: [], cy: 2025, today: '2026-10-02' });
  const [v] = r.rows;
  assert.equal(v.initial.inr, 155 * 85);
  assert.equal(v.peak.kind, 'acquired');
  assert.equal(v.peak.inr, v.initial.inr);
  assert.ok(v.peak.inr > v.closing.inr);
});

test('price check: an export in rupees or for another company is caught', () => {
  const usdLots = [lot('R', '2025-03-31', 1, 100), lot('E', '2025-06-30', 1, 90, { grantDate: '2025-04-01' })];
  assert.deepEqual(priceCheck(usdLots, PRICES), { checked: 2, off: 0, ok: true });
  const inrLots = usdLots.map((l) => ({ ...l, costPerShare: l.costPerShare * 85 }));
  assert.equal(priceCheck(inrLots, PRICES).ok, false);
  // Lots older than the price history are not judged.
  assert.deepEqual(priceCheck([lot('O', '2010-01-04', 1, 30)], PRICES), { checked: 0, off: 0, ok: true });
});

test('lots older than the SBI rate history need a rate typed in', () => {
  const lots = [lot('L1', '2019-06-03', 1, 100)];
  const prices = series([['2019-06-03', 100], ...PRICES.dates.map((d, i) => [d, PRICES.values[i]])]);
  const r = computeScheduleFA({ lots, prices, rates: RATES, dividends: [], cy: 2025, today: '2026-10-02' });
  assert.equal(r.rows[0].initial.needsRate, true);
  assert.equal(r.rows[0].initial.inr, null);
  assert.match(r.warnings.join(' '), /before the SBI rate history/);
  const fixed = computeScheduleFA({ lots, prices, rates: RATES, dividends: [], cy: 2025, today: '2026-10-02',
    rateOverrides: { L1: 69.5 } });
  assert.equal(fixed.rows[0].initial.inr, 6950);
});

test('CSV export has the portal columns and DD/MM/YYYY dates', () => {
  const r = computeScheduleFA({ lots: [lot('L1', '2024-08-15', 10, 95)], prices: PRICES, rates: RATES,
    dividends: DIVIDENDS, cy: 2025, today: '2026-10-02' });
  const csv = scheduleFaCsv(r, { country: '2 - United States of America', name: 'Example Corp',
    address: '1 Main St, City', zip: '00000', nature: 'Listed company' });
  const [head, row] = csv.trim().split('\n');
  assert.match(head, /^Row,Country\/Region name and code,Name of entity/);
  assert.match(row, /^1,2 - United States of America,Example Corp,"1 Main St, City",00000,Listed company,15\/08\/2024,76000,127500,108000/);
});
