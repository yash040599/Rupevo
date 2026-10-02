// "Buy me a coffee" dialog: the UPI QR code and UPI ID and, on phones, a
// button per UPI app that copies the UPI ID and opens the app. upi.js
// explains why it opens the app rather than a payment link.
import { SITE } from './config.js';
import { esc, openModal, siteUrl } from './core.js';
import { UPI_APPS, appLink, mobilePlatform } from './upi.js';

const TITLE = 'Buy me a coffee ☕';
const INTRO = `<p>Rupevo is free and ad-free. If it helped you, chip in any amount you like — a coffee is
  about ₹100. Thank you!</p>`;
const PRIVACY = 'Payments go straight to the maintainer\'s bank account; Rupevo never sees your payment details.';

const idRow = (id) => `<div class="upi-id"><code id="upi-id-text">${esc(id)}</code>
  <button class="btn alt small" type="button" id="copy-upi">Copy</button></div>`;

const qrFigure = (id, px) => `<figure class="qr-card">
  <img src="${siteUrl('assets/img/upi-qr.svg')}" alt="UPI QR code to pay ${esc(id)}" width="${px}" height="${px}">
  <figcaption>Scan with any UPI app</figcaption></figure>`;

const saveQr = (size = '') => `<a class="btn alt ${size}" id="save-qr" href="${siteUrl('assets/img/upi-qr.png')}"
  download="rupevo-upi-qr.png">Save QR image</a>`;

function desktopBody(id, payee) {
  return `${INTRO}
    <div class="coffee-grid">
      ${qrFigure(id, 196)}
      <div class="coffee-side">
        <div class="small muted">UPI ID</div>
        ${idRow(id)}
        <div class="small muted">Paid to ${esc(payee)}</div>
        <div class="coffee-actions">${saveQr()}</div>
      </div>
    </div>
    <p class="small muted">Scan the code with your phone, or pay the UPI ID from any UPI app. ${PRIVACY}</p>`;
}

function phoneBody(id, payee, platform) {
  const apps = UPI_APPS.map((app) => `<a class="upi-app" href="${esc(appLink(app, platform))}"
      data-app="${esc(app.id)}"><span class="upi-app-mark" style="background:${esc(app.color)}"
      aria-hidden="true">${esc(app.mark)}</span>${esc(app.name)}</a>`).join('');
  const opens = platform === 'ios'
    ? 'the app opens'
    : 'the app\'s Play Store page opens, where you tap <strong>Open</strong>';
  return `${INTRO}
    <div class="upi-box">
      <div class="small muted">UPI ID · paid to ${esc(payee)}</div>
      ${idRow(id)}
    </div>
    <section class="pay-here" aria-labelledby="pay-here-title">
      <h3 id="pay-here-title">Pay from this phone</h3>
      <p class="small">Tap your UPI app: the UPI ID is copied and ${opens}. In the app, choose to pay a
        UPI ID, paste it, enter the amount and pay.</p>
      <div class="upi-apps">${apps}</div>
      <div id="upi-app-hint" role="status" aria-live="polite"></div>
      <p class="small muted">Another app? Copy the UPI ID and pay it from there.</p>
    </section>
    <div class="qr-row">
      ${qrFigure(id, 120)}
      <div class="qr-side">
        <strong>Or use the QR code</strong>
        <p class="small muted">Scan it from another phone. On this phone, save it, then in your UPI app tap
          Scan and pick it from your photos.</p>
        <div>${saveQr('small')}</div>
      </div>
    </div>
    <p class="small muted">Why not a one-tap payment link? UPI apps reject payment links to personal UPI IDs
      to stop fraud, so the payment has to start in your app. ${PRIVACY}</p>`;
}

/**
 * Copies `text` while the tap is still being handled: the page loses focus
 * once the app opens, and a clipboard write still pending then is refused.
 * The helper element goes inside the dialog because a modal dialog makes the
 * rest of the page inert.
 */
function copyNow(text, host) {
  const before = document.activeElement;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px';
  host.append(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  before?.focus?.({ preventScroll: true });
  return ok;
}

async function copyText(text, host) {
  const copied = copyNow(text, host);
  // Also inside the tap: iOS can report a successful copy above without making one.
  const viaApi = navigator.clipboard?.writeText
    ? navigator.clipboard.writeText(text).then(() => true, () => false)
    : Promise.resolve(false);
  return copied || viaApi;
}

function appHint(app, platform, copied) {
  const name = esc(app.name);
  const where = app.payTo ? `tap <strong>${esc(app.payTo)}</strong>` : 'choose to pay a UPI ID';
  const steps = platform === 'android'
    ? `On ${name}'s Play Store page tap <strong>Open</strong>, then ${where}`
    : `In ${name}, ${where}`;
  return `<div class="status-line ${copied ? 'ok' : 'bad'}">${copied ? 'UPI ID copied.'
    : 'Could not copy the UPI ID: copy it from the box above.'} ${steps}, paste the ID, enter the amount and
    pay.${platform === 'ios' ? ` If ${name} did not open, open it yourself.` : ''}</div>`;
}

// iPhones save downloads to the Files app, but UPI apps pick QR images from
// Photos, so offer the share sheet and its "Save Image" instead.
function saveQrViaShareSheet(link) {
  if (!link || !navigator.canShare) return;
  let file = null;
  fetch(link.href)
    .then((res) => (res.ok ? res.blob() : null))
    .then((blob) => {
      if (!blob) return;
      const candidate = new File([blob], 'rupevo-upi-qr.png', { type: 'image/png' });
      if (navigator.canShare({ files: [candidate] })) {
        file = candidate;
        link.textContent = 'Save QR to Photos';
      }
    })
    .catch(() => {});
  link.addEventListener('click', (e) => {
    if (!file) return;
    e.preventDefault();
    navigator.share({ files: [file] }).catch(() => {});
  });
}

export function openCoffee() {
  const { id, payee } = SITE.upi;
  if (!id) {
    openModal({
      title: TITLE,
      body: `<p>Thank you for thinking of it! Rupevo is free and ad-free. UPI payments are being
        set up and will be available here very soon.</p>`,
      actions: [{ label: 'Close' }],
    });
    return;
  }
  const platform = mobilePlatform(navigator);
  const ui = openModal({
    title: TITLE,
    body: platform ? phoneBody(id, payee, platform) : desktopBody(id, payee),
    actions: [{ label: 'Close', kind: 'alt' }],
  });

  ui.body.querySelector('#copy-upi').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (await copyText(id, ui.dlg)) {
      btn.textContent = 'Copied ✓';
    } else {
      const range = document.createRange();
      range.selectNodeContents(ui.body.querySelector('#upi-id-text'));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      btn.textContent = platform ? 'Selected: copy it' : 'Press Ctrl+C';
    }
    setTimeout(() => { btn.textContent = 'Copy'; }, 2500);
  });

  const hint = ui.body.querySelector('#upi-app-hint');
  ui.body.querySelectorAll('a.upi-app').forEach((link) => link.addEventListener('click', () => {
    // No preventDefault: the link opens the app as soon as this handler returns.
    const app = UPI_APPS.find((a) => a.id === link.dataset.app);
    copyText(id, ui.dlg).then((copied) => { hint.innerHTML = appHint(app, platform, copied); });
  }));

  if (platform === 'ios') saveQrViaShareSheet(ui.body.querySelector('#save-qr'));
}
