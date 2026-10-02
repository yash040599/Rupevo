// "Request refresh": visitors ask the maintainer to re-run a ranking.
// Delivered through Web3Forms when an access key is configured, otherwise by
// opening the visitor's mail app with a pre-filled message.
import { SITE } from './config.js';
import { ago, esc, istDateTime, openModal, store, toast, tradingDay } from './core.js';

const WEB3FORMS_URL = 'https://api.web3forms.com/submit';
const contactAddress = () => `${SITE.contact.user}@${SITE.contact.domain}`;
const cooldownKey = (market) => `rupevo-request-${market}`;

function lastRequest(market) {
  const t = Number(store.get(cooldownKey(market)) || 0);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

function composeMessage({ title, generatedAt, dataThrough, note }) {
  return [
    `Refresh request for the ${title} page on Rupevo.`,
    '',
    `Last synced: ${istDateTime(generatedAt)}`,
    `Prices through: ${tradingDay(dataThrough)}`,
    `Page: ${window.location.href}`,
    '',
    `Note from visitor: ${note || '(none)'}`,
  ].join('\n');
}

export function openRequestModal({ market, title, generatedAt, dataThrough }) {
  const last = lastRequest(market);
  const coolMs = SITE.requestCooldownHours * 3600 * 1000;
  if (last && Date.now() - last < coolMs) {
    openModal({
      title: 'Refresh already requested',
      body: `<p>You asked for a ${esc(title)} refresh ${esc(ago(new Date(last).toISOString()))}.
        Thanks — the maintainer has been notified. The page shows the new
        “Last synced” time once the data is refreshed.</p>`,
      actions: [{ label: 'OK' }],
    });
    return;
  }

  const viaEmail = !SITE.web3formsKey;
  const ui = openModal({
    title: `Request a ${title} refresh`,
    body: `
      <p>The ranking was last synced <strong>${esc(istDateTime(generatedAt))}</strong>
      (prices through ${esc(tradingDay(dataThrough))}). Rankings are refreshed manually by the
      maintainer — send a request and they will be notified.</p>
      <form id="request-form" novalidate>
        <label class="field"><span>Note <span class="field-hint">(optional)</span></span>
          <textarea id="request-note" maxlength="500" placeholder="e.g. Results season — could you refresh before Monday?"></textarea>
        </label>
        <label class="field" style="margin-top:10px"><span>Your email <span class="field-hint">(optional — only if you'd like a reply)</span></span>
          <input type="email" id="request-email" maxlength="120" autocomplete="email" placeholder="you@example.com">
        </label>
        <label class="honeypot" aria-hidden="true">Leave this empty
          <input type="checkbox" id="request-botcheck" tabindex="-1" autocomplete="off">
        </label>
      </form>
      ${viaEmail ? '<p class="small muted">This opens your email app with the request pre-filled.</p>' : ''}
      <div id="request-status" hidden></div>`,
    actions: [
      { label: 'Cancel', kind: 'alt' },
      {
        label: viaEmail ? 'Open email' : 'Send request',
        onClick: async ({ close, btn }) => {
          const note = ui.body.querySelector('#request-note').value.trim().slice(0, 500);
          const email = ui.body.querySelector('#request-email').value.trim();
          const status = ui.body.querySelector('#request-status');
          if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            status.hidden = false;
            status.className = 'status-line bad';
            status.textContent = 'That email address does not look right — fix it or leave it blank.';
            return;
          }
          if (ui.body.querySelector('#request-botcheck').checked) { close(); return; }
          const message = composeMessage({ title, generatedAt, dataThrough, note });
          const subject = `Rupevo refresh request: ${title}`;

          if (viaEmail) {
            const href = `mailto:${contactAddress()}?subject=${encodeURIComponent(subject)}`
              + `&body=${encodeURIComponent(message + (email ? `\nReply to: ${email}` : ''))}`;
            store.set(cooldownKey(market), String(Date.now()));
            close();
            window.location.href = href;
            return;
          }

          btn.disabled = true;
          status.hidden = false;
          status.className = 'status-line';
          status.textContent = 'Sending…';
          try {
            const res = await fetch(WEB3FORMS_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify({
                access_key: SITE.web3formsKey,
                subject,
                from_name: 'Rupevo website',
                message,
                market,
                page: window.location.href,
                last_synced: generatedAt,
                ...(email ? { email } : {}),
                botcheck: false,
              }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.success === false) throw new Error(data.message || `HTTP ${res.status}`);
            store.set(cooldownKey(market), String(Date.now()));
            close();
            toast('Request sent — thank you!', 'ok');
          } catch (err) {
            btn.disabled = false;
            status.className = 'status-line bad';
            status.innerHTML = `Could not send the request (${esc(err.message)}).
              You can <a href="mailto:${esc(contactAddress())}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}">email it instead</a>.`;
          }
        },
      },
    ],
  });
}
