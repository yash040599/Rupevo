// Dividends on the shares in a broker export, for one financial year, and the
// values they give for Schedule OS, Schedule FSI, Schedule TR and Form 67.
// Pure functions, unit-tested in tests/js/dividends.test.mjs.
//
// Rules applied:
// * Dividends are taxed in the financial year (1 April – 31 March) in which
//   they are paid, as income from other sources at the slab rate.
// * Rule 115: a dividend is converted at SBI's TT buying rate on the last day
//   of the month before the month it is paid. Rule 128: the US tax withheld
//   on it is converted at the same rate.
// * A lot receives a dividend only if it was acquired before the ex-dividend
//   date.
// * Foreign tax credit (section 90, India–US DTAA) is the lowest of the US tax
//   paid, the tax at the treaty rate (Article 10: 25% for individuals) and the
//   Indian tax on the same income.

import { rateOn } from './schedule-fa.js';

export const DTAA = { country: 'United States of America', article: 10, rate: 0.25 };

/** Schedule OS asks for dividends by these periods (for advance-tax interest u/s 234C). */
export const QUARTERS = ['Up to 15 Jun', '16 Jun – 15 Sep', '16 Sep – 15 Dec', '16 Dec – 15 Mar', '16 Mar – 31 Mar'];

/** Last day of the month before `iso`'s month: the Rule 115 date for a payment on `iso`. */
export function monthEndBefore(iso) {
  const [y, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
}

/** Index into QUARTERS for a payment on `iso` in the financial year starting 1 April `fy`. */
export function quarterOf(iso, fy) {
  if (iso <= `${fy}-06-15`) return 0;
  if (iso <= `${fy}-09-15`) return 1;
  if (iso <= `${fy}-12-15`) return 2;
  if (iso <= `${fy + 1}-03-15`) return 3;
  return 4;
}

/**
 * lots: from fidelity.parseOpenLots; dividends: [{ ex, record, pay, declared, amount }];
 * rates: series() of SBI TT buying rates; fy: first calendar year of the
 * financial year; today: IST date; usRate: US tax withheld (0.25 with a W-8BEN
 * on file, else 0.30); indiaRate: Indian tax rate on this income, as a fraction.
 */
export function computeDividends({ lots, dividends, rates, fy, today, usRate = DTAA.rate, indiaRate }) {
  const start = `${fy}-04-01`;
  const end = `${fy + 1}-03-31`;
  const rows = [];
  const upcoming = [];
  for (const d of dividends) {
    const pay = d.pay || d.ex;
    if (pay < start || pay > end) continue;
    const shares = lots.reduce((a, l) => a + (l.acquired < d.ex ? l.quantity : 0), 0);
    if (pay > today) {
      upcoming.push({ ...d, pay, shares });
      continue;
    }
    if (shares <= 0) continue;
    const grossUsd = shares * d.amount;
    const taxUsd = grossUsd * usRate;
    const rateDate = monthEndBefore(pay);
    const rate = rateOn(rates, rateDate);
    rows.push({
      ex: d.ex, record: d.record || null, declared: d.declared || null, pay, payKnown: Boolean(d.pay),
      perShare: d.amount, shares, grossUsd, taxUsd, rateDate, rate,
      gross: rate ? Math.round(grossUsd * rate.rate) : null,
      tax: rate ? Math.round(taxUsd * rate.rate) : null,
      quarter: quarterOf(pay, fy),
    });
  }
  rows.sort((a, b) => (a.pay < b.pay ? -1 : a.pay > b.pay ? 1 : 0));

  // Totals add up the whole-rupee rows shown in the table, so every form value matches it.
  const sum = (pick) => rows.reduce((a, r) => a + (pick(r) ?? 0), 0);
  const income = sum((r) => r.gross);
  const taxPaid = sum((r) => r.tax);
  const quarters = QUARTERS.map((_, i) => sum((r) => (r.quarter === i ? r.gross : 0)));
  const taxIndia = indiaRate === undefined || indiaRate === null ? null : Math.round(income * indiaRate);
  // Tax withheld above the treaty rate is refundable by the US, not creditable in India.
  const treatyCap = usRate > DTAA.rate ? Math.round(income * DTAA.rate) : Infinity;
  const relief = taxIndia === null ? null : Math.min(taxPaid, treatyCap, taxIndia);

  return {
    fy, start, end, final: today > end, rows, upcoming, quarters, usRate, indiaRate,
    totals: { grossUsd: sum((r) => r.grossUsd), taxUsd: sum((r) => r.taxUsd), income, taxPaid },
    taxIndia, relief, missingRates: rows.filter((r) => !r.rate).length,
  };
}
