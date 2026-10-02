// Landing page: links to the rankings with their latest sync status.
import { ago, dataUrl, esc, istDateTime, loadJSON } from './core.js';
import { renderShell } from './shell.js';

renderShell('home', { showCurrency: false });

for (const market of ['india', 'us']) {
  const meta = document.querySelector(`[data-meta="${market}"]`);
  loadJSON(dataUrl(market)).then((snap) => {
    const top = snap.ranked.slice(0, 3).map((r) => esc(r.symbol)).join(', ');
    meta.innerHTML = `Last synced ${esc(istDateTime(snap.generated_at))} (${esc(ago(snap.generated_at))})
      <br>${snap.stats.ranked} ranked${top ? ` · top: <strong>${top}</strong>` : ''}`;
  }).catch(() => {
    meta.textContent = 'Latest data unavailable right now.';
  });
}
