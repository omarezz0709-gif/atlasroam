/* runs before anything is drawn: light or dark (the saved choice, otherwise the device setting) and the page direction */
(function () {
  var d = document.documentElement, th = null, lg = null;
  try { th = localStorage.getItem('ar-theme'); lg = localStorage.getItem('ar-lang'); } catch (e) {}
  d.dataset.theme = th === 'light' || th === 'dark' ? th : (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  if (!lg) lg = (navigator.language || 'en').slice(0, 2);
  if (['en', 'de', 'fr', 'es', 'it', 'ar'].indexOf(lg) < 0) lg = 'en';
  d.lang = lg; d.dir = lg === 'ar' ? 'rtl' : 'ltr';
})();
