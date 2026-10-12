// Home: a search over everything on the site, shortcuts, the four sections with their latest
// sync status, and a story from market history.
import { ago, dataUrl, esc, istDateTime, loadJSON } from './core.js';
import { icon } from './icons.js';
import { attachSearch } from './search.js';
import { renderShell } from './shell.js';
import { pageSeed, renderTrivia } from './trivia.js';
import { composeView, US_LISTS } from './us-lists.js';

renderShell('home', { showCurrency: false });
document.querySelectorAll('[data-trivia]').forEach((el) => renderTrivia(el, { seed: pageSeed(), pool: el.dataset.trivia || 'market' }));
document.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
attachSearch(document.getElementById('home-search'));

function showMeta(market, snap) {
  const meta = document.querySelector(`[data-meta="${market}"]`);
  const top = snap.ranked.slice(0, 3).map((r) => esc(r.symbol)).join(', ');
  meta.title = `Last synced ${istDateTime(snap.generated_at)}`;
  meta.innerHTML = `Updated ${esc(ago(snap.generated_at))}${top ? ` · top: <strong>${top}</strong>` : ''}`;
}

function unavailable(market) {
  document.querySelector(`[data-meta="${market}"]`).textContent = 'Latest data unavailable right now.';
}

loadJSON(dataUrl('india')).then((snap) => showMeta('india', snap)).catch(() => unavailable('india'));

// The US card sums up both lists, ranked together as on the US page's "All US" view.
Promise.allSettled(US_LISTS.map((list) => loadJSON(dataUrl(list.key)))).then((results) => {
  const loaded = results.flatMap((res, i) => (res.status === 'fulfilled' ? [{ list: US_LISTS[i], snap: res.value }] : []));
  const snap = composeView(loaded, 'all');
  if (!snap) {
    unavailable('us');
    return;
  }
  showMeta('us', snap);
});

// The fund card: when it was synced and the top Nifty 50 index fund.
loadJSON(dataUrl('mf')).then((snap) => {
  const meta = document.querySelector('[data-meta="mf"]');
  const top = snap.groups.find((g) => g.key === 'nifty50')?.funds.find((f) => f.rank === 1);
  meta.title = `Last synced ${istDateTime(snap.generated_at)}`;
  meta.innerHTML = `Updated ${esc(ago(snap.generated_at))}${top ? ` · top Nifty 50 fund: <strong>${esc(top.name)}</strong>` : ''}`;
}).catch(() => unavailable('mf'));
