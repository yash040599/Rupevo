// Page chrome shared by every page, app-style: a top app bar (brand, search, display toggles,
// "Buy me a coffee"), a navigation rail on wide screens that becomes a bottom navigation bar on
// phones, and a compact footer whose full disclaimer is one tap away.
import { SITE } from './config.js';
import { currency, esc, istDateTime, num, siteUrl, toggleTheme } from './core.js';
import { openAdminPanel } from './admin.js';
import { openCoffee } from './coffee.js';
import { icon } from './icons.js';
import { contactAddress, mailtoHref } from './mail.js';
import { attachSearch, openSearchView } from './search.js';

const NAV = [
  { key: 'home', label: 'Home', href: '', icon: 'home', title: 'Rupevo home' },
  { key: 'india', label: 'Nifty 100', href: 'india/', icon: 'india', title: 'Indian Nifty 100 Ranking' },
  { key: 'us', label: 'US stocks', href: 'us/', icon: 'us', title: 'US Stock Ranking: NASDAQ-100 and NYSE top 100' },
  { key: 'mf', label: 'Funds', href: 'mf/', icon: 'funds', title: 'Mutual Fund Comparison' },
  { key: 'tax', label: 'Tax', href: 'tax/', icon: 'tax', title: 'Tax tools: RSU taxation and more' },
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

const SOURCES = `Prices and fundamentals: Yahoo Finance (end of day). Index lists: NSE India, Nasdaq
  (NASDAQ-100; NYSE listings for the NYSE top 100). Mutual funds: AMFI (NAVs, returns, expense ratios,
  tracking error), mfapi.in (NAV history), NSE India (index P/E). Not affiliated with any exchange, data
  provider, fund house, broker or employer.`;

const searchForm = (cls, placeholder) => `<form class="search-field ${cls}" role="search" autocomplete="off">
    ${icon('search', { size: 20 })}<input type="search" placeholder="${placeholder}" aria-label="${placeholder}"
      enterkeyhint="search"></form>`;

export function renderShell(page, { showCurrency = true, onAdminRefreshed } = {}) {
  document.body.classList.add('has-nav');
  const bar = document.getElementById('site-nav');
  bar.className = 'appbar';
  bar.innerHTML = `
    <a class="brand" href="${siteUrl('')}" title="Rupevo home"><span class="brand-mark">R</span><span
      class="brand-text">Rupevo</span></a>
    ${searchForm('appbar-search', 'Search stocks, funds and tools')}
    <span class="appbar-spacer"></span>
    <button class="icon-btn search-open" type="button" aria-label="Search" title="Search">${icon('search')}</button>
    <span class="fx-badge" id="fx-badge" hidden></span>
    ${showCurrency ? `<button class="cur-toggle" id="cur-toggle" type="button"
        title="Show prices in rupees or dollars" aria-label="Display currency">
        <span class="cur-pill" data-cur="INR">₹</span><span class="cur-pill" data-cur="USD">$</span>
      </button>` : ''}
    <button class="icon-btn" id="theme-toggle" type="button" title="Switch light / dark theme"
      aria-label="Toggle colour theme"><span class="theme-sun">${icon('sun')}</span><span
      class="theme-moon">${icon('moon')}</span></button>
    <button class="btn coffee-btn nav-coffee" id="nav-coffee" type="button"
      title="Buy me a coffee — support Rupevo via UPI" aria-label="Buy me a coffee">${icon('coffee', { size: 20 })}<span
      class="nav-coffee-text">Buy me a coffee</span></button>`;

  bar.querySelector('#theme-toggle').addEventListener('click', toggleTheme);
  bar.querySelector('#nav-coffee').addEventListener('click', openCoffee);
  bar.querySelector('.search-open').addEventListener('click', openSearchView);
  attachSearch(bar.querySelector('.appbar-search'));
  bar.querySelector('#cur-toggle')?.addEventListener('click', () => {
    if (!currency.rate) return;
    currency.set(currency.display === 'INR' ? 'USD' : 'INR');
    syncCurrencyToggle();
  });
  // The app bar gets a hairline once the page scrolls under it.
  const onScroll = () => bar.classList.toggle('scrolled', window.scrollY > 4);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Navigation: a rail on wide screens, a bottom bar on phones (CSS decides which).
  const nav = document.createElement('nav');
  nav.className = 'navbar';
  nav.setAttribute('aria-label', 'Main');
  nav.innerHTML = NAV.map((item) => `<a class="nav-item" href="${siteUrl(item.href)}" title="${esc(item.title)}"${
    item.key === page ? ' aria-current="page"' : ''}><span class="nav-icon">${icon(item.icon)}</span><span
    class="nav-label">${esc(item.label)}</span></a>`).join('');
  bar.after(nav);

  const footer = document.getElementById('site-footer');
  footer.className = 'site-footer';
  footer.innerHTML = `
    <div class="inner">
      <p class="footer-note"><strong>For information and education only.</strong> Not investment, tax or legal
        advice. Rupevo is not registered with SEBI.</p>
      <details class="more footer-more"><summary>Full disclaimer and data sources</summary>
        <div class="more-body"><p class="disclaimer">${DISCLAIMER}</p><p class="disclaimer">${SOURCES}</p></div></details>
      <div class="footer-links">
        <a data-contact data-contact-subject="Rupevo" data-contact-label="Contact"></a>
        <a href="https://github.com/${esc(SITE.repo.owner)}/${esc(SITE.repo.name)}" target="_blank" rel="noopener">Source on GitHub</a>
        <button class="linkish" id="coffee-btn" type="button">Buy me a coffee</button>
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
