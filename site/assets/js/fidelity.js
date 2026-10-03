// Parser for Fidelity NetBenefits share-lot CSV exports (Stock Plan Account →
// View share details → Export): "View open lots" (Current shares) and "View
// closed lots" (Previously held shares), both with Asset currency selected so
// values are in US dollars; the footer says which currency the file is in.
// Pure functions: nothing here touches the network or storage.

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

export class FidelityParseError extends Error {}

/** Split CSV text into rows of cells (quoted fields, "" escapes, CRLF and a BOM). */
export function parseCsvRows(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell); cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim()));
}

const iso = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
};

/** "Sep-30-2026", "SEP/30/2026", "Sep 30, 2026", "30-Sep-2026", "09/30/2026" or "2026-09-30" → "2026-09-30". */
export function parseDate(text) {
  const s = String(text ?? '').trim();
  let m = s.match(/^([A-Za-z]{3,4})[-\s./]+(\d{1,2}),?[-\s/]+(\d{4})$/);
  if (m && MONTHS[m[1].toLowerCase()]) return iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,4})[-\s](\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return iso(+m[3], +m[1], +m[2]);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  return null;
}

/** "$1,234.56", "1,23,456", "(12.30)" → number; "", "-", "n/a" → null. */
export function parseNumber(text) {
  let s = String(text ?? '').trim();
  if (!s || /^(-|--|n\/?a|none)$/i.test(s)) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  s = s.replace(/[$₹,\s]|USD|INR/gi, '');
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1); }
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? (negative ? -n : n) : null;
}

// Header cells are matched by their letters and digits only. Fidelity's closed-lots export wraps
// one header in leftover HTML (<span style="…">Date sold or transferred</span>), so tags go first.
const norm = (h) => String(h).replace(/<[^>]*>/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const COLUMNS = {
  acquired: ['dateacquired', 'acquireddate', 'acquisitiondate'],
  quantity: ['quantity', 'shares', 'qty'],
  costBasis: ['costbasis', 'totalcostbasis'],
  costPerShare: ['costbasisshare', 'costbasispershare', 'costpershare'],
  value: ['value', 'marketvalue', 'currentvalue'],
  grantDate: ['grantdate'],
  source: ['sharesource', 'source'],
  sold: ['datesoldortransferred', 'datesold', 'solddate', 'datesoldtransferred'],
  proceeds: ['proceeds', 'totalproceeds', 'saleproceeds'],
  gain: ['gainloss', 'gain', 'realizedgainloss'],
  term: ['term', 'holdingperiod'],
};

function findHeader(rows) {
  return rows.findIndex((r) => {
    const cells = r.map(norm);
    return cells.includes('dateacquired') && cells.includes('quantity');
  });
}

function readCurrency(rows) {
  let currency = null;
  for (const r of rows) {
    const m = r.join(' ').match(/values are displayed in\s+([A-Za-z]{3})/i);
    if (m) currency = m[1].toUpperCase();
  }
  return currency;
}

/** 'open' (Current shares), 'closed' (Previously held shares) or null for anything else. */
export function detectExport(text) {
  const rows = parseCsvRows(text);
  const i = findHeader(rows);
  if (i < 0) return null;
  const cells = rows[i].map(norm);
  return COLUMNS.sold.some((name) => cells.includes(name)) ? 'closed' : 'open';
}

/**
 * Parse a "View open lots" export into lots, oldest first.
 * Returns { lots, currency, skipped } — `currency` comes from the export's
 * footer ("The values are displayed in USD"), or null if it has none.
 */
export function parseOpenLots(text) {
  const rows = parseCsvRows(text);
  const headerIndex = findHeader(rows);
  if (headerIndex < 0) {
    throw new FidelityParseError('This does not look like Fidelity\'s “View open lots” export: '
      + 'no “Date acquired” and “Quantity” columns were found.');
  }
  const header = rows[headerIndex].map(norm);
  const col = {};
  for (const [key, names] of Object.entries(COLUMNS)) {
    col[key] = header.findIndex((h) => names.includes(h));
  }
  if (col.sold >= 0) {
    throw new FidelityParseError('This is the “View closed lots” export of shares you sold, not the shares you '
      + 'hold: for those, export from the Current shares tab.');
  }
  if (col.costBasis < 0 && col.costPerShare < 0) {
    throw new FidelityParseError('The export has no “Cost basis” column, which the calculation needs.');
  }

  const currency = readCurrency(rows);

  const lots = [];
  const skipped = [];
  const cell = (r, key) => (col[key] >= 0 ? r[col[key]] ?? '' : '');
  rows.slice(headerIndex + 1).forEach((r, k) => {
    if (!r.some((c) => c)) return;
    const acquired = parseDate(cell(r, 'acquired'));
    if (!acquired) return; // footer and note lines
    const line = headerIndex + k + 2;
    const quantity = parseNumber(cell(r, 'quantity'));
    const costBasis = parseNumber(cell(r, 'costBasis'));
    let costPerShare = parseNumber(cell(r, 'costPerShare'));
    if (costPerShare === null && costBasis !== null && quantity) costPerShare = costBasis / quantity;
    if (!(quantity > 0)) { skipped.push({ line, reason: 'quantity is missing or zero' }); return; }
    if (!(costPerShare > 0)) { skipped.push({ line, reason: 'cost basis is missing' }); return; }
    lots.push({
      acquired,
      quantity,
      costPerShare,
      costBasis: costBasis ?? quantity * costPerShare,
      value: parseNumber(cell(r, 'value')),
      grantDate: parseDate(cell(r, 'grantDate')),
      source: cell(r, 'source').toUpperCase(),
      line,
    });
  });
  if (!lots.length) {
    throw new FidelityParseError('The export has no share lots in it.');
  }
  lots.sort((a, b) => (a.acquired < b.acquired ? -1 : a.acquired > b.acquired ? 1 : a.line - b.line));
  lots.forEach((lot, i) => { lot.id = `L${i + 1}`; });
  return { lots, currency, skipped };
}

/**
 * Parse a "View closed lots" export (Previously held shares) into sold lots,
 * in order of sale. Each has `sold` (date sold or transferred) and `proceeds`;
 * a lot without proceeds was transferred out rather than sold. The export has
 * no share source or grant date, so `source` is null unless the file has one.
 */
export function parseClosedLots(text) {
  const rows = parseCsvRows(text);
  const headerIndex = findHeader(rows);
  if (headerIndex < 0) {
    throw new FidelityParseError('This does not look like Fidelity\'s “View closed lots” export: '
      + 'no “Date acquired” and “Quantity” columns were found.');
  }
  const header = rows[headerIndex].map(norm);
  const col = {};
  for (const [key, names] of Object.entries(COLUMNS)) {
    col[key] = header.findIndex((h) => names.includes(h));
  }
  if (col.sold < 0) {
    throw new FidelityParseError('This export has no “Date sold or transferred” column: choose the '
      + '“View closed lots” export from the Previously held shares tab.');
  }
  if (col.costBasis < 0 && col.costPerShare < 0) {
    throw new FidelityParseError('The export has no “Cost basis” column, which the calculation needs.');
  }

  const lots = [];
  const skipped = [];
  const cell = (r, key) => (col[key] >= 0 ? r[col[key]] ?? '' : '');
  rows.slice(headerIndex + 1).forEach((r, k) => {
    if (!r.some((c) => c)) return;
    const acquired = parseDate(cell(r, 'acquired'));
    if (!acquired) return; // footer and note lines
    const line = headerIndex + k + 2;
    const quantity = parseNumber(cell(r, 'quantity'));
    const sold = parseDate(cell(r, 'sold'));
    const costBasis = parseNumber(cell(r, 'costBasis'));
    let costPerShare = parseNumber(cell(r, 'costPerShare'));
    if (costPerShare === null && costBasis !== null && quantity) costPerShare = costBasis / quantity;
    if (!(quantity > 0)) { skipped.push({ line, reason: 'quantity is missing or zero' }); return; }
    if (!sold) { skipped.push({ line, reason: 'the date sold is missing' }); return; }
    if (!(costPerShare > 0)) { skipped.push({ line, reason: 'cost basis is missing' }); return; }
    const proceeds = parseNumber(cell(r, 'proceeds'));
    lots.push({
      acquired,
      quantity,
      costPerShare,
      costBasis: costBasis ?? quantity * costPerShare,
      sold,
      proceeds: proceeds > 0 ? proceeds : null,
      transferred: !(proceeds > 0),
      usGain: parseNumber(cell(r, 'gain')),
      usTerm: cell(r, 'term').toUpperCase() || null,
      grantDate: parseDate(cell(r, 'grantDate')),
      source: col.source >= 0 ? cell(r, 'source').toUpperCase() : null,
      line,
    });
  });
  if (!lots.length) {
    throw new FidelityParseError('The export has no sold or transferred lots in it.');
  }
  lots.sort((a, b) => (a.sold < b.sold ? -1 : a.sold > b.sold ? 1
    : a.acquired < b.acquired ? -1 : a.acquired > b.acquired ? 1 : a.line - b.line));
  lots.forEach((lot, i) => { lot.id = `C${i + 1}`; });
  return { lots, currency: readCurrency(rows), skipped };
}
