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
