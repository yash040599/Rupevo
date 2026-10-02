// Page chrome shared by every page: navigation, currency/theme toggles,
// footer with the disclaimer, "Buy me a coffee" and the admin entry point.
import { SITE } from './config.js';
import { currency, esc, istDateTime, num, openModal, siteUrl, toggleTheme } from './core.js';
import { openAdminPanel } from './admin.js';

const NAV = [
  { key: 'india', label: 'Nifty 100', href: 'india/', title: 'Indian Nifty 100 Ranking' },
  { key: 'us', label: 'NASDAQ-100', href: 'us/', title: 'US NASDAQ-100 Ranking' },
];

const DISCLAIMER = `<strong>Disclaimer.</strong> Rupevo is an independent, educational
  project. The rankings are produced automatically by a quantitative model from end-of-day
  market data and are shown for information only. Nothing on this site is investment advice,
  a research report, or a recommendation or offer to buy, sell or hold any security. The author
  is not registered with SEBI as an Investment Adviser or Research Analyst, nor with any other
  regulator. Data may be delayed, incomplete or inaccurate, and past performance does not
  guarantee future results. Investments in securities markets are subject to market risks;
  read all related documents carefully and consult a SEBI-registered adviser before investing.`;

export function renderShell(page, { showCurrency = true, onAdminRefreshed } = {}) {
  const nav = document.getElementById('site-nav');
  nav.className = 'topnav';
  nav.innerHTML = `
    <a class="brand" href="${siteUrl('')}" title="Rupevo home"><span class="brand-mark">R</span>Rupevo</a>
    <nav class="nav-links" aria-label="Rankings">
      ${NAV.map((item) => `<a href="${siteUrl(item.href)}" title="${esc(item.title)}"${
        item.key === page ? ' aria-current="page"' : ''}>${esc(item.label)}</a>`).join('')}
    </nav>
    <span class="nav-spacer"></span>
    <span class="fx-badge" id="fx-badge" hidden></span>
    ${showCurrency ? `<button class="cur-toggle" id="cur-toggle" type="button"
        title="Show prices in rupees or dollars" aria-label="Display currency">
        <span class="cur-pill" data-cur="INR">₹ INR</span><span class="cur-pill" data-cur="USD">$ USD</span>
      </button>` : ''}
    <button class="icon-btn" id="theme-toggle" type="button" title="Switch light / dark theme"
      aria-label="Toggle colour theme"><span class="theme-sun" aria-hidden="true">☀</span><span
      class="theme-moon" aria-hidden="true">☾</span></button>`;

  nav.querySelector('#theme-toggle').addEventListener('click', toggleTheme);
  nav.querySelector('#cur-toggle')?.addEventListener('click', () => {
    if (!currency.rate) return;
    currency.set(currency.display === 'INR' ? 'USD' : 'INR');
    syncCurrencyToggle();
  });

  const footer = document.getElementById('site-footer');
  footer.className = 'site-footer';
  footer.innerHTML = `
    <div class="inner">
      <div class="footer-row">
        <a class="brand" href="${siteUrl('')}"><span class="brand-mark">R</span>Rupevo</a>
        <span class="muted small">Market rankings, explained.</span>
        <span class="spacer"></span>
        <button class="btn coffee-btn" id="coffee-btn" type="button">☕ Buy me a coffee</button>
      </div>
      <p class="disclaimer">${DISCLAIMER}</p>
      <div class="footer-links">
        <span>Prices &amp; fundamentals: Yahoo Finance (end-of-day). Index lists: NSE India, Nasdaq.
          Not affiliated with any exchange, data provider or broker.</span>
        <a href="https://github.com/${esc(SITE.repo.owner)}/${esc(SITE.repo.name)}" target="_blank" rel="noopener">Source on GitHub</a>
        <button class="linkish" id="admin-link" type="button">Admin</button>
        <span>© ${SITE.year} Rupevo</span>
      </div>
    </div>`;
  footer.querySelector('#coffee-btn').addEventListener('click', openCoffee);
  footer.querySelector('#admin-link').addEventListener('click',
    () => openAdminPanel({ onRefreshed: onAdminRefreshed }));
}

export function syncCurrencyToggle() {
  const toggle = document.getElementById('cur-toggle');
  if (!toggle) return;
  const active = currency.display;
  toggle.querySelectorAll('.cur-pill').forEach((pill) => {
    pill.classList.toggle('active', pill.dataset.cur === active);
  });
  toggle.disabled = !currency.rate;
  toggle.title = currency.rate
    ? `Showing ${active === 'INR' ? 'rupees' : 'dollars'} — click to switch`
    : 'Currency conversion unavailable (no exchange rate in this snapshot)';
}

export function showFx(fx) {
  const badge = document.getElementById('fx-badge');
  if (!badge || !fx?.usd_inr) return;
  badge.hidden = false;
  badge.innerHTML = `USD/INR <strong>${num(fx.usd_inr, 2)}</strong>`;
  badge.title = `${fx.source || 'Exchange rate'}, ${fx.as_of ? istDateTime(fx.as_of) : 'date unknown'}`
    + (fx.stale ? ' (last known rate)' : '');
}

function openCoffee() {
  const { id, payee } = SITE.upi;
  if (!id) {
    openModal({
      title: 'Buy me a coffee ☕',
      body: `<p>Thank you for thinking of it! Rupevo is free and ad-free. UPI payments are being
        set up and will be available here very soon.</p>`,
      actions: [{ label: 'Close' }],
    });
    return;
  }
  const link = `upi://pay?pa=${encodeURIComponent(id)}&pn=${encodeURIComponent(payee)}`
    + `&cu=INR&tn=${encodeURIComponent('Buy me a coffee - Rupevo')}`;
  openModal({
    title: 'Buy me a coffee ☕',
    body: `<p>Rupevo is free and ad-free. If it helped you, you can chip in with any amount via UPI.</p>
      <p><a class="btn" href="${esc(link)}">Pay with a UPI app</a></p>
      <p class="small muted">On a computer? Pay from any UPI app to <strong>${esc(id)}</strong>.</p>`,
    actions: [{ label: 'Close', kind: 'alt' }],
  });
}
