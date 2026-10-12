// Site-wide search: a dropdown under the search field on wide screens, a full-screen search view
// on phones. The stock and fund data loads on first use. Picking a result fires `rupevo:select`
// on window (cancelable: the current page can show it in place) before navigating.
import { dataUrl, esc, loadJSON, siteUrl } from './core.js';
import { icon } from './icons.js';
import { PAGES, buildIndex, searchIndex } from './search-index.js';
import { US_LISTS } from './us-lists.js';

const KIND_ICON = { page: 'spark', group: 'funds', fund: 'funds' };
const HINT = 'Search for a stock (RELIANCE, AAPL), a fund or fund house (Parag Parikh, Nifty 50) or a tool (SIP, Schedule FA).';
let index = PAGES;
let loading = null;
let uid = 0;

function loadIndex() {
  loading ||= Promise.allSettled([
    loadJSON(dataUrl('india')), ...US_LISTS.map((l) => loadJSON(dataUrl(l.key))), loadJSON(dataUrl('mf')),
  ]).then((res) => {
    const val = (r) => (r.status === 'fulfilled' ? r.value : null);
    const us = US_LISTS.map((l, i) => ({ snap: val(res[1 + i]), label: l.label })).filter((x) => x.snap);
    index = buildIndex({ india: val(res[0]), us, mf: val(res[res.length - 1]) });
  });
  return loading;
}

function itemHtml(it, i, id) {
  const lead = it.kind === 'stock'
    ? `<span class="si-lead si-badge">${esc(it.badge === 'NASDAQ' ? 'NQ' : it.badge === 'NYSE' ? 'NY' : 'NSE')}</span>`
    : `<span class="si-lead">${icon(KIND_ICON[it.kind] || 'spark', { size: 20 })}</span>`;
  return `<a class="search-item" role="option" id="${id}-${i}" data-i="${i}" href="${esc(siteUrl(it.href))}" aria-selected="false">
    ${lead}<span class="si-main"><span class="si-title">${esc(it.title)}</span><span class="si-sub">${esc(it.sub)}</span></span>
    ${it.meta ? `<span class="si-meta">${esc(it.meta)}</span>` : ''}</a>`;
}

/** Let the page show the result in place (it cancels the event), or go to it. */
function select(it) {
  const event = new CustomEvent('rupevo:select', { detail: it, cancelable: true });
  if (window.dispatchEvent(event)) window.location.href = siteUrl(it.href);
}

/**
 * Wire a `.search-field` form. Results go in `panel` (created as a dropdown if absent; `inline`
 * keeps it always shown). `onPick(item)` replaces the default: hide the dropdown, then select.
 */
export function attachSearch(form, { panel = null, inline = false, onPick = null, onEscape = null } = {}) {
  const input = form.querySelector('input');
  const id = `sr${(uid += 1)}`;
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'search-panel';
    form.append(panel);
  }
  panel.id = `${id}-list`;
  panel.setAttribute('role', 'listbox');
  panel.setAttribute('aria-label', 'Search results');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-controls', panel.id);
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-autocomplete', 'list');
  let results = [];
  let active = -1;

  const show = (open) => {
    panel.hidden = !inline && !open;
    input.setAttribute('aria-expanded', String(open));
  };
  const pick = (it) => {
    if (!it) return;
    if (onPick) onPick(it);
    else { show(false); input.blur(); select(it); }
  };
  const setActive = (i) => {
    active = i;
    panel.querySelectorAll('.search-item').forEach((el) => el.setAttribute('aria-selected', String(Number(el.dataset.i) === i)));
    const el = panel.querySelector(`[data-i="${i}"]`);
    if (el) {
      input.setAttribute('aria-activedescendant', el.id);
      el.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  };
  const render = () => {
    const q = input.value.trim();
    results = searchIndex(index, q);
    active = -1;
    input.removeAttribute('aria-activedescendant');
    if (!q) {
      panel.innerHTML = inline ? `<p class="search-hint">${HINT}</p>` : '';
      show(false);
      return;
    }
    const waiting = index === PAGES;
    panel.innerHTML = results.map((it, i) => itemHtml(it, i, id)).join('')
      + (waiting ? '<p class="search-hint">Searching stocks and funds…</p>'
        : results.length ? '' : `<p class="search-hint">Nothing matches “${esc(q)}”.</p>`);
    show(true);
  };

  input.addEventListener('focus', () => { loadIndex().then(render); if (input.value.trim()) render(); });
  input.addEventListener('input', () => { render(); loadIndex().then(render); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && results.length) { e.preventDefault(); setActive(Math.min(results.length - 1, active + 1)); }
    else if (e.key === 'ArrowUp' && results.length) { e.preventDefault(); setActive(Math.max(0, active - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(results[active >= 0 ? active : 0]); }
    else if (e.key === 'Escape') {
      e.preventDefault();
      if (input.value) { input.value = ''; render(); } else { show(false); input.blur(); onEscape?.(); }
    }
  });
  form.addEventListener('submit', (e) => e.preventDefault());
  panel.addEventListener('mousedown', (e) => { if (e.target.closest('.search-item')) e.preventDefault(); });
  panel.addEventListener('click', (e) => {
    const a = e.target.closest('.search-item');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    pick(results[Number(a.dataset.i)]);
  });
  if (!inline) document.addEventListener('click', (e) => { if (!form.contains(e.target)) show(false); });
  render();
  return { focus: () => input.focus(), clear: () => { input.value = ''; render(); } };
}

// ── Full-screen search on phones ──
// Opening adds a history entry (Back closes it). A pick waits until the view has closed and that
// entry is gone, so a page that then opens a sheet or navigates starts from a clean history.
let view = null;
let pushed = false;
let afterClose = null;

function finishView() {
  if (!view.dialog.open) return;
  view.dialog.close();
  document.documentElement.classList.remove('sheet-open');
  pushed = false;
  const next = afterClose;
  afterClose = null;
  next?.();
}

function closeView(then = null) {
  if (!view?.dialog.open) { then?.(); return; }
  afterClose = then;
  if (pushed && window.history.state?.rupevoSearch) {
    window.history.back();
    setTimeout(finishView, 400);
  } else finishView();
}

export function openSearchView() {
  if (!view) {
    const dialog = document.createElement('dialog');
    dialog.className = 'search-view';
    dialog.setAttribute('aria-label', 'Search');
    dialog.innerHTML = `<div class="sv-head">
        <button class="icon-btn sv-back" type="button" aria-label="Close search">${icon('back')}</button>
        <form class="search-field" role="search" autocomplete="off">
          <input type="search" placeholder="Search stocks, funds and tools" aria-label="Search stocks, funds and tools" enterkeyhint="search">
        </form>
      </div>
      <div class="search-panel inline"></div>`;
    document.body.append(dialog);
    const search = attachSearch(dialog.querySelector('form'), {
      panel: dialog.querySelector('.search-panel'), inline: true,
      onPick: (it) => closeView(() => select(it)), onEscape: () => closeView(),
    });
    dialog.querySelector('.sv-back').addEventListener('click', () => closeView());
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); closeView(); });
    window.addEventListener('popstate', () => { if (dialog.open) finishView(); });
    view = { dialog, search };
  }
  if (view.dialog.open) return;
  view.search.clear();
  view.dialog.showModal();
  document.documentElement.classList.add('sheet-open');
  try {
    window.history.pushState({ rupevoSearch: true }, '');
    pushed = true;
  } catch { pushed = false; }
  view.search.focus();
  loadIndex();
}
