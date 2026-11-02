// Runs in <head> before paint so a pinned light/dark theme never flashes.
(function () {
  try {
    var t = localStorage.getItem('vg:theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage blocked: follow the system */ }
})();
