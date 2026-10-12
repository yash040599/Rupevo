// Sheets: a bottom sheet on phones and a side sheet on wide screens, for a stock's or fund's
// details and for explanations. One at a time. Opening one adds a history entry, so the phone's
// Back button closes it instead of leaving the page.
import { esc } from './core.js';
import { icon } from './icons.js';

let dlg = null;
let current = null; // { onPrev, onNext, onBack, onClose }
let pushed = false;
let opener = null;

function build() {
  dlg = document.createElement('dialog');
  dlg.className = 'sheet';
  dlg.setAttribute('aria-labelledby', 'sheet-title');
  dlg.innerHTML = `
    <div class="sheet-handle" aria-hidden="true"></div>
    <header class="sheet-head">
      <button class="icon-btn sheet-back" type="button" aria-label="Back" hidden>${icon('back')}</button>
      <div class="sheet-titles"><h2 id="sheet-title"></h2><p class="sheet-sub"></p></div>
      <button class="icon-btn sheet-prev" type="button" aria-label="Previous" title="Previous">${icon('chevron-up')}</button>
      <button class="icon-btn sheet-next" type="button" aria-label="Next" title="Next">${icon('chevron-down')}</button>
      <button class="icon-btn sheet-close" type="button" aria-label="Close" title="Close">${icon('close')}</button>
    </header>
    <div class="sheet-body" tabindex="-1"></div>`;
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeSheet(); });
  // A click on the backdrop lands on the dialog element itself.
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeSheet(); });
  dlg.querySelector('.sheet-close').addEventListener('click', () => closeSheet());
  dlg.querySelector('.sheet-prev').addEventListener('click', () => current?.onPrev?.());
  dlg.querySelector('.sheet-next').addEventListener('click', () => current?.onNext?.());
  dlg.querySelector('.sheet-back').addEventListener('click', () => current?.onBack?.());
  dlg.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea')) return;
    if ((e.key === 'ArrowUp' || e.key === 'k') && current?.onPrev && e.altKey) { e.preventDefault(); current.onPrev(); }
    if ((e.key === 'ArrowDown' || e.key === 'j') && current?.onNext && e.altKey) { e.preventDefault(); current.onNext(); }
  });
  window.addEventListener('popstate', () => {
    if (dlg.open) {
      pushed = false;
      finish();
    }
  });
  document.body.append(dlg);
}

function fill({ title, sub = '', body = '', onPrev = null, onNext = null, onBack = null }) {
  dlg.querySelector('#sheet-title').textContent = title;
  const subEl = dlg.querySelector('.sheet-sub');
  subEl.innerHTML = sub;
  subEl.hidden = !sub;
  dlg.querySelector('.sheet-prev').hidden = !onPrev && !onNext;
  dlg.querySelector('.sheet-next').hidden = !onPrev && !onNext;
  dlg.querySelector('.sheet-prev').disabled = !onPrev;
  dlg.querySelector('.sheet-next').disabled = !onNext;
  dlg.querySelector('.sheet-back').hidden = !onBack;
  const bodyEl = dlg.querySelector('.sheet-body');
  if (typeof body === 'string') bodyEl.innerHTML = body; else bodyEl.replaceChildren(body);
  bodyEl.scrollTop = 0;
}

/**
 * Open (or, if one is open, replace the content of) the sheet.
 * `sub` is HTML (escape it); `body` is HTML or a node. `onPrev`/`onNext` show the step buttons,
 * `onBack` a back arrow, `onClose` runs once the sheet has closed.
 */
export function openSheet({ title, sub = '', body = '', onPrev = null, onNext = null, onBack = null, onClose = null }) {
  if (!dlg) build();
  const keepClose = dlg.open ? current?.onClose : null;
  current = { onPrev, onNext, onBack, onClose: onClose || keepClose };
  fill({ title, sub, body, onPrev, onNext, onBack });
  if (!dlg.open) {
    opener = document.activeElement;
    dlg.showModal();
    document.documentElement.classList.add('sheet-open');
    try {
      window.history.pushState({ rupevoSheet: true }, '');
      pushed = true;
    } catch { pushed = false; }
    dlg.querySelector('.sheet-body').focus({ preventScroll: true });
  }
  return dlg.querySelector('.sheet-body');
}

export function closeSheet() {
  if (!dlg?.open) return;
  if (pushed && window.history.state?.rupevoSheet) {
    window.history.back(); // popstate finishes the close
    setTimeout(() => { if (dlg.open) finish(); }, 400);
    return;
  }
  finish();
}

function finish() {
  if (!dlg.open) return;
  dlg.close();
  document.documentElement.classList.remove('sheet-open');
  pushed = false;
  const done = current?.onClose;
  current = null;
  done?.();
  if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
  opener = null;
}

export const sheetIsOpen = () => Boolean(dlg?.open);

/** A titled block inside a sheet. */
export const sheetSection = (title, html) => `<section class="sheet-section"><h3>${esc(title)}</h3>${html}</section>`;
