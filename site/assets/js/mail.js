// Messages to the maintainer from the static site. Sent in-page through
// Web3Forms when an access key is configured (config.js), otherwise handed to
// the visitor's email app as a pre-filled mailto: link.
import { SITE } from './config.js';
import { esc, openModal, toast } from './core.js';

const WEB3FORMS_URL = 'https://api.web3forms.com/submit';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const contactAddress = () => `${SITE.contact.user}@${SITE.contact.domain}`;
export const canSendInPage = () => Boolean(SITE.web3formsKey);
export const mailtoHref = (subject, body = '') => `mailto:${contactAddress()}`
  + `?subject=${encodeURIComponent(subject)}${body ? `&body=${encodeURIComponent(body)}` : ''}`;

async function sendViaWeb3Forms({ subject, message, email, extra }) {
  const res = await fetch(WEB3FORMS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      access_key: SITE.web3formsKey,
      subject,
      from_name: 'Rupevo website',
      message,
      page: window.location.href,
      ...extra,
      ...(email ? { email } : {}),
      botcheck: false,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(data.message || `HTTP ${res.status}`);
}

function fieldHtml(f) {
  const label = `${esc(f.label)}${f.required ? '' : ' <span class="field-hint">(optional)</span>'}`
    + (f.hint ? ` <span class="field-hint">${esc(f.hint)}</span>` : '');
  const common = `id="cf-${esc(f.id)}" maxlength="${f.maxlength || 200}"`
    + `${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}${f.required ? ' required' : ''}`
    + `${f.autocomplete ? ` autocomplete="${esc(f.autocomplete)}"` : ''}`;
  const control = f.type === 'textarea'
    ? `<textarea ${common}></textarea>`
    : `<input type="${f.type || 'text'}" ${common}${f.value ? ` value="${esc(f.value)}"` : ''}>`;
  return `<label class="field"><span>${label}</span>${control}</label>`;
}

/**
 * Open a small form that messages the maintainer.
 * `fields`: [{ id, label, type, required, maxlength, placeholder, hint, value }]
 * `compose(values)` returns { subject, message, extra }.
 */
export function openContactModal({ title, intro = '', fields = [], submitLabel = 'Send',
  compose, successMessage = 'Sent — thank you!', onSent }) {
  const viaEmail = !canSendInPage();
  const allFields = [...fields, {
    id: 'email', label: 'Your email', type: 'email', maxlength: 120,
    placeholder: 'you@example.com', hint: '— only if you would like a reply', autocomplete: 'email',
  }];
  const ui = openModal({
    title,
    body: `${intro}
      <form class="contact-form" novalidate>${allFields.map(fieldHtml).join('')}
        <label class="honeypot" aria-hidden="true">Leave this empty
          <input type="checkbox" id="cf-botcheck" tabindex="-1" autocomplete="off"></label>
      </form>
      ${viaEmail ? '<p class="small muted">This opens your email app with the message pre-filled.</p>' : ''}
      <div class="cf-status" hidden></div>`,
    actions: [
      { label: 'Cancel', kind: 'alt' },
      {
        label: viaEmail ? 'Open email' : submitLabel,
        onClick: async ({ close, btn }) => {
          const status = ui.body.querySelector('.cf-status');
          const show = (text, cls) => {
            status.hidden = false;
            status.className = `cf-status status-line ${cls || ''}`.trim();
            status.innerHTML = text;
          };
          const values = {};
          for (const f of allFields) {
            values[f.id] = ui.body.querySelector(`#cf-${f.id}`).value.trim().slice(0, f.maxlength || 200);
          }
          const missing = fields.find((f) => f.required && !values[f.id]);
          if (missing) {
            show(`Please fill in “${esc(missing.label)}”.`, 'bad');
            ui.body.querySelector(`#cf-${missing.id}`).focus();
            return;
          }
          if (values.email && !EMAIL_RE.test(values.email)) {
            show('That email address does not look right — fix it or leave it blank.', 'bad');
            return;
          }
          if (ui.body.querySelector('#cf-botcheck').checked) { close(); return; }

          const { subject, message, extra = {} } = compose(values);
          if (viaEmail) {
            onSent?.(values);
            close();
            window.location.href = mailtoHref(subject,
              message + (values.email ? `\n\nReply to: ${values.email}` : ''));
            return;
          }
          btn.disabled = true;
          show('Sending…');
          try {
            await sendViaWeb3Forms({ subject, message, email: values.email, extra });
            onSent?.(values);
            close();
            toast(successMessage, 'ok');
          } catch (err) {
            btn.disabled = false;
            show(`Could not send (${esc(err.message)}). You can
              <a href="${esc(mailtoHref(subject, message))}">email it instead</a>.`, 'bad');
          }
        },
      },
    ],
  });
  ui.body.querySelector('input, textarea')?.focus();
  return ui;
}
