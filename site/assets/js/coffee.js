// "Buy me a coffee" dialog: the UPI QR code and the UPI ID to pay from any UPI
// app. There is deliberately no button that opens a UPI app: apps reject
// payment links (upi://pay?pa=…) to a personal UPI ID, so the payment has to
// start inside the app, by typing the UPI ID or scanning the QR code.
import { SITE } from './config.js';
import { esc, openModal, siteUrl } from './core.js';
import { mobilePlatform } from './device.js';

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

function phoneBody(id, payee) {
  return `${INTRO}
    <div class="upi-box">
      <div class="small muted">UPI ID · paid to ${esc(payee)}</div>
      ${idRow(id)}
    </div>
    <section class="pay-here" aria-labelledby="pay-here-title">
      <h3 id="pay-here-title">Pay from this phone</h3>
      <ol class="pay-steps">
        <li>Copy the UPI ID above.</li>
        <li>Open the UPI app you use (Google Pay, PhonePe, Paytm, slice or any other) and choose to pay a UPI ID.</li>
        <li>Paste it, enter the amount and pay.</li>
      </ol>
    </section>
    <div class="qr-row">
      ${qrFigure(id, 120)}
      <div class="qr-side">
        <strong>Or use the QR code</strong>
        <p class="small muted">Scan it from another phone. On this phone, save it, then in your UPI app tap Scan
          and pick it from your photos.</p>
        <div>${saveQr('small')}</div>
      </div>
    </div>
    <p class="small muted">Why no “pay now” button? UPI apps reject payment links to personal UPI IDs to stop
      fraud, so the payment has to start in your app. ${PRIVACY}</p>`;
}

/**
 * Copies `text` synchronously where the browser allows (a modal dialog makes
 * the rest of the page inert, so the helper element goes inside the dialog),
 * then also through the Clipboard API.
 */
async function copyText(text, host) {
  const before = document.activeElement;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px';
  host.append(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  area.remove();
  before?.focus?.({ preventScroll: true });
  const viaApi = navigator.clipboard?.writeText
    ? navigator.clipboard.writeText(text).then(() => true, () => false)
    : Promise.resolve(false);
  return copied || viaApi;
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
    body: platform ? phoneBody(id, payee) : desktopBody(id, payee),
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

  if (platform === 'ios') saveQrViaShareSheet(ui.body.querySelector('#save-qr'));
}
