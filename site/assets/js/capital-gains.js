// Capital gains on shares sold through a foreign broker, for one financial
// year, and the values they give for Schedule CG (ITR-2), its table of gains
// by period, and Schedule FSI.
// Pure functions, unit-tested in tests/js/capital-gains.test.mjs.
//
// Rules applied:
// * Shares not listed on an Indian stock exchange are long-term when held for
//   more than 24 months (section 2(42A)); the US one-year rule does not count.
// * Long-term gains: 12.5% without indexation (section 112, transfers from
//   23 July 2024), surcharge capped at 15%, plus 4% cess. Short-term gains are
//   taxed at the slab rate.
// * Rule 115: the sale value is converted at SBI's TT buying rate on the last
//   day of the month before the month of sale.
// * Section 49(2AA): the cost of RSU and ESPP shares is the fair market value
//   taxed as salary when they were allotted. It is converted at SBI's TT buying
//   rate on that day, so a fall in the rupee since then adds to the gain.
//   Option: convert the cost at the sale's Rule 115 rate (the dollar gain × that
//   rate), as some advisers do for shares bought with one's own dollars.
// * Losses: a short-term loss can be set off against any capital gain, a
//   long-term loss only against long-term gains; the rest is carried forward.
// * The India–US DTAA (Article 13) lets India tax these gains; the US does not
//   tax them for a non-resident, so there is no foreign tax credit.

import { addDays, classifyLot, rateOn } from './schedule-fa.js';
import { monthEndBefore, quarterOf, QUARTERS } from './dividends.js';

export const DTAA_GAINS = { country: 'United States of America', article: 13 };
export const LTCG_RATE = 0.125;
export const LT_MONTHS = 24;
export const NEW_RULES_FROM = '2024-07-23';
export { QUARTERS };

/** `iso` plus `n` calendar months, clamped to the end of a shorter month. */
export function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}

/** First sale date on which shares acquired on `acquired` are long-term: the day after 24 months. */
export function longTermFrom(acquired) {
  return addDays(addMonths(acquired, LT_MONTHS), 1);
}

export function isLongTerm(acquired, sold) {
  return sold >= longTermFrom(acquired);
}

/** Whole months from `from` to `to`. */
export function monthsHeld(from, to) {
  const [y1, m1] = from.split('-').map(Number);
  const [y2, m2] = to.split('-').map(Number);
  let n = (y2 - y1) * 12 + (m2 - m1);
  if (addMonths(from, n) > to) n -= 1;
  return n;
}

/** First calendar year of the financial year that contains `iso`. */
export function fyOf(iso) {
  const [y, m] = iso.split('-').map(Number);
  return m >= 4 ? y : y - 1;
}

/**
 * Tax rate on long-term gains for someone whose slab rate (with surcharge and
 * cess) is `indiaRate`: 12.5% plus the same surcharge, capped at 15%, plus 4%
 * cess. The surcharge is read from the slab rates the tool offers (30% slab
 * plus 10% or 15% surcharge, or more).
 */
export function ltcgRateFor(indiaRate) {
  let surcharge = 0;
  if (indiaRate >= 0.3588 - 1e-6) surcharge = 0.15;
  else if (indiaRate >= 0.3432 - 1e-6) surcharge = 0.1;
  return LTCG_RATE * (1 + surcharge) * 1.04;
}

// SBI's rate for `iso`: the last one published on or before it. Only once the rate data reaches
// that date, since until then a later update could still add the right one, and not across a gap
// of more than 10 days (weekends and holidays are shorter).
function knownRate(rates, iso) {
  const last = rates.dates[rates.dates.length - 1];
  if (!last || last < iso) return null;
  const rate = rateOn(rates, iso);
  return rate && rate.date >= addDays(iso, -10) ? rate : null;
}

// Gains by period of sale, after losses: each period keeps at most the gain made in it, and
// whatever losses take off comes off the latest periods first.
function byPeriod(rows, term, total) {
  const net = QUARTERS.map(() => 0);
  for (const r of rows) if (r.term === term && r.gain !== null) net[r.quarter] += r.gain;
  const out = net.map((v) => Math.max(v, 0));
  let excess = out.reduce((a, b) => a + b, 0) - total;
  for (let i = out.length - 1; i >= 0 && excess > 0; i -= 1) {
    const cut = Math.min(out[i], excess);
    out[i] -= cut;
    excess -= cut;
  }
  return out;
}

/**
 * lots: sold lots from fidelity.parseClosedLots ({ id, acquired, sold,
 * quantity, costPerShare, proceeds, source, grantDate }); prices / rates:
 * series() of the company's closes and SBI TT buying rates; fy: first calendar
 * year of the financial year; today: IST date; costRate: 'acquired' (default)
 * or 'sale'; rateOverrides: { [lot id]: rate on the acquisition date } for lots
 * whose rate is not in the data; indiaRate: slab rate (fraction, with
 * surcharge and cess) for short-term gains and the tax estimate.
 *
 * A sale whose exchange rate is not available yet has a null gain and is left
 * out of the totals; `complete` is false and `pending` counts the reasons.
 */
export function computeCapitalGains({
  lots, prices, rates, fy, today,
  esppBasis = 'fmv', esppDiscount = 0.1, costRate = 'acquired', rateOverrides = {}, indiaRate = null,
}) {
  const start = `${fy}-04-01`;
  const end = `${fy + 1}-03-31`;
  const ratesFrom = rates.dates[0] || null;
  const ratesTo = rates.dates[rates.dates.length - 1] || null;
  const rows = [];
  const transfers = [];
  const elsewhere = new Map();
  for (const lot of lots) {
    if (!lot.sold) continue;
    if (lot.sold < start || lot.sold > end) {
      const y = fyOf(lot.sold);
      elsewhere.set(y, (elsewhere.get(y) || 0) + 1);
      continue;
    }
    if (!(lot.proceeds > 0)) {
      transfers.push(lot);
      continue;
    }
    const cls = classifyLot(lot, prices, { esppBasis, esppDiscount });
    const saleRateDate = monthEndBefore(lot.sold);
    const saleRate = knownRate(rates, saleRateDate);
    const override = Number(rateOverrides?.[lot.id]);
    const acqRate = override > 0
      ? { date: lot.acquired, rate: override, manual: true }
      : knownRate(rates, lot.acquired);
    const atSale = costRate === 'sale';
    const cRate = atSale ? saleRate : acqRate;
    const costUsd = lot.quantity * cls.fmvPerShare;
    const consideration = saleRate ? Math.round(lot.proceeds * saleRate.rate) : null;
    const cost = cRate ? Math.round(costUsd * cRate.rate) : null;
    const gain = consideration !== null && cost !== null ? consideration - cost : null;
    // gain = (sale − cost) in dollars × sale rate  +  cost in dollars × (sale rate − cost rate)
    const currency = !atSale && saleRate && acqRate ? Math.round(costUsd * (saleRate.rate - acqRate.rate)) : 0;
    const long = isLongTerm(lot.acquired, lot.sold);
    const needsAcqRate = !atSale && !acqRate;
    rows.push({
      lot, type: cls.type, basis: cls.basis, basisDate: cls.basisDate, fmvPerShare: cls.fmvPerShare,
      term: long ? 'long' : 'short', longFrom: longTermFrom(lot.acquired), months: monthsHeld(lot.acquired, lot.sold),
      quarter: quarterOf(lot.sold, fy),
      sale: { usd: lot.proceeds, perShare: lot.proceeds / lot.quantity, rateDate: saleRateDate, rate: saleRate,
        inr: consideration },
      cost: { usd: costUsd, rateDate: atSale ? saleRateDate : lot.acquired, rate: cRate, inr: cost },
      usdGain: lot.proceeds - costUsd, gain, currency,
      needsSaleRate: !saleRate, needsAcqRate,
      // Why the acquisition-date rate is missing: before the rate history, or not published in it yet.
      acqRateMissing: needsAcqRate ? (ratesTo && lot.acquired > ratesTo ? 'later' : 'before') : null,
    });
  }
  rows.sort((a, b) => (a.lot.sold < b.lot.sold ? -1 : a.lot.sold > b.lot.sold ? 1
    : a.lot.acquired < b.lot.acquired ? -1 : a.lot.acquired > b.lot.acquired ? 1 : 0));

  // Totals add up the whole-rupee rows shown in the table, so every form value matches it. Sales
  // still waiting for a rate are counted in `pending` and left out.
  const block = (term) => {
    const all = rows.filter((r) => r.term === term);
    const rs = all.filter((r) => r.gain !== null);
    const consideration = rs.reduce((a, r) => a + r.sale.inr, 0);
    const cost = rs.reduce((a, r) => a + r.cost.inr, 0);
    return { count: rs.length, pending: all.length - rs.length, consideration, cost, expenses: 0, deductions: cost,
      gain: consideration - cost };
  };
  const short = block('short');
  const long = block('long');

  // Set-off within these sales: a short-term loss first against long-term gains.
  const shortAfter = Math.max(short.gain, 0);
  let longAfter = Math.max(long.gain, 0);
  let shortLossUsed = 0;
  let shortLossCarried = 0;
  if (short.gain < 0) {
    shortLossUsed = Math.min(-short.gain, longAfter);
    longAfter -= shortLossUsed;
    shortLossCarried = -short.gain - shortLossUsed;
  }
  const longLossCarried = long.gain < 0 ? -long.gain : 0;
  const setOff = { shortAfter, longAfter, shortLossUsed, shortLossCarried, longLossCarried };

  const periods = { short: byPeriod(rows, 'short', shortAfter), long: byPeriod(rows, 'long', longAfter) };

  const hasRate = indiaRate !== null && indiaRate !== undefined && Number.isFinite(indiaRate);
  const ltRate = hasRate ? ltcgRateFor(indiaRate) : LTCG_RATE * 1.04;
  const tax = {
    shortRate: hasRate ? indiaRate : null, longRate: ltRate,
    short: hasRate ? Math.round(shortAfter * indiaRate) : null,
    long: Math.round(longAfter * ltRate),
  };
  tax.total = tax.short === null ? null : tax.short + tax.long;
  const income = shortAfter + longAfter;
  const fsi = income > 0
    ? { income, taxPaid: 0, taxIndia: tax.total, relief: 0, article: DTAA_GAINS.article }
    : null;

  const warnings = [];
  if (rows.some((r) => r.lot.sold < NEW_RULES_FROM)) {
    warnings.push('Some sales were before 23 July 2024, when long-term gains were taxed at 20% with indexation; '
      + 'this tool uses the rules from that date.');
  }
  if (rows.some((r) => r.basis === 'estimated')) {
    warnings.push('Some ESPP lots are older than the price history, so their market price was estimated from the price paid.');
  }
  const missingRates = rows.filter((r) => r.gain === null).length;
  const pending = {
    before: rows.filter((r) => r.acqRateMissing === 'before').length,
    later: rows.filter((r) => r.acqRateMissing === 'later').length,
    sale: rows.filter((r) => r.needsSaleRate).length,
  };

  return {
    fy, start, end, final: today > end, costRate, rows, transfers,
    elsewhere: [...elsewhere].map(([y, count]) => ({ fy: y, count })).sort((a, b) => a.fy - b.fy),
    short, long, setOff, periods, tax, fsi, warnings,
    missingRates, complete: missingRates === 0, pending, ratesFrom, ratesTo,
  };
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const ddmmyyyy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');

/** CSV of the sales and the working, for the user's records. */
export function capitalGainsCsv(result) {
  const head = ['Sale date', 'Acquired', 'Type', 'Shares', 'Term (India)', 'Months held', 'Long-term from',
    'Sale value (USD)', 'Sale rate date', 'Sale rate (INR/USD)', 'Sale value (INR)',
    'Cost per share (USD)', 'Cost (USD)', 'Cost rate date', 'Cost rate (INR/USD)', 'Cost (INR)',
    'Gain (INR)', 'Of which from the rupee falling (INR)'];
  const lines = [head.map(csvCell).join(',')];
  for (const r of result.rows) {
    lines.push([ddmmyyyy(r.lot.sold), ddmmyyyy(r.lot.acquired), r.type, r.lot.quantity,
      r.term === 'long' ? 'Long-term' : 'Short-term', r.months, ddmmyyyy(r.longFrom),
      r.sale.usd.toFixed(2), ddmmyyyy(r.sale.rate?.date), r.sale.rate?.rate ?? '', r.sale.inr,
      r.fmvPerShare.toFixed(4), r.cost.usd.toFixed(2), ddmmyyyy(r.cost.rate?.date), r.cost.rate?.rate ?? '',
      r.cost.inr, r.gain, r.currency].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}
