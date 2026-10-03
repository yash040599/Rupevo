// Fun widget for the tax pages: an interactive "how far through India's
// financial year are we" slider. (The "Did you know?" card is in trivia.js.)
// The date maths is exported (and unit-tested in tests/js/fy.test.mjs).
import { esc } from './core.js';

const DAY_MS = 86400000;
const IST_OFFSET_MS = 330 * 60000; // UTC+5:30, India has no daylight saving
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// India's seasons by calendar month (IMD style): Dec-Feb winter, Mar-May summer,
// Jun-Sep monsoon, Oct-Nov post-monsoon (the festive season).
const SEASON = ['❄️', '❄️', '☀️', '☀️', '☀️', '🌧️', '🌧️', '🌧️', '🌧️', '🪔', '🪔', '❄️'];

/** Indian wall-clock time as a Date whose UTC fields read as IST. */
export const istWallClock = (now = new Date()) => new Date(now.getTime() + IST_OFFSET_MS);

/** The Indian financial year (1 April – 31 March) containing an IST wall-clock time. */
export function financialYear(ist) {
  const startYear = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  const start = Date.UTC(startYear, 3, 1);
  const end = Date.UTC(startYear + 1, 3, 1);
  return {
    startYear,
    endYear: startYear + 1,
    start,
    end,
    days: Math.round((end - start) / DAY_MS),
    label: `FY ${startYear}-${String(startYear + 1).slice(-2)}`,
  };
}

export const dayIndexOf = (fy, ms) => Math.floor((ms - fy.start) / DAY_MS);
export const dateOfIndex = (fy, index) => new Date(fy.start + index * DAY_MS);
export const fmtDay = (d, year = true) =>
  `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year ? ` ${d.getUTCFullYear()}` : ''}`;

/** Percent of the year done: exact for "now", end-of-day for any other day. */
export function percentDone(fy, { index, ist }) {
  const frac = ist ? (ist.getTime() - fy.start) / (fy.end - fy.start) : (index + 1) / fy.days;
  return Math.min(100, Math.max(0, frac * 100));
}

/** Recurring tax dates inside a financial year. */
export function fyEvents(fy) {
  const prev = `FY ${fy.startYear - 1}-${String(fy.startYear).slice(-2)}`;
  const at = (year, month, day) => Date.UTC(year, month, day);
  return [
    { ms: at(fy.startYear, 5, 15), kind: 'adv', title: '1st advance-tax instalment', detail: '15% of the year\'s tax' },
    { ms: at(fy.startYear, 6, 31), kind: 'itr', title: `Usual ITR due date for ${prev}`, detail: 'most salaried individuals' },
    { ms: at(fy.startYear, 8, 15), kind: 'adv', title: '2nd advance-tax instalment', detail: '45% of the year\'s tax' },
    { ms: at(fy.startYear, 11, 15), kind: 'adv', title: '3rd advance-tax instalment', detail: '75% of the year\'s tax' },
    { ms: at(fy.startYear, 11, 31), kind: 'itr', title: `Last date for a belated ITR for ${prev}`, detail: 'with a late fee' },
    { ms: at(fy.endYear, 2, 15), kind: 'adv', title: 'Last advance-tax instalment', detail: '100% of the year\'s tax' },
    { ms: at(fy.endYear, 2, 31), kind: 'end', title: `${fy.label} ends`, detail: 'last day of the financial year' },
  ].map((e) => ({ ...e, index: dayIndexOf(fy, e.ms) }));
}

export function quip(pct, next, daysToNext) {
  if (next && daysToNext <= 14) {
    const when = daysToNext === 0 ? 'today' : daysToNext === 1 ? 'tomorrow' : `in ${daysToNext} days`;
    return `⏰ ${fmtDay(new Date(next.ms), false)}: ${next.title} — ${when}.`;
  }
  if (pct < 8) return '🌱 A brand-new financial year — a clean slate.';
  if (pct < 25) return '🌱 The first quarter is under way.';
  if (pct < 45) return '🌿 The year is warming up.';
  if (pct < 50) return '⛰️ Almost halfway through the year.';
  if (pct < 56) return '🎉 Past the halfway mark!';
  if (pct < 75) return '🌳 The second half is in full swing.';
  if (pct < 92) return '🏃 Final quarter — the year-end rush is coming.';
  return '🏁 The finish line is in sight: the year ends on 31 March.';
}

const relDays = (n) => (n === 0 ? 'today' : n > 0 ? `in ${n} day${n === 1 ? '' : 's'}` : `${-n} day${n === -1 ? '' : 's'} ago`);
const pinTitle = (fy, e) => `${fmtDay(dateOfIndex(fy, e.index))}: ${e.title} (${e.detail})`;

/** Render the interactive financial-year slider into `host`. */
export function renderFyProgress(host) {
  let moved = false;

  function build(now) {
    const ist = istWallClock(now);
    const fy = financialYear(ist);
    const events = fyEvents(fy);
    const today = dayIndexOf(fy, ist.getTime());
    const last = fy.days - 1;
    const pos = (i) => (i / last).toFixed(5);
    const monthStarts = Array.from({ length: 13 }, (_, k) => dayIndexOf(fy, Date.UTC(fy.startYear, 3 + k, 1)));

    host.innerHTML = `
      <div class="fy-head">
        <div>
          <div class="eyebrow">${esc(fy.label)} · 1 Apr ${fy.startYear} – 31 Mar ${fy.endYear}</div>
          <div class="fy-big" aria-live="polite"></div>
          <div class="fy-sub"></div>
        </div>
        <button class="btn alt small fy-today" type="button" hidden>↺ Back to today</button>
      </div>
      <div class="fy-slider">
        <div class="fy-track">
          <div class="fy-bubble"></div>
          <div class="fy-rail"><div class="fy-fill"></div></div>
          ${[3, 6, 9].map((k) => `<span class="fy-qline" style="--p:${pos(monthStarts[k])}"></span>`).join('')}
          <span class="fy-now" style="--p:${pos(today)}" title="Today"></span>
          ${events.map((e) => `<button class="fy-pin ${e.kind}" type="button" style="--p:${pos(e.index)}"
              data-index="${e.index}" title="${esc(pinTitle(fy, e))}" aria-label="${esc(pinTitle(fy, e))}"></button>`).join('')}
          ${MONTHS.slice(3).concat(MONTHS.slice(0, 3)).map((m, k) => `<span class="fy-month"
              style="--p:${pos((monthStarts[k] + monthStarts[k + 1] - 1) / 2)}"><span class="full">${m}</span><span
              class="short">${m[0]}</span></span>`).join('')}
        </div>
        <input class="fy-range" type="range" min="0" max="${last}" step="1" value="${today}"
          aria-label="Pick a day in ${esc(fy.label)}">
      </div>
      <div class="fy-legend"><span><i class="fy-dot adv"></i>Advance tax</span><span><i
        class="fy-dot itr"></i>ITR dates</span><span><i class="fy-dot end"></i>Year end</span><span class="muted">Drag the
        slider or tap a marker</span></div>
      <div class="fy-readout"></div>
      <p class="fy-quip"></p>`;

    const range = host.querySelector('.fy-range');
    const big = host.querySelector('.fy-big');
    const sub = host.querySelector('.fy-sub');
    const bubble = host.querySelector('.fy-bubble');
    const fill = host.querySelector('.fy-fill');
    const readout = host.querySelector('.fy-readout');
    const quipEl = host.querySelector('.fy-quip');
    const todayBtn = host.querySelector('.fy-today');

    const show = (index) => {
      const isToday = index === today;
      const day = dateOfIndex(fy, index);
      const pct = percentDone(fy, isToday ? { ist: istWallClock() } : { index });
      const pctText = `${pct.toFixed(1)}%`;
      const left = last - index;
      fill.style.width = `${(index / last) * 100}%`;
      bubble.style.setProperty('--p', pos(index));
      bubble.textContent = `${isToday ? 'Today · ' : ''}${fmtDay(day, false)} ${SEASON[day.getUTCMonth()]}`;
      if (isToday) {
        big.innerHTML = `<span class="fy-pct">${pctText}</span> done`;
      } else if (index > today) {
        big.innerHTML = `<span class="fy-pct">${pctText}</span> done by ${esc(fmtDay(day))}`;
      } else {
        big.innerHTML = `<span class="fy-pct">${pctText}</span> was done by ${esc(fmtDay(day))}`;
      }
      sub.textContent = `Day ${index + 1} of ${fy.days} · ${left === 0 ? 'last day of the year' : `${left} day${left === 1 ? '' : 's'} to go`}`;
      range.setAttribute('aria-valuetext', `${fmtDay(day)}: ${pctText} of ${fy.label} done`);
      todayBtn.hidden = isToday;

      const onDay = events.find((e) => e.index === index);
      const next = events.find((e) => e.index > index);
      const parts = [];
      if (!isToday) parts.push(`<span><strong>${esc(fmtDay(day))}</strong> · ${esc(relDays(index - today))}</span>`);
      if (onDay) {
        parts.push(`<span><i class="fy-dot ${onDay.kind}"></i><strong>${esc(onDay.title)}</strong> (${esc(onDay.detail)})</span>`);
      }
      if (next) {
        const gap = next.index - index;
        parts.push(`<span>${isToday ? 'Next' : 'Next after that'}: <i class="fy-dot ${next.kind}"></i><strong>${
          esc(fmtDay(dateOfIndex(fy, next.index)))}</strong> — ${esc(next.title)} (${esc(next.detail)}), ${
          isToday ? esc(relDays(gap)) : `${gap} day${gap === 1 ? '' : 's'} later`}</span>`);
      }
      readout.innerHTML = parts.join('<span class="sep" aria-hidden="true">·</span>');
      const upcoming = events.find((e) => e.index >= today);
      quipEl.textContent = isToday
        ? quip(pct, upcoming, upcoming ? upcoming.index - today : Infinity)
        : `${index > today ? 'A peek ahead' : 'A look back'} — tap “Back to today” to return.`;
    };

    range.addEventListener('input', () => { moved = Number(range.value) !== today; show(Number(range.value)); });
    todayBtn.addEventListener('click', () => { moved = false; range.value = String(today); show(today); });
    host.querySelectorAll('.fy-pin').forEach((pin) => pin.addEventListener('click', () => {
      range.value = pin.dataset.index;
      moved = Number(pin.dataset.index) !== today;
      show(Number(pin.dataset.index));
    }));
    show(today);
    return { fyStart: fy.start, today, refresh: () => show(today) };
  }

  let view = build(new Date());
  // While the page stays open, keep "today" current: the percent ticks up each
  // minute, and the slider is rebuilt when the date (or the year) changes.
  setInterval(() => {
    if (moved) return;
    const ist = istWallClock();
    const fy = financialYear(ist);
    if (fy.start !== view.fyStart || dayIndexOf(fy, ist.getTime()) !== view.today) {
      view = build(new Date());
    } else {
      view.refresh();
    }
  }, 60000);
}
