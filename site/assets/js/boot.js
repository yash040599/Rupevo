// Loaded synchronously in <head> so the saved theme applies before first
// paint (no flash of the light theme). Kept external for the CSP.
(function () {
  var theme = 'light';
  try {
    var saved = window.localStorage.getItem('rupevo-theme');
    if (saved === 'dark' || saved === 'light') {
      theme = saved;
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      theme = 'dark';
    }
  } catch (e) { /* storage disabled */ }
  document.documentElement.setAttribute('data-theme', theme);
})();

// If the page's script cannot start (a file that failed to load, or a network
// error), say so instead of leaving the loading placeholders on screen. Every
// page script draws the navigation first, so an empty one means it never ran.
window.addEventListener('error', function (event) {
  var fromScript = event instanceof ErrorEvent || (event.target && event.target.tagName === 'SCRIPT');
  var nav = document.getElementById('site-nav');
  var main = document.querySelector('main');
  if (!fromScript || !main || (nav && nav.firstChild) || document.getElementById('boot-error')) return;
  var box = document.createElement('div');
  box.id = 'boot-error';
  box.className = 'banner error';
  box.setAttribute('role', 'alert');
  box.appendChild(document.createTextNode('This page could not finish loading. '));
  var link = document.createElement('a');
  link.href = window.location.href;
  link.textContent = 'Reload the page';
  box.appendChild(link);
  main.insertBefore(box, main.firstChild);
}, true);
