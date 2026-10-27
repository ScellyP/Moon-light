/* =========================================================================
   Moonlight — the glue that makes the music panel the whole app.

   In the reader app, reader.js opened and closed the music panel and called NovelAudio.init().
   Here the panel is simply always open, so this file only does what reader.js did for it:
     - NovelAudio.init() / onPanelOpened()
     - the system-bar insets (window.onStatusBarInset / onNavBarInset)
     - swiping sideways between Home / Songs / Now playing / Download
     - window.handleBack (MainActivity asks it before leaving the app)
     - the in-app message dialog (replaces alert()) and window.onFolderPickError
   ========================================================================= */
(function () {
  'use strict';

  var panel = document.getElementById('audio-panel');
  if (!panel) return;

  /* ---- insets ---- */
  window.onStatusBarInset = function (px) {
    var value = typeof px === 'number' && px >= 0 ? px : 0;
    document.documentElement.style.setProperty('--status-bar-height', value + 'px');
  };
  window.onNavBarInset = function (px) {
    var value = typeof px === 'number' && px >= 0 ? px : 0;
    document.documentElement.style.setProperty('--nav-bar-height', value + 'px');
  };

  /* ---- message dialog ---- */
  var dialogLayer = document.getElementById('dialog-layer');
  var dialogMessage = document.getElementById('dialog-message');
  var dialogOk = document.getElementById('dialog-ok');
  var dialogQueue = [];
  var dialogOpen = false;

  function showNextDialog() {
    if (dialogOpen || dialogQueue.length === 0) return;
    dialogOpen = true;
    dialogMessage.textContent = dialogQueue.shift();
    dialogLayer.classList.remove('hidden');
    dialogOk.focus({ preventScroll: true });
  }
  function closeDialog() {
    dialogLayer.classList.add('hidden');
    dialogOpen = false;
    showNextDialog();
  }
  function showMessage(text) {
    dialogQueue.push(String(text));
    showNextDialog();
  }
  dialogOk.addEventListener('click', closeDialog);
  dialogLayer.addEventListener('click', function (e) { if (e.target === dialogLayer) closeDialog(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && dialogOpen) closeDialog(); });
  window.alert = showMessage;
  // MainActivity.notifyError() calls this (storage access missing, scan failed ...).
  window.onFolderPickError = function (message) { showMessage(message); };

  /* ---- swipe sideways between the four tabs ----
     Only a mostly-sideways, far and quick move counts, so scrolling the lists, dragging the
     sliders and tapping are unaffected. (Same rules as in the reader app.) */
  var MIN_DX = 70, MAX_MS = 800;
  var sx = 0, sy = 0, st = 0, tracking = false;
  function ownsHorizontalDrag(target) {
    for (var el = target; el && el !== panel; el = el.parentElement) {
      if (el.matches && el.matches('input, textarea, select, #sp-sheet, #audio-playlist-btn')) return true;
      if (el.scrollWidth > el.clientWidth + 1) {
        var ox = getComputedStyle(el).overflowX;
        if (ox === 'auto' || ox === 'scroll') return true;
      }
    }
    return false;
  }
  panel.addEventListener('touchstart', function (e) {
    tracking = e.touches.length === 1 && !ownsHorizontalDrag(e.target);
    if (!tracking) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now();
  }, { passive: true });
  panel.addEventListener('touchmove', function (e) { if (e.touches.length !== 1) tracking = false; }, { passive: true });
  panel.addEventListener('touchend', function (e) {
    if (!tracking) return;
    tracking = false;
    var t = e.changedTouches[0];
    var dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) >= MIN_DX && Math.abs(dy) <= Math.abs(dx) * 0.6 && Date.now() - st <= MAX_MS) {
      if (window.SpotifyUI && window.SpotifyUI.stepView) window.SpotifyUI.stepView(dx < 0 ? 1 : -1);
    }
  }, { passive: true });
  panel.addEventListener('touchcancel', function () { tracking = false; }, { passive: true });

  /* ---- Back: closes the top-most thing, then returns to Home; false = nothing left, so the app
     asks for a second back press before it exits. ---- */
  window.handleBack = function () {
    if (dialogOpen) { closeDialog(); return true; }
    var sheet = document.getElementById('sp-sheet');
    if (sheet && !sheet.classList.contains('hidden')) {
      var close = document.getElementById('sp-sheet-close');
      if (close) close.click();
      return true;
    }
    if (panel.getAttribute('data-view') !== 'library' && window.SpotifyUI && window.SpotifyUI.setView) {
      window.SpotifyUI.setView('library');
      return true;
    }
    return false;
  };

  /* ---- start ---- */
  if (window.NovelAudio && window.NovelAudio.init) window.NovelAudio.init();
  if (window.NovelAudio && window.NovelAudio.onPanelOpened) window.NovelAudio.onPanelOpened();
})();
