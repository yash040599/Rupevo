// Pure helpers for the mutual fund page (no DOM): the SIP split by age and risk,
// SIP maths for "what the tracking gap is worth", and lookups. Tested in tests/js/mf-plan.test.mjs.

export const AGE_BANDS = [
  { key: 'u30', label: 'Under 30', horizon: '30+ years of investing ahead' },
  { key: '30s', label: '30 to 44', horizon: '15 to 30 years ahead' },
  { key: '45s', label: '45 to 59', horizon: '5 to 15 years ahead' },
  { key: '60p', label: '60 and over', horizon: 'drawing on savings soon or now' },
];

export const RISK_LEVELS = [
  { key: 'cautious', label: 'Cautious', hint: 'A 20–30% fall in my investments would worry me a lot' },
  { key: 'balanced', label: 'Balanced', hint: 'I can sit through a 30–40% fall and keep investing' },
  { key: 'aggressive', label: 'Aggressive', hint: 'I can hold through a 50% fall for a few years' },
];

// Slices of the monthly SIP. `groups` are the comparison groups on this page for that slice.
export const SLICES = [
  { key: 'core', label: 'Large-cap index fund', detail: 'Nifty 50 or Nifty 100 index fund: the low-cost core',
    equity: true, groups: ['nifty50', 'nifty100'] },
  { key: 'flexi', label: 'Flexi-cap fund', detail: 'A fund manager free to pick companies of any size',
    equity: true, groups: ['flexicap'] },
  { key: 'mid', label: 'Mid-cap fund', detail: 'An active mid-cap fund or a Nifty Midcap 150 index fund',
    equity: true, groups: ['midcap', 'midcap150'] },
  { key: 'small', label: 'Small-cap fund', detail: 'An active small-cap fund or a Nifty Smallcap 250 index fund',
    equity: true, groups: ['smallcap', 'smallcap250'] },
  { key: 'debt', label: 'Debt and safe savings', detail: 'EPF, PPF, fixed deposits or debt funds (not compared here yet)',
    equity: false, groups: [] },
];

// Percent of the monthly SIP per slice, in SLICES order. Shares (all but debt) are about
// 100 minus age for "Balanced", 15 points less for "Cautious" and 15 more for "Aggressive".
export const SPLITS = {
  u30: { cautious: [30, 20, 10, 0, 40], balanced: [35, 20, 10, 10, 25], aggressive: [40, 20, 15, 15, 10] },
  '30s': { cautious: [30, 15, 5, 0, 50], balanced: [30, 20, 10, 5, 35], aggressive: [35, 20, 15, 10, 20] },
  '45s': { cautious: [25, 10, 0, 0, 65], balanced: [30, 15, 5, 0, 50], aggressive: [35, 15, 10, 5, 35] },
  '60p': { cautious: [15, 5, 0, 0, 80], balanced: [25, 10, 0, 0, 65], aggressive: [30, 15, 5, 0, 50] },
};

export function allocation(age, risk) {
  const row = SPLITS[age]?.[risk];
  if (!row) return null;
  return SLICES.map((slice, i) => ({ ...slice, pct: row[i] }));
}

export const equityShare = (age, risk) => (allocation(age, risk) || [])
  .filter((s) => s.equity).reduce((sum, s) => sum + s.pct, 0);

/** Split a monthly amount by the slices, in whole rupees that add up to the amount. */
export function splitAmount(amount, slices) {
  const total = Math.max(0, Math.round(Number(amount) || 0));
  const parts = slices.map((s) => Math.floor((total * s.pct) / 100));
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = slices.map((s, i) => [s.pct, i]).filter(([p]) => p > 0).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0 && order.length; k = (k + 1) % order.length, left -= 1) parts[order[k][1]] += 1;
  return parts;
}

/** Value of a monthly SIP after `years`, each instalment invested at the start of its month. */
export function sipValue(monthly, years, annualReturnPct) {
  const months = Math.round(years * 12);
  const rate = (1 + annualReturnPct / 100) ** (1 / 12) - 1;
  if (Math.abs(rate) < 1e-12) return monthly * months;
  return monthly * (((1 + rate) ** months - 1) / rate) * (1 + rate);
}

/** How much more a SIP ends with when the fund trails the index by `lagA` instead of `lagB`
 * (tracking differences in % a year, negative = trailing) at an assumed index return. */
export function trackingGapValue(monthly, years, indexReturnPct, lagA, lagB) {
  return sipValue(monthly, years, indexReturnPct + lagA) - sipValue(monthly, years, indexReturnPct + lagB);
}

/** The tracking difference a fund is compared on: 3 years when published, else 1 year. */
export const lagOf = (fund) => {
  const td = fund?.tracking_difference || {};
  return typeof td['3y'] === 'number' ? td['3y'] : (typeof td['1y'] === 'number' ? td['1y'] : null);
};

export function groupFromHash(hash, groups, fallback = 'nifty50') {
  const key = String(hash || '').replace(/^#/, '').toLowerCase();
  if (groups.some((g) => g.key === key)) return key;
  return groups.some((g) => g.key === fallback) ? fallback : groups[0]?.key;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function matchesFund(fund, query) {
  const q = norm(query);
  if (!q) return true;
  const hay = `${norm(fund.name)} ${norm(fund.amc)} ${fund.code}`;
  return q.split(' ').every((word) => hay.includes(word));
}

/** Funds matching `query` in groups other than `currentKey`: [{ group, fund }]. */
export function findInOtherGroups(groups, currentKey, query) {
  if (!norm(query)) return [];
  return groups.filter((g) => g.key !== currentKey)
    .flatMap((g) => g.funds.filter((f) => matchesFund(f, query)).map((fund) => ({ group: g, fund })));
}

/** '₹1,23,456' */
export const rupees = (v) => `₹${Math.round(v).toLocaleString('en-IN')}`;
