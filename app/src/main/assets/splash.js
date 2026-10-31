/* =========================================================================
   Moonlight — launch screen.

   index.html paints #ml-splash (the app icon on the app background) from the very first frame. This
   file lifts it once the page is built: every script has run (window "load", so Home is already
   rendered), the fonts are ready, and two animation frames have passed so the first real frame is on
   screen under the fade. It stays at least MIN_MS so the icon's entrance animation is not cut off, and
   never longer than MAX_MS, so it can never trap the user behind itself.
   ========================================================================= */
(function () {
  'use strict';

  var splash = document.getElementById('ml-splash');
  if (!splash) return;

  var MIN_MS = 500;   // long enough for the icon to finish appearing
  var MAX_MS = 2000;  // hard cap
  var FADE_MS = 350;  // a little over the CSS fade, then the element is removed from layout
  var started = Date.now();
  var finished = false;

  function finish() {
    if (finished) return;
    finished = true;
    splash.classList.add('leaving');
    setTimeout(function () { splash.classList.add('gone'); }, FADE_MS);
  }

  function noop() {}

  var loaded = new Promise(function (resolve) {
    if (document.readyState === 'complete') resolve();
    else window.addEventListener('load', function () { resolve(); }, { once: true });
  });
  var fonts = document.fonts && document.fonts.ready ? document.fonts.ready.then(noop, noop) : Promise.resolve();
  var frames = function () {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () { requestAnimationFrame(resolve); });
    });
  };

  Promise.all([loaded, fonts]).then(frames).then(function () {
    setTimeout(finish, Math.max(0, MIN_MS - (Date.now() - started)));
  }, finish);

  setTimeout(finish, MAX_MS);
})();
