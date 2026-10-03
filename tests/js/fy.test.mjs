// Unit tests for the financial-year maths behind the tax pages' FY slider.
// Run with:  node --test "tests/js/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dateOfIndex, dayIndexOf, financialYear, fmtDay, fyEvents, istWallClock, percentDone, quip,
} from '../../site/assets/js/fy.js';

const at = (iso) => new Date(iso);

test('IST wall clock is UTC+5:30', () => {
  const ist = istWallClock(at('2026-10-01T18:30:00Z'));
  assert.equal(ist.toISOString(), '2026-10-02T00:00:00.000Z');
});

test('financial year runs 1 April to 31 March', () => {
  const fy = financialYear(istWallClock(at('2026-10-02T12:00:00Z')));
  assert.equal(fy.label, 'FY 2026-27');
  assert.equal(fy.startYear, 2026);
  assert.equal(fy.days, 365);
  assert.equal(new Date(fy.start).toISOString().slice(0, 10), '2026-04-01');
});

test('the year changes at midnight IST on 1 April, not at midnight UTC', () => {
  // 31 March 23:59 IST is still FY 2026-27 ...
  assert.equal(financialYear(istWallClock(at('2027-03-31T18:29:00Z'))).label, 'FY 2026-27');
  // ... and one minute later (1 April 00:00 IST, still 31 March in UTC) it is FY 2027-28.
  assert.equal(financialYear(istWallClock(at('2027-03-31T18:30:00Z'))).label, 'FY 2027-28');
  // January to March belong to the year that began the previous April.
  assert.equal(financialYear(istWallClock(at('2027-01-15T06:00:00Z'))).label, 'FY 2026-27');
});

test('a financial year containing 29 February has 366 days', () => {
  assert.equal(financialYear(istWallClock(at('2027-06-01T00:00:00Z'))).days, 366); // FY 2027-28
  assert.equal(financialYear(istWallClock(at('2026-06-01T00:00:00Z'))).days, 365);
});

test('day index: 1 April is 0, 2 October is 184, 31 March is the last', () => {
  const ist = istWallClock(at('2026-10-02T06:00:00Z'));
  const fy = financialYear(ist);
  assert.equal(dayIndexOf(fy, Date.UTC(2026, 3, 1)), 0);
  assert.equal(dayIndexOf(fy, ist.getTime()), 184);
  assert.equal(dayIndexOf(fy, Date.UTC(2027, 2, 31)), fy.days - 1);
  assert.equal(fmtDay(dateOfIndex(fy, 184)), '2 Oct 2026');
});

test('percent done: exact for now, end-of-day for other days', () => {
  const ist = istWallClock(at('2026-10-02T17:50:00Z')); // 23:20 IST
  const fy = financialYear(ist);
  const exact = percentDone(fy, { ist });
  assert.ok(exact > 50.6 && exact < 50.7, `got ${exact}`);
  assert.equal(percentDone(fy, { index: fy.days - 1 }), 100);
  assert.ok(Math.abs(percentDone(fy, { index: 0 }) - 100 / 365) < 1e-9);
});

test('tax dates land on the right days of FY 2026-27', () => {
  const fy = financialYear(istWallClock(at('2026-10-02T06:00:00Z')));
  const events = fyEvents(fy);
  const byTitle = Object.fromEntries(events.map((e) => [e.title, fmtDay(dateOfIndex(fy, e.index))]));
  assert.equal(byTitle['1st advance-tax instalment'], '15 Jun 2026');
  assert.equal(byTitle['2nd advance-tax instalment'], '15 Sep 2026');
  assert.equal(byTitle['3rd advance-tax instalment'], '15 Dec 2026');
  assert.equal(byTitle['Last advance-tax instalment'], '15 Mar 2027');
  assert.equal(byTitle['Usual ITR due date for FY 2025-26'], '31 Jul 2026');
  assert.equal(byTitle['Last date for a belated ITR for FY 2025-26'], '31 Dec 2026');
  assert.equal(byTitle['FY 2026-27 ends'], '31 Mar 2027');
  const indexes = events.map((e) => e.index);
  assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b), 'events must be in date order');
  assert.ok(indexes.every((i) => i >= 0 && i < fy.days));
});

test('quips: deadline reminders win, then progress milestones', () => {
  const fy = financialYear(istWallClock(at('2026-12-05T06:00:00Z')));
  const dec15 = fyEvents(fy).find((e) => e.title.startsWith('3rd'));
  assert.equal(quip(68.5, dec15, 10), '⏰ 15 Dec: 3rd advance-tax instalment — in 10 days.');
  assert.equal(quip(68.5, dec15, 0), '⏰ 15 Dec: 3rd advance-tax instalment — today.');
  assert.match(quip(52, dec15, 74), /halfway/);
  assert.match(quip(3, null, Infinity), /brand-new/);
  assert.match(quip(99, null, Infinity), /31 March/);
});
