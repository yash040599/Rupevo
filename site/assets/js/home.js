// Landing page: links to the rankings with their latest sync status, and a story from market history.
import { ago, dataUrl, esc, istDateTime, loadJSON } from './core.js';
import { renderShell } from './shell.js';
import { pageSeed, renderTrivia } from './trivia.js';
import { composeView, US_LISTS } from './us-lists.js';

renderShell('home', { showCurrency: false });
document.querySelectorAll('[data-trivia]').forEach((el) => renderTrivia(el, { seed: pageSeed(), pool: el.dataset.trivia || 'market' }));

function showMeta(market, snap, extra = '') {
  const meta = document.querySelector(`[data-meta="${market}"]`);
  const top = snap.ranked.slice(0, 3).map((r) => esc(r.symbol)).join(', ');
  meta.innerHTML = `Last synced ${esc(istDateTime(snap.generated_at))} (${esc(ago(snap.generated_at))})
    <br>${snap.stats.ranked} ranked${extra}${top ? ` · top: <strong>${top}</strong>` : ''}`;
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
  showMeta('us', snap, snap.multi ? ` (${snap.lists.map((l) => `${esc(l.exchange)} ${l.ranked}`).join(', ')})` : '');
});
