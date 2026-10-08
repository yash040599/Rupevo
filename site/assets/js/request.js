// "Request refresh": visitors ask the maintainer to re-run a ranking or the fund comparison.
// The email carries a link that refreshes the page from the owner's browser (admin.js).
import { SITE } from './config.js';
import { ago, esc, istDateTime, openModal, store, tradingDay } from './core.js';
import { openContactModal } from './mail.js';
import { refreshLink, WORKFLOW_PAGE } from './admin.js';

const cooldownKey = (market) => `rupevo-request-${market}`;

// When each page refreshes by itself (.github/workflows/refresh-data.yml).
export const SCHEDULES = {
  india: 'every Tuesday to Saturday at about 7 am IST, with the previous trading day\'s closing prices',
  us: 'every Tuesday to Saturday at about 7 am IST, with the previous trading day\'s closing prices',
  mf: 'every Saturday at about 9:30 am IST, with Friday\'s NAVs',
};

function lastRequest(market) {
  const t = Number(store.get(cooldownKey(market)) || 0);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

export function openRequestModal({ market, title, generatedAt, dataThrough, dataNoun = 'prices' }) {
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

  const schedule = SCHEDULES[market];
  const throughLabel = `${dataNoun.charAt(0).toUpperCase()}${dataNoun.slice(1)} through`;
  openContactModal({
    title: `Request a ${title} refresh`,
    intro: `<p>The data was last synced <strong>${esc(istDateTime(generatedAt))}</strong>
      (${esc(dataNoun)} through ${esc(tradingDay(dataThrough))}).${schedule
        ? ` It refreshes by itself ${esc(schedule)}.` : ''} Need it sooner? Send a request and
      the maintainer will be notified.</p>`,
    fields: [{ id: 'note', label: 'Note', type: 'textarea', maxlength: 500,
      placeholder: 'e.g. Results season — could you refresh before Monday?' }],
    submitLabel: 'Send request',
    successMessage: 'Request sent — thank you!',
    compose: ({ note }) => {
      const link = refreshLink(market);
      return {
        subject: `Rupevo refresh request: ${title}`,
        message: [
          `Refresh request for the ${title} page on Rupevo.`,
          '',
          `Last synced: ${istDateTime(generatedAt)}`,
          `${throughLabel}: ${tradingDay(dataThrough)}`,
          `Page: ${window.location.href}`,
          '',
          `Note from visitor: ${note || '(none)'}`,
          '',
          'For the site owner:',
          `Refresh now: ${link}`,
          '(opens the page and asks you to confirm; it needs your admin token saved in that browser)',
          `Or on GitHub: ${WORKFLOW_PAGE} -> Run workflow -> ${market}`,
        ].join('\n'),
        extra: { market, last_synced: generatedAt, refresh_link: link },
      };
    },
    onSent: () => store.set(cooldownKey(market), String(Date.now())),
  });
}
