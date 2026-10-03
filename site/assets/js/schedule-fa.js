// Schedule FA (foreign assets) values for RSU / ESPP lots, worked out in the
// browser from a broker export plus the published prices, dividends and SBI
// rates. Pure functions — no network, no storage — so they are unit-tested.
//
// Rules applied (ITR-2 / ITR-3 instructions and common practice):
// * Schedule FA covers the calendar year (1 January – 31 December) that ends
//   inside the financial year of the return.
// * Every rupee value uses SBI's telegraphic-transfer (TT) buying rate on the
//   relevant date — acquisition, peak, 31 December, dividend payment — or the
//   last rate SBI published before it (weekends and bank holidays).
// * A peak is the highest rupee value on any day (shares × close × that day's
//   rate), so it is never below the closing value.
// * The e-filing portal accepts whole rupees, so values are rounded last.

export const ESPP_COST_RATIO = [0.83, 0.96];

export function series(pairs) {
  return { dates: pairs.map((p) => p[0]), values: pairs.map((p) => p[1]) };
}

/** Index of the last date on or before `iso`, or -1. */
export function lastOnOrBefore(s, iso) {
  let lo = 0;
  let hi = s.dates.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s.dates[mid] <= iso) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

/** Index of the first date on or after `iso`, or dates.length. */
export function firstOnOrAfter(s, iso) {
  let lo = 0;
  let hi = s.dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s.dates[mid] < iso) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** SBI TT buying rate for a date: that day's, else the last one published before it. */
export function rateOn(rates, iso) {
  const i = lastOnOrBefore(rates, iso);
  return i < 0 ? null : { date: rates.dates[i], rate: rates.values[i] };
}

const yy = (n) => String(n % 100).padStart(2, '0');

/**
 * Returns the user can prepare on `today` (IST, "YYYY-MM-DD"): the previous and
 * current financial year, plus the next one once its calendar year has begun
 * (January–March). Each return's Schedule FA covers the calendar year that
 * starts with its financial year: FY 2025-26 → January–December 2025.
 */
export function returnOptions(today) {
  const y = Number(today.slice(0, 4));
  const current = Number(today.slice(5, 7)) >= 4 ? y : y - 1;
  return [current - 1, current, current + 1]
    .filter((fy) => `${fy}-01-01` <= today)
    .map((fy) => ({
      fyStart: fy,
      cy: fy,
      fyLabel: `FY ${fy}-${yy(fy + 1)}`,
      // The Income-tax Act, 2025 replaces "assessment year" with "tax year"
      // from tax year 2026-27 (= FY 2026-27).
      yearLabel: fy >= 2026 ? `tax year ${fy}-${yy(fy + 1)}` : `AY ${fy + 1}-${yy(fy + 2)}`,
      newAct: fy >= 2026,
      filedIn: fy + 1,
      complete: today > `${fy}-12-31`,
      isDefault: fy === current,
    }));
}

/**
 * ESPP or RSU, and the fair market value per share to use as its cost.
 * Fidelity marks stock-purchase-plan lots with share source "SP". Lots with
 * another code count as ESPP when they carry a grant date (the offering
 * start) and cost a typical ESPP discount below the close. The discount is
 * taxed in India as salary, so by default an ESPP lot's cost is the FMV
 * (closing price on the purchase day), not the price paid.
 */
export function classifyLot(lot, prices, { esppBasis = 'fmv', esppDiscount = 0.1 } = {}) {
  const i = lastOnOrBefore(prices, lot.acquired);
  const close = i >= 0 ? prices.values[i] : null;
  const ratio = close ? lot.costPerShare / close : null;
  // A lookback plan can price far below the close, so the code alone decides.
  const coded = /^(SP|ES|ESPP)$/.test(lot.source || '');
  const espp = coded || (Boolean(lot.grantDate) && ratio !== null
    && ratio >= ESPP_COST_RATIO[0] && ratio <= ESPP_COST_RATIO[1]);
  if (!espp) return { type: 'RSU', fmvPerShare: lot.costPerShare, basis: 'cost' };
  if (esppBasis === 'paid') return { type: 'ESPP', fmvPerShare: lot.costPerShare, basis: 'paid' };
  if (close) return { type: 'ESPP', fmvPerShare: close, basis: 'close', basisDate: prices.dates[i] };
  return { type: 'ESPP', fmvPerShare: lot.costPerShare / (1 - esppDiscount), basis: 'estimated' };
}

const inr = (usd, rate) => (rate ? usd * rate.rate : null);
const round = (x) => (x === null || x === undefined ? null : Math.round(x));

/**
 * Sanity check of an export against the company's prices: RSU and ESPP lots
 * cost close to the market price on the day they were acquired. When most lots
 * are far off, the file is probably in another currency or for another company.
 * Lots older than the price history are not checked.
 */
export function priceCheck(lots, prices) {
  let checked = 0;
  let off = 0;
  for (const lot of lots) {
    const i = lastOnOrBefore(prices, lot.acquired);
    if (i < 0 || !(lot.costPerShare > 0)) continue;
    checked += 1;
    const ratio = lot.costPerShare / prices.values[i];
    if (ratio < 0.6 || ratio > 1.6) off += 1;
  }
  return { checked, off, ok: off * 2 <= checked };
}

function initialValue(lot, cls, rates, rateOverrides) {
  const usd = lot.quantity * cls.fmvPerShare;
  const override = Number(rateOverrides?.[lot.id]);
  const rate = override > 0 ? { date: lot.acquired, rate: override, manual: true } : rateOn(rates, lot.acquired);
  // Rates before the first published SBI rate cannot be looked up.
  const usable = rate && (rate.manual || rate.date >= addDays(lot.acquired, -10)) ? rate : null;
  return { usd, rate: usable, exact: inr(usd, usable), needsRate: !usable };
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Schedule FA Table A3 rows (one per lot), the Table A2 account summary and
 * the Schedule AL cost total for the return whose Schedule FA covers
 * calendar year `cy`.
 *
 * lots: from fidelity.parseOpenLots; prices / rates: series(); dividends:
 * [{ ex, pay, amount }]; today: IST date "YYYY-MM-DD".
 */
export function computeScheduleFA({
  lots, prices, rates, dividends, cy, today,
  esppBasis = 'fmv', esppDiscount = 0.1, rateOverrides = {},
}) {
  const yearStart = `${cy}-01-01`;
  const yearEnd = `${cy}-12-31`;
  const final = today > yearEnd;
  const lastPrice = prices.dates[prices.dates.length - 1];
  if (!lastPrice || lastPrice < yearStart) {
    throw new Error(`No prices are available for ${cy} yet.`);
  }
  const periodEnd = lastPrice < yearEnd ? lastPrice : yearEnd;
  const warnings = [];
  if (final && periodEnd < addDays(yearEnd, -6)) {
    warnings.push(`Prices are only available up to ${periodEnd}, so 31 December values use that day's price.`);
  }

  const closeIdx = lastOnOrBefore(prices, periodEnd);
  const closePrice = prices.values[closeIdx];
  const closeDate = prices.dates[closeIdx];
  const closingRate = rateOn(rates, final ? yearEnd : closeDate);
  const yStartIdx = firstOnOrAfter(prices, yearStart);
  const dayRate = [];
  for (let i = yStartIdx; i <= closeIdx; i += 1) dayRate[i] = rateOn(rates, prices.dates[i]);
  const opts = { esppBasis, esppDiscount };

  const rows = [];
  const excluded = [];
  for (const lot of lots) {
    if (lot.acquired > yearEnd) {
      excluded.push({ lot, reason: `acquired after 31 Dec ${cy}` });
      continue;
    }
    const cls = classifyLot(lot, prices, opts);
    const initial = initialValue(lot, cls, rates, rateOverrides);
    const atAcquisition = { date: lot.acquired, price: cls.fmvPerShare, usd: initial.usd, rate: initial.rate,
      exact: initial.exact };

    const closingUsd = lot.quantity * closePrice;
    const closing = lot.acquired > closeDate
      ? { ...atAcquisition, fallback: true }
      : { date: closeDate, price: closePrice, usd: closingUsd, rate: closingRate, exact: inr(closingUsd, closingRate) };

    // Peak: the highest rupee value on any day of the period (shares × that day's close × that day's
    // rate; the rupee moves too, so it can fall on a different day from the highest dollar price). The
    // closing value, and the value on the day a lot was acquired during the year, count as days too.
    let peak = null;
    const consider = (c) => {
      if (c.exact !== null && (!peak || c.exact > peak.exact)) peak = c;
    };
    const from = lot.acquired > yearStart ? lot.acquired : yearStart;
    for (let i = firstOnOrAfter(prices, from); i <= closeIdx; i += 1) {
      if (!dayRate[i]) continue;
      const usd = lot.quantity * prices.values[i];
      consider({ kind: 'day', date: prices.dates[i], price: prices.values[i], usd, rate: dayRate[i],
        exact: inr(usd, dayRate[i]) });
    }
    if (!closing.fallback) consider({ ...closing, kind: 'closing' });
    if (lot.acquired >= yearStart) consider({ ...atAcquisition, kind: 'acquired' });
    if (!peak) peak = { ...atAcquisition, kind: 'acquired', fallback: true };
    else if (peak.kind === 'acquired' && lot.acquired > closeDate) peak = { ...peak, fallback: true };

    const items = [];
    for (const d of dividends) {
      const pay = d.pay || d.ex;
      if (pay < yearStart || pay > yearEnd || pay > today) continue;
      if (!(lot.acquired < d.ex)) continue; // bought on or after the ex-date: not entitled
      const usd = lot.quantity * d.amount;
      const rate = rateOn(rates, pay);
      items.push({ ex: d.ex, pay, payKnown: Boolean(d.pay), perShare: d.amount, usd, rate, exact: inr(usd, rate) });
    }
    const divExact = items.reduce((a, x) => a + (x.exact ?? 0), 0);

    rows.push({
      lot, type: cls.type, fmvPerShare: cls.fmvPerShare, basis: cls.basis, basisDate: cls.basisDate,
      initial: { ...initial, inr: round(initial.exact) },
      peak: { ...peak, inr: round(peak.exact) },
      closing: { ...closing, inr: round(closing.exact) },
      dividends: { items, usd: items.reduce((a, x) => a + x.usd, 0), exact: divExact, inr: Math.round(divExact) },
      proceeds: { inr: 0 },
    });
  }

  // Table A2: the whole account (shares only), valued in rupees every trading day. Each day adds up
  // whole-rupee lot values, like the closing balance, so the same day gives the same figure.
  let peakAcct = null;
  for (let i = yStartIdx; i <= closeIdx; i += 1) {
    if (!dayRate[i]) continue;
    const day = prices.dates[i];
    let shares = 0;
    let value = 0;
    for (const r of rows) {
      if (r.lot.acquired > day) continue;
      shares += r.lot.quantity;
      value += Math.round(inr(r.lot.quantity * prices.values[i], dayRate[i]));
    }
    if (shares > 0 && (!peakAcct || value > peakAcct.inr)) {
      peakAcct = { date: day, usd: shares * prices.values[i], rate: dayRate[i], inr: value };
    }
  }
  const account = { firstLot: lots.length ? lots[0].acquired : null };
  // Account totals add up the whole-rupee lot values so they match the Table A3 rows exactly.
  const sum = (pick) => rows.reduce((a, r) => a + (pick(r) ?? 0), 0);
  account.closing = { date: closeDate, usd: sum((r) => r.closing.usd), rate: closingRate,
    inr: sum((r) => r.closing.inr) };
  if (peakAcct) account.peak = peakAcct;
  if (rows.length && (!account.peak || account.peak.inr < account.closing.inr)) {
    account.peak = { date: closeDate, usd: account.closing.usd, rate: closingRate, inr: account.closing.inr };
  }
  account.dividends = sum((r) => r.dividends.inr);
  account.proceeds = 0;

  // Schedule AL: cost of shares held on 31 March at the end of the FY.
  const alDate = `${cy + 1}-03-31`;
  const alCutoff = today < alDate ? today : alDate;
  let alInr = 0;
  let alLots = 0;
  let alMissing = 0;
  for (const lot of lots) {
    if (lot.acquired > alCutoff) continue;
    const init = initialValue(lot, classifyLot(lot, prices, opts), rates, rateOverrides);
    alLots += 1;
    if (init.exact === null) alMissing += 1; else alInr += Math.round(init.exact);
  }
  const al = { date: alDate, provisional: today < alDate, asOf: alCutoff, lots: alLots,
    missingRates: alMissing, inr: alInr };

  const totals = {
    initial: sum((r) => r.initial.inr), peak: sum((r) => r.peak.inr), closing: sum((r) => r.closing.inr),
    dividends: sum((r) => r.dividends.inr), proceeds: 0,
  };

  const missing = rows.filter((r) => r.initial.needsRate).length;
  if (missing) {
    warnings.push(`${missing} lot${missing === 1 ? ' was' : 's were'} acquired before the SBI rate history `
      + `starts (${rates.dates[0]}); enter the SBI TT buying rate for ${missing === 1 ? 'it' : 'them'} below.`);
  }
  if (rows.some((r) => r.dividends.items.some((x) => !x.payKnown))) {
    warnings.push('Some dividend payment dates were not available, so their ex-dividend date was used instead.');
  }
  if (rows.some((r) => r.basis === 'estimated')) {
    warnings.push('Some ESPP lots are older than the price history, so their market price was estimated from the price paid.');
  }

  return { cy, yearStart, yearEnd, final, periodEnd, closeDate, rows, excluded, account, al, totals, warnings };
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const ddmmyyyy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');

/** CSV of the Table A3 rows plus the working, for the user's records. */
export function scheduleFaCsv(result, entity) {
  const head = ['Row', 'Country/Region name and code', 'Name of entity', 'Address of entity', 'ZIP code',
    'Nature of entity', 'Date of acquiring the interest', 'Initial value of the investment (INR)',
    'Peak value of investment during the period (INR)', 'Closing balance (INR)',
    'Total gross amount paid/credited with respect to the holding during the period (INR)',
    'Total gross proceeds from sale or redemption of investment during the period (INR)',
    'Type', 'Shares', 'Value per share at acquisition (USD)', 'Rate used at acquisition (INR/USD)',
    'Peak date', 'Peak price (USD)', 'Peak rate (INR/USD)', 'Closing price date', 'Closing price (USD)',
    'Closing rate (INR/USD)', 'Dividends (USD)'];
  const lines = [head.map(csvCell).join(',')];
  result.rows.forEach((r, i) => {
    lines.push([i + 1, entity.country, entity.name, entity.address, entity.zip, entity.nature,
      ddmmyyyy(r.lot.acquired), r.initial.inr, r.peak.inr, r.closing.inr, r.dividends.inr, r.proceeds.inr,
      r.type, r.lot.quantity, r.fmvPerShare.toFixed(4), r.initial.rate?.rate ?? '',
      ddmmyyyy(r.peak.date), r.peak.price, r.peak.rate?.rate ?? '', ddmmyyyy(r.closing.date), r.closing.price,
      r.closing.rate?.rate ?? '', r.dividends.usd.toFixed(2)].map(csvCell).join(','));
  });
  return `${lines.join('\n')}\n`;
}
