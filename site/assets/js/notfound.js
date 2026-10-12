// The page for any missing address: the site search and the main sections.
import { icon } from './icons.js';
import { attachSearch } from './search.js';
import { renderShell } from './shell.js';

renderShell('', { showCurrency: false });
document.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
attachSearch(document.getElementById('home-search'));
