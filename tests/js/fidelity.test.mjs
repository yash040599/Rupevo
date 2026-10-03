// Tests for the Fidelity "View open lots" CSV parser. Synthetic data only.
// Run with:  node --test "tests/js/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectExport, FidelityParseError, parseClosedLots, parseCsvRows, parseDate, parseNumber, parseOpenLots,
} from '../../site/assets/js/fidelity.js';

const HEADER = 'Date acquired,Quantity,Cost basis,Cost basis/share,Value,Gain/loss,Sale availability date,'
  + 'Transfer availability date,Grant date,Share source,Holding period';

const SAMPLE = `\uFEFF${HEADER}
Sep-30-2026,0.5000,225.00,450.00,250.00,25.00,-,-,Jul-01-2026,SP,Short
May-15-2025,10.0000,4000.00,400.00,5000.00,1000.00,-,-,-,DO,Long
Aug-15-2025,"2.0000","1,000.00",500.00,1000.00,0.00,-,-,-,DO,Long
,
The values are displayed in USD
`;

test('CSV rows: quotes, escaped quotes, CRLF and BOM', () => {
  assert.deepEqual(parseCsvRows('\uFEFFa,"b,c","d ""e"""\r\n1,2,3'), [['a', 'b,c', 'd "e"'], ['1', '2', '3']]);
});

test('dates in the formats Fidelity and spreadsheets use', () => {
  assert.equal(parseDate('Sep-30-2026'), '2026-09-30');
  assert.equal(parseDate('Sep 30, 2026'), '2026-09-30');
  assert.equal(parseDate('30-Sep-2026'), '2026-09-30');
  assert.equal(parseDate('09/30/2026'), '2026-09-30');
  assert.equal(parseDate('2026-09-30'), '2026-09-30');
  assert.equal(parseDate('SEP/30/2026'), '2026-09-30', 'the closed-lots export');
  assert.equal(parseDate('Feb-30-2026'), null);
  assert.equal(parseDate('-'), null);
});

test('numbers with currency symbols, grouping and accounting negatives', () => {
  assert.equal(parseNumber('$1,234.56'), 1234.56);
  assert.equal(parseNumber('1,23,456'), 123456);
  assert.equal(parseNumber('(12.30)'), -12.3);
  assert.equal(parseNumber('-48.75'), -48.75);
  assert.equal(parseNumber('-'), null);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber('abc'), null);
});

test('open lots: columns by name, sorted oldest first, footer currency', () => {
  const { lots, currency, skipped } = parseOpenLots(SAMPLE);
  assert.equal(currency, 'USD');
  assert.deepEqual(skipped, []);
  assert.deepEqual(lots.map((l) => [l.id, l.acquired, l.quantity, l.costPerShare, l.source]), [
    ['L1', '2025-05-15', 10, 400, 'DO'],
    ['L2', '2025-08-15', 2, 500, 'DO'],
    ['L3', '2026-09-30', 0.5, 450, 'SP'],
  ]);
  assert.equal(lots[1].costBasis, 1000);
  assert.equal(lots[2].grantDate, '2026-07-01');
  assert.equal(lots[0].grantDate, null);
});

test('an export in display currency (INR) is reported as such', () => {
  const inr = SAMPLE.replace('displayed in USD', 'displayed in INR');
  assert.equal(parseOpenLots(inr).currency, 'INR');
});

test('cost per share is derived when only the total is present', () => {
  const text = 'Date acquired,Quantity,Cost basis\nMay-15-2025,4,1000\n';
  assert.equal(parseOpenLots(text).lots[0].costPerShare, 250);
});

test('rows without a quantity or cost are skipped and reported', () => {
  const text = `${HEADER}\nMay-15-2025,0,0,0,0,0,-,-,-,DO,Long\nMay-16-2025,1,100,100,100,0,-,-,-,DO,Long\n`;
  const { lots, skipped } = parseOpenLots(text);
  assert.equal(lots.length, 1);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].line, 2);
});

test('files that are not the open-lots export are rejected clearly', () => {
  assert.throws(() => parseOpenLots('Symbol,Price\nMSFT,500\n'), FidelityParseError);
  assert.throws(() => parseOpenLots(`${HEADER}\n,\nThe values are displayed in USD\n`), FidelityParseError);
});

// Fidelity's "View closed lots" export: one header cell wrapped in HTML, MON/DD/YYYY dates,
// no share source column. Made-up numbers.
const CLOSED = `\uFEFFDate acquired,Quantity,<span style="color: rgb(1, 2, 34); background-color: rgb(255, 255, 255);">Date sold or transferred</span>,Proceeds,Cost basis,Gain/loss,Term
AUG/15/2023,10.0000,APR/22/2026,2500.00,1500.00,1000.00,LONG
FEB/14/2025,2.0000,NOV/18/2025,600.00,560.00,40.00,SHORT
MAR/01/2024,5.0000,JUN/03/2025,-,700.00,-,LONG
,
The values are displayed in USD
`;

test('closed lots: HTML in a header, slash dates, sale order, transfers flagged', () => {
  assert.equal(detectExport(CLOSED), 'closed');
  assert.equal(detectExport(SAMPLE), 'open');
  assert.equal(detectExport('Symbol,Price\nMSFT,500\n'), null);
  const { lots, currency, skipped } = parseClosedLots(CLOSED);
  assert.equal(currency, 'USD');
  assert.deepEqual(skipped, []);
  assert.deepEqual(lots.map((l) => [l.id, l.acquired, l.sold, l.quantity, l.costPerShare, l.proceeds, l.transferred]), [
    ['C1', '2024-03-01', '2025-06-03', 5, 140, null, true],
    ['C2', '2025-02-14', '2025-11-18', 2, 280, 600, false],
    ['C3', '2023-08-15', '2026-04-22', 10, 150, 2500, false],
  ]);
  assert.equal(lots[1].usTerm, 'SHORT');
  assert.equal(lots[0].source, null, 'the export has no share source');
});

test('an open-lots file is not accepted as the closed-lots export', () => {
  assert.throws(() => parseClosedLots(SAMPLE), FidelityParseError);
  assert.throws(() => parseOpenLots(CLOSED), /closed lots/);
});
