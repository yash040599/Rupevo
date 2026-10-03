// Tests for the capital gains engine. Synthetic prices, rates and lots only.
// Run with:  node --test "tests/js/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addMonths, capitalGainsCsv, computeCapitalGains, fyOf, isLongTerm, longTermFrom, ltcgRateFor, monthsHeld,
} from '../../site/assets/js/capital-gains.js';
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

// ₹80 in 2022, ₹82 in 2023, ₹83 in 2024, ₹85 from 2025, ₹88 from October 2025.
const RATES = series(weekdays('2022-01-03', '2026-06-30', (d) => {
  if (d >= '2025-10-01') return 88;
  if (d >= '2025-01-01') return 85;
  if (d >= '2024-01-01') return 83;
  if (d >= '2023-01-01') return 82;
  return 80;
}));
const PRICES = series(weekdays('2022-01-03', '2026-06-30', () => 100));
const lot = (id, acquired, quantity, costPerShare, sold, proceeds) => ({
  id, acquired, quantity, costPerShare, costBasis: quantity * costPerShare, sold, proceeds,
  grantDate: null, source: null,
});
const LOTS = [
  lot('C1', '2022-08-15', 10, 100, '2025-10-21', 1500), // RSU, long-term, rupee fell 80 → 85
  lot('C2', '2025-02-14', 2, 100, '2025-06-03', 180), // RSU, short-term loss
  lot('C3', '2025-03-31', 1, 90, '2026-03-20', 120), // ESPP (10% below the close), short-term
  lot('C4', '2023-01-10', 3, 100, '2025-07-01', null), // transferred out, not sold
  lot('C5', '2024-05-15', 1, 100, '2026-04-22', 130), // sold in FY 2026-27
  lot('C6', '2023-05-15', 1, 100, '2025-03-03', 110), // sold in FY 2024-25
];

test('24 months: long-term from the day after, month ends clamp', () => {
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(addMonths('2024-02-29', 24), '2026-02-28');
  assert.equal(longTermFrom('2023-08-15'), '2025-08-16');
  assert.equal(longTermFrom('2024-02-29'), '2026-03-01');
  assert.equal(isLongTerm('2023-08-15', '2025-08-15'), false, 'exactly 24 months is short-term');
  assert.equal(isLongTerm('2023-08-15', '2025-08-16'), true);
  assert.equal(monthsHeld('2023-08-15', '2025-08-14'), 23);
  assert.equal(monthsHeld('2023-08-15', '2025-08-15'), 24);
  assert.equal(monthsHeld('2024-01-31', '2024-02-29'), 1);
  assert.equal(fyOf('2026-03-31'), 2025);
  assert.equal(fyOf('2026-04-01'), 2026);
});

test('long-term tax rate follows the surcharge in the slab rate, capped at 15%', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  near(ltcgRateFor(0.052), 0.13);
  near(ltcgRateFor(0.312), 0.13);
  near(ltcgRateFor(0.3432), 0.125 * 1.1 * 1.04);
  near(ltcgRateFor(0.3588), 0.125 * 1.15 * 1.04);
  near(ltcgRateFor(0.39), 0.125 * 1.15 * 1.04);
});

test('a financial year of sales: Rule 115 sale value, cost at the acquisition-date rate', () => {
  const r = computeCapitalGains({ lots: LOTS, prices: PRICES, rates: RATES, fy: 2025, today: '2026-06-01',
    indiaRate: 0.312 });
  assert.equal(r.final, true);
  assert.deepEqual(r.rows.map((x) => [x.lot.id, x.term, x.type]), [
    ['C2', 'short', 'RSU'], ['C1', 'long', 'RSU'], ['C3', 'short', 'ESPP']]);
  assert.deepEqual(r.transfers.map((l) => l.id), ['C4']);
  assert.deepEqual(r.elsewhere, [{ fy: 2024, count: 1 }, { fy: 2026, count: 1 }]);

  const [c2, c1, c3] = r.rows;
  // Sold 21 Oct 2025: the rate on 30 September 2025 applies.
  assert.equal(c1.sale.rateDate, '2025-09-30');
  assert.deepEqual(c1.sale.rate, { date: '2025-09-30', rate: 85 });
  assert.equal(c1.sale.inr, 1500 * 85);
  assert.equal(c1.cost.inr, 1000 * 80);
  assert.equal(c1.gain, 1500 * 85 - 1000 * 80);
  assert.equal(c1.currency, 1000 * (85 - 80), 'the rupee falling from ₹80 to ₹85 on the cost');
  assert.equal(c1.months, 38);
  // Sold 3 June 2025: 31 May was a Saturday, so Friday's rate.
  assert.deepEqual(c2.sale.rate, { date: '2025-05-30', rate: 85 });
  assert.equal(c2.gain, 180 * 85 - 200 * 85);
  // ESPP cost is the market price on the purchase day ($100), not the $90 paid.
  assert.equal(c3.cost.usd, 100);
  assert.equal(c3.cost.inr, 100 * 85);
  assert.equal(c3.sale.inr, 120 * 88);

  assert.deepEqual(r.short, { count: 2, pending: 0, consideration: 15300 + 10560, cost: 17000 + 8500, expenses: 0,
    deductions: 17000 + 8500, gain: 360 });
  assert.deepEqual(r.long, { count: 1, pending: 0, consideration: 127500, cost: 80000, expenses: 0, deductions: 80000,
    gain: 47500 });
  assert.equal(r.complete, true);
  // The June loss comes off the March gain; periods add up to the totals after set-off.
  assert.deepEqual(r.periods.short, [0, 0, 0, 0, 360]);
  assert.deepEqual(r.periods.long, [0, 0, 47500, 0, 0]);
  assert.deepEqual(r.tax, { shortRate: 0.312, longRate: 0.13, short: 112, long: 6175, total: 6287 });
  assert.deepEqual(r.fsi, { income: 47860, taxPaid: 0, taxIndia: 6287, relief: 0, article: 13 });
});

test('cost at the sale rate: the dollar gain × the Rule 115 rate, no currency part', () => {
  const r = computeCapitalGains({ lots: LOTS, prices: PRICES, rates: RATES, fy: 2025, today: '2026-06-01',
    costRate: 'sale' });
  const c1 = r.rows.find((x) => x.lot.id === 'C1');
  assert.equal(c1.cost.inr, 1000 * 85);
  assert.equal(c1.gain, 500 * 85);
  assert.equal(c1.currency, 0);
  assert.equal(r.tax.short, null, 'no slab rate given');
});

test('losses: short-term against long-term gains, long-term losses only carried forward', () => {
  const a = computeCapitalGains({ lots: [LOTS[0], LOTS[1]], prices: PRICES, rates: RATES, fy: 2025,
    today: '2026-06-01', indiaRate: 0.312 });
  assert.deepEqual(a.setOff, { shortAfter: 0, longAfter: 47500 - 1700, shortLossUsed: 1700, shortLossCarried: 0,
    longLossCarried: 0 });
  assert.deepEqual(a.periods.long, [0, 0, 45800, 0, 0]);
  assert.deepEqual(a.periods.short, [0, 0, 0, 0, 0]);

  const b = computeCapitalGains({
    lots: [lot('L', '2022-08-15', 10, 100, '2025-10-21', 800), LOTS[2]],
    prices: PRICES, rates: RATES, fy: 2025, today: '2026-06-01', indiaRate: 0.312 });
  assert.equal(b.long.gain, 800 * 85 - 1000 * 80);
  assert.deepEqual(b.setOff, { shortAfter: 2060, longAfter: 0, shortLossUsed: 0, shortLossCarried: 0,
    longLossCarried: 12000 });
  assert.equal(b.fsi.income, 2060);

  const c = computeCapitalGains({ lots: [LOTS[1]], prices: PRICES, rates: RATES, fy: 2025, today: '2026-06-01' });
  assert.equal(c.setOff.shortLossCarried, 1700);
  assert.equal(c.fsi, null, 'no foreign income to report with a net loss');
});

test('the 24-month boundary decides the term, not Fidelity', () => {
  const r = computeCapitalGains({
    lots: [lot('A', '2023-08-15', 1, 100, '2025-08-15', 100), lot('B', '2023-08-15', 1, 100, '2025-08-18', 100)],
    prices: PRICES, rates: RATES, fy: 2025, today: '2026-06-01' });
  assert.deepEqual(r.rows.map((x) => x.term), ['short', 'long']);
});

test('lots older than the rate history need the acquisition-date rate typed in', () => {
  const old = lot('O', '2019-06-03', 1, 100, '2025-10-21', 200);
  const r = computeCapitalGains({ lots: [old, LOTS[1]], prices: PRICES, rates: RATES, fy: 2025, today: '2026-06-01' });
  const o = r.rows.find((x) => x.lot.id === 'O');
  assert.equal(o.needsAcqRate, true);
  assert.equal(o.acqRateMissing, 'before');
  assert.equal(o.gain, null);
  assert.equal(r.missingRates, 1);
  assert.equal(r.complete, false);
  assert.deepEqual(r.pending, { before: 1, later: 0, sale: 0 });
  assert.equal(r.ratesFrom, '2022-01-03');
  // The sale waiting for its rate is counted as pending, not as a long-term sale with no gain.
  assert.deepEqual([r.long.count, r.long.pending, r.short.count, r.short.pending], [0, 1, 1, 0]);
  const fixed = computeCapitalGains({ lots: [old], prices: PRICES, rates: RATES, fy: 2025, today: '2026-06-01',
    rateOverrides: { O: 69.5 } });
  assert.equal(fixed.rows[0].cost.inr, 6950);
  assert.equal(fixed.rows[0].gain, 200 * 85 - 6950);
  assert.equal(fixed.complete, true);
});

test('a rate not in the data yet is missing, not replaced by an older one', () => {
  // Rates published up to Friday 25 September 2026: a sale on 1 October needs the 30 September rate.
  const rates = series(weekdays('2026-01-05', '2026-09-25', () => 90));
  const prices = series(weekdays('2026-01-05', '2026-10-02', () => 100));
  const sold = lot('S', '2026-03-16', 1, 100, '2026-10-01', 120);
  const r = computeCapitalGains({ lots: [sold], prices, rates, fy: 2026, today: '2026-10-03' });
  assert.equal(r.rows[0].sale.rateDate, '2026-09-30');
  assert.equal(r.rows[0].sale.rate, null);
  assert.equal(r.rows[0].needsSaleRate, true);
  assert.equal(r.rows[0].gain, null);
  assert.deepEqual(r.pending, { before: 0, later: 0, sale: 1 });
  assert.equal(r.ratesTo, '2026-09-25');
  assert.equal(r.short.consideration, 0);
  // Shares sold the day they vested, after the last published rate: the acquisition rate is pending.
  const vest = lot('V', '2026-10-01', 1, 100, '2026-10-01', 100);
  const v = computeCapitalGains({ lots: [vest], prices, rates: series(weekdays('2026-01-05', '2026-09-30', () => 90)),
    fy: 2026, today: '2026-10-03' });
  assert.equal(v.rows[0].sale.rate.date, '2026-09-30');
  assert.equal(v.rows[0].acqRateMissing, 'later');
  assert.deepEqual(v.pending, { before: 0, later: 1, sale: 0 });
  const typed = computeCapitalGains({ lots: [vest], prices, rates: series(weekdays('2026-01-05', '2026-09-30', () => 90)),
    fy: 2026, today: '2026-10-03', rateOverrides: { V: 91 } });
  assert.equal(typed.rows[0].gain, 100 * 90 - 100 * 91);
  // Weekends and holidays inside the data still use the last rate before them.
  const weekend = computeCapitalGains({ lots: [lot('W', '2026-03-16', 1, 100, '2026-06-02', 120)], prices,
    rates, fy: 2026, today: '2026-10-03' });
  assert.deepEqual(weekend.rows[0].sale.rate, { date: '2026-05-29', rate: 90 }, '31 May 2026 was a Sunday');
});

test('CSV of the sales with DD/MM/YYYY dates', () => {
  const r = computeCapitalGains({ lots: [LOTS[0]], prices: PRICES, rates: RATES, fy: 2025, today: '2026-06-01' });
  const [head, row] = capitalGainsCsv(r).trim().split('\n');
  assert.match(head, /^Sale date,Acquired,Type,Shares,Term \(India\)/);
  assert.match(row, /^21\/10\/2025,15\/08\/2022,RSU,10,Long-term,38,16\/08\/2024,1500.00,30\/09\/2025,85,127500,/);
});
