// "Request refresh": visitors ask the maintainer to re-run a ranking.
import { SITE } from './config.js';
import { ago, esc, istDateTime, openModal, store, tradingDay } from './core.js';
import { openContactModal } from './mail.js';

const cooldownKey = (market) => `rupevo-request-${market}`;

function lastRequest(market) {
  const t = Number(store.get(cooldownKey(market)) || 0);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

export function openRequestModal({ market, title, generatedAt, dataThrough }) {
  const last = lastRequest(market);
  if (last && Date.now() - last < SITE.requestCooldownHours * 3600 * 1000) {
    openModal({
      title: 'Refresh already requested',
      body: `<p>You asked for a ${esc(title)} refresh ${esc(ago(new Date(last).toISOString()))}.
        Thanks — the maintainer has been notified. The page shows the new
        “Last synced” time once the data is refreshed.</p>`,
      actions: [{ label: 'OK' }],
    });
    return;
  }

  openContactModal({
    title: `Request a ${title} refresh`,
    intro: `<p>The ranking was last synced <strong>${esc(istDateTime(generatedAt))}</strong>
      (prices through ${esc(tradingDay(dataThrough))}). Rankings are refreshed manually by the
      maintainer — send a request and they will be notified.</p>`,
    fields: [{ id: 'note', label: 'Note', type: 'textarea', maxlength: 500,
      placeholder: 'e.g. Results season — could you refresh before Monday?' }],
    submitLabel: 'Send request',
    successMessage: 'Request sent — thank you!',
    compose: ({ note }) => ({
      subject: `Rupevo refresh request: ${title}`,
      message: [
        `Refresh request for the ${title} page on Rupevo.`,
        '',
        `Last synced: ${istDateTime(generatedAt)}`,
        `Prices through: ${tradingDay(dataThrough)}`,
        `Page: ${window.location.href}`,
        '',
        `Note from visitor: ${note || '(none)'}`,
      ].join('\n'),
      extra: { market, last_synced: generatedAt },
    }),
    onSent: () => store.set(cooldownKey(market), String(Date.now())),
  });
}
