/* Runs before first paint (render-blocking in <head>) so there is no theme flash. */
(function () {
  var theme = null;
  try {
    theme = localStorage.getItem('sq-theme');
  } catch (e) {
    theme = null; // storage blocked (private mode) — fall back to system preference
  }
  if (theme !== 'light' && theme !== 'gray' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
