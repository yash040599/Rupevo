// Page chrome shared by every page: navigation, currency/theme toggles,
// "Buy me a coffee" (nav, floating button on mobile, footer), footer with the
// disclaimer and the admin entry point.
import { SITE } from './config.js';
import { currency, esc, istDateTime, num, siteUrl, toggleTheme } from './core.js';
import { openAdminPanel } from './admin.js';
import { openCoffee } from './coffee.js';
import { contactAddress, mailtoHref } from './mail.js';

const NAV = [
  { key: 'india', label: 'Nifty 100', href: 'india/', title: 'Indian Nifty 100 Ranking' },
  { key: 'us', label: 'NASDAQ-100', href: 'us/', title: 'US NASDAQ-100 Ranking' },
  { key: 'tax', label: 'Tax', href: 'tax/', title: 'Tax tools: RSU taxation and more' },
];

const DISCLAIMER = `<strong>Disclaimer.</strong> Rupevo is an independent, educational
  project. The rankings are produced automatically by a quantitative model from end-of-day
  market data and are shown for information only. Nothing on this site is investment advice,
  a research report, or a recommendation or offer to buy, sell or hold any security. The author
  is not registered with SEBI as an Investment Adviser or Research Analyst, nor with any other
  regulator. Data may be delayed, incomplete or inaccurate, and past performance does not
  guarantee future results. Investments in securities markets are subject to market risks;
  read all related documents carefully and consult a SEBI-registered adviser before investing.
  The tax guides are general information, not tax or legal advice; tax rules change and depend
  on your circumstances, so verify with a chartered accountant before filing.`;

export function renderShell(page, { showCurrency = true, onAdminRefreshed } = {}) {
  const nav = document.getElementById('site-nav');
  nav.className = 'topnav';
  nav.innerHTML = `
    <a class="brand" href="${siteUrl('')}" title="Rupevo home"><span class="brand-mark">R</span><span
      class="brand-text">Rupevo</span></a>
    <nav class="nav-links" aria-label="Main">
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
      class="theme-moon" aria-hidden="true">☾</span></button>
    <button class="btn coffee-btn nav-coffee" id="nav-coffee" type="button"
      title="Buy me a coffee — support Rupevo via UPI" aria-label="Buy me a coffee"><span
      aria-hidden="true">☕</span><span class="nav-coffee-text">Buy me a coffee</span></button>`;

  nav.querySelector('#theme-toggle').addEventListener('click', toggleTheme);
  nav.querySelector('#nav-coffee').addEventListener('click', openCoffee);
  nav.querySelector('#cur-toggle')?.addEventListener('click', () => {
    if (!currency.rate) return;
    currency.set(currency.display === 'INR' ? 'USD' : 'INR');
    syncCurrencyToggle();
  });

  // The nav is sticky on wide screens, so its coffee button is always on
  // screen there. On phones the nav scrolls away, so a floating button
  // takes over once it is out of view.
  const fab = document.createElement('button');
  fab.className = 'coffee-fab';
  fab.type = 'button';
  fab.title = 'Buy me a coffee';
  fab.setAttribute('aria-label', 'Buy me a coffee');
  fab.textContent = '☕';
  fab.addEventListener('click', openCoffee);
  document.body.append(fab);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => fab.classList.toggle('show', !entry.isIntersecting))
      .observe(nav);
  }

  const footer = document.getElementById('site-footer');
  footer.className = 'site-footer';
  footer.innerHTML = `
    <div class="inner">
      <div class="footer-row">
        <a class="brand" href="${siteUrl('')}"><span class="brand-mark">R</span>Rupevo</a>
        <span class="muted small">Market rankings and tax tools, explained.</span>
        <span class="spacer"></span>
        <button class="btn coffee-btn" id="coffee-btn" type="button">☕ Buy me a coffee</button>
      </div>
      <p class="disclaimer">${DISCLAIMER}</p>
      <div class="footer-links">
        <span>Prices &amp; fundamentals: Yahoo Finance (end-of-day). Index lists: NSE India, Nasdaq.
          Not affiliated with any exchange, data provider, broker or employer.</span>
        <a data-contact data-contact-subject="Rupevo" data-contact-label="Contact"></a>
        <a href="https://github.com/${esc(SITE.repo.owner)}/${esc(SITE.repo.name)}" target="_blank" rel="noopener">Source on GitHub</a>
        <button class="linkish" id="admin-link" type="button">Admin</button>
        <span>© ${SITE.year} Rupevo</span>
      </div>
    </div>`;
  footer.querySelector('#coffee-btn').addEventListener('click', openCoffee);
  footer.querySelector('#admin-link').addEventListener('click',
    () => openAdminPanel({ onRefreshed: onAdminRefreshed }));
  fillContactLinks();
}

/** Turn every `<a data-contact>` into a mailto link to the maintainer. */
export function fillContactLinks(root = document) {
  root.querySelectorAll('a[data-contact]').forEach((a) => {
    a.href = mailtoHref(a.dataset.contactSubject || 'Rupevo');
    a.textContent = a.dataset.contactLabel || contactAddress();
  });
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
