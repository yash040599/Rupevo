// Shared primitives: escaping, formatting, preferences, dialogs, data loading.

export const SITE_ROOT = new URL('../../', import.meta.url);
export const siteUrl = (path = '') => new URL(path, SITE_ROOT).href;
export const dataUrl = (market) => new URL(`data/${market}.json`, SITE_ROOT);

// ── Storage (private mode / disabled storage must never break the page) ──
export const store = {
  get(key, area = 'local') {
    try { return (area === 'session' ? sessionStorage : localStorage).getItem(key); } catch { return null; }
  },
  set(key, value, area = 'local') {
    try { (area === 'session' ? sessionStorage : localStorage).setItem(key, value); } catch { /* ignore */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); sessionStorage.removeItem(key); } catch { /* ignore */ }
  },
};

// ── Escaping & number formatting ──
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const DASH = '—';

export function num(v, digits = 2, locale = 'en-US') {
  return isNum(v)
    ? v.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : DASH;
}
export const pct = (v, digits = 1) => (isNum(v) ? `${v.toFixed(digits)}%` : DASH);
export function signedPct(v, digits = 1) {
  if (!isNum(v)) return DASH;
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}${Math.abs(v).toFixed(digits)}%`;
}
export const tone = (v) => (!isNum(v) || v === 0 ? '' : v > 0 ? 'pos' : 'neg');
export const toned = (v, digits = 1) => `<span class="${tone(v)}">${signedPct(v, digits)}</span>`;

// ── Currency: one global display preference, converted with the snapshot FX ──
const CUR_KEY = 'rupevo-currency';
const currencyState = { native: 'INR', rate: 0 };
const currencyListeners = new Set();

export const currency = {
  configure(native, usdInr) {
    currencyState.native = native;
    currencyState.rate = isNum(usdInr) && usdInr > 0 ? usdInr : 0;
  },
  get rate() { return currencyState.rate; },
  get native() { return currencyState.native; },
  get display() {
    const saved = store.get(CUR_KEY);
    if ((saved === 'INR' || saved === 'USD') && (saved === currencyState.native || currencyState.rate > 0)) {
      return saved;
    }
    return currencyState.native;
  },
  set(code) {
    store.set(CUR_KEY, code);
    currencyListeners.forEach((fn) => fn(code));
  },
  onChange(fn) { currencyListeners.add(fn); },
};

function convert(value, native) {
  const display = currency.display;
  if (native === display || !currency.rate) return { v: value, cur: native };
  return { v: native === 'USD' ? value * currency.rate : value / currency.rate, cur: display };
}

export function money(value, { native = currency.native, digits = 2 } = {}) {
  if (!isNum(value)) return DASH;
  const { v, cur } = convert(value, native);
  const locale = cur === 'INR' ? 'en-IN' : 'en-US';
  const sign = v < 0 ? '−' : '';
  return `${sign}${cur === 'INR' ? '₹' : '$'}${Math.abs(v).toLocaleString(locale, {
    minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function moneyCompact(value, { native = currency.native } = {}) {
  if (!isNum(value)) return DASH;
  const { v, cur } = convert(value, native);
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  if (cur === 'INR') {
    if (a >= 1e12) return `${sign}₹${(a / 1e12).toFixed(2)} L Cr`;
    if (a >= 1e7) return `${sign}₹${(a / 1e7).toLocaleString('en-IN', { maximumFractionDigits: a >= 1e9 ? 0 : 1 })} Cr`;
    if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(1)} L`;
    return `${sign}₹${a.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
  }
  if (a >= 1e12) return `${sign}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`;
  return `${sign}$${a.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

// ── Dates (published timestamps are IST; trading dates are plain YYYY-MM-DD) ──
const IST_FMT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric',
  hour: 'numeric', minute: '2-digit', hour12: true,
});
export function istDateTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? DASH : `${IST_FMT.format(d)} IST`;
}
export function tradingDay(isoDate) {
  if (!isoDate) return DASH;
  const [y, m, d] = String(isoDate).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return DASH;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
export function ago(iso) {
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(secs)) return '';
  if (secs < 90) return 'just now';
  const mins = secs / 60;
  if (mins < 90) return `${Math.round(mins)} min ago`;
  const hours = mins / 60;
  if (hours < 36) return `${Math.round(hours)} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

// ── Theme ──
export function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  store.set('rupevo-theme', next);
}

// ── Dialogs & toasts ──
export function openModal({ title, body = '', actions = [], onClose } = {}) {
  const dlg = document.createElement('dialog');
  dlg.className = 'modal';
  dlg.innerHTML = `
    <div class="modal-head"><h2>${esc(title)}</h2>
      <button class="icon-btn" type="button" data-close aria-label="Close">✕</button></div>
    <div class="modal-body"></div>
    <div class="modal-foot"></div>`;
  const bodyEl = dlg.querySelector('.modal-body');
  const footEl = dlg.querySelector('.modal-foot');
  if (typeof body === 'string') bodyEl.innerHTML = body; else bodyEl.append(body);
  const close = () => { if (dlg.open) dlg.close(); };
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn ${a.kind || ''}`.trim();
    btn.textContent = a.label;
    if (a.id) btn.id = a.id;
    btn.addEventListener('click', () => a.onClick ? a.onClick({ close, dlg, btn }) : close());
    footEl.append(btn);
  }
  if (!actions.length) footEl.remove();
  dlg.querySelector('[data-close]').addEventListener('click', close);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  dlg.addEventListener('close', () => { onClose?.(); dlg.remove(); });
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, body: bodyEl, foot: footEl, close };
}

let toastHost;
export function toast(message, kind = '') {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toasts';
    toastHost.setAttribute('role', 'status');
    toastHost.setAttribute('aria-live', 'polite');
    document.body.append(toastHost);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`.trim();
  el.textContent = message;
  toastHost.append(el);
  setTimeout(() => el.remove(), 5000);
}

// ── Data ──
export async function loadJSON(url, { bust = false } = {}) {
  const u = new URL(url);
  if (bust) u.searchParams.set('t', String(Date.now()));
  const res = await fetch(u, { cache: bust ? 'no-store' : 'no-cache' });
  if (!res.ok) throw new Error(`Could not load ${u.pathname} (HTTP ${res.status})`);
  return res.json();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
