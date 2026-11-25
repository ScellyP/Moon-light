/* =========================================================================
   Moonlight — the glue that makes the music panel the whole app.

   In the reader app, reader.js opened and closed the music panel and called NovelAudio.init().
   Here the panel is simply always open, so this file only does what reader.js did for it:
     - NovelAudio.init() / onPanelOpened()
     - the system-bar insets (window.onStatusBarInset / onNavBarInset)
     - swiping sideways between Home / Songs / Now playing / Download (settings-menu.js adds the
       swipe-right-on-Home Settings drawer)
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
  // The on-screen keyboard's height (0 = hidden). Sheets that hold text boxes sit above it (--kb-height); while
  // it is up the system navigation bar is behind it, so html.kb-open also drops the space reserved for that bar.
  window.onImeInset = function (px) {
    var value = typeof px === 'number' && px > 0 ? px : 0;
    document.documentElement.style.setProperty('--kb-height', value + 'px');
    document.documentElement.classList.toggle('kb-open', value > 0);
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
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (dialogOpen) closeDialog();
      else if (window.NovelAudio && window.NovelAudio.isDuplicateDialogOpen && window.NovelAudio.isDuplicateDialogOpen()) {
        window.NovelAudio.closeDuplicateDialog();
      }
    }
  });
  window.alert = showMessage;
  // MainActivity.notifyError() calls this (storage access missing, scan failed ...).
  window.onFolderPickError = function (message) { showMessage(message); };

  /* ---- swipe sideways between the tabs ----
     The pages follow the finger. Let go past about a third of the width (or with a quick flick) and the page slides
     on to the next one; let go earlier and it slides back. Mostly-vertical moves are left to the lists, and so are
     sliders, text fields and sideways-scrolling rows (the Home drawer swipe at the first tab is not touched either). */
  var DRAG_START = 10;
  var drag = null;
  var dragRaf = 0;
  function cancelDragRaf() {
    if (dragRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(dragRaf);
    dragRaf = 0;
  }
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
    cancelDragRaf();
    drag = null;
    if (e.touches.length !== 1 || ownsHorizontalDrag(e.target)) return;
    drag = { x: e.touches[0].clientX, y: e.touches[0].clientY, lastX: e.touches[0].clientX, lastT: Date.now(), vx: 0, dx: 0, active: false };
  }, { passive: true });
  panel.addEventListener('touchmove', function (e) {
    if (!drag) return;
    var ui = window.SpotifyUI;
    if (e.touches.length !== 1 || !ui || !ui.dragView) { cancelDragRaf(); if (drag.active && ui && ui.releaseView) ui.releaseView(0, 0); drag = null; return; }
    var t = e.touches[0], dx = t.clientX - drag.x, dy = t.clientY - drag.y;
    if (!drag.active) {
      if (Math.abs(dy) > DRAG_START && Math.abs(dy) > Math.abs(dx)) { drag = null; return; }        // a scroll of the list
      if (Math.abs(dx) < DRAG_START || Math.abs(dx) < Math.abs(dy) * 1.2) return;                    // not clearly sideways yet
      if (!ui.dragView(dx)) { drag = null; return; }                                                  // no page that way
      drag.active = true;
      drag.dx = dx;
    } else {
      drag.dx = dx;
      if (!dragRaf && typeof requestAnimationFrame === 'function') {
        dragRaf = requestAnimationFrame(function () {
          dragRaf = 0;
          if (drag && drag.active && window.SpotifyUI && window.SpotifyUI.dragView) {
            window.SpotifyUI.dragView(drag.dx);
          }
        });
      } else if (typeof requestAnimationFrame !== 'function') {
        ui.dragView(dx);
      }
    }
    var now = Date.now();
    drag.vx = (t.clientX - drag.lastX) / Math.max(1, now - drag.lastT);
    drag.lastX = t.clientX; drag.lastT = now;
  }, { passive: true });
  panel.addEventListener('touchend', function (e) {
    cancelDragRaf();
    var d = drag; drag = null;
    if (!d || !d.active || !window.SpotifyUI || !window.SpotifyUI.releaseView) return;
    window.SpotifyUI.releaseView(e.changedTouches[0].clientX - d.x, d.vx);
  }, { passive: true });
  panel.addEventListener('touchcancel', function () {
    cancelDragRaf();
    var d = drag; drag = null;
    if (d && d.active && window.SpotifyUI && window.SpotifyUI.releaseView) window.SpotifyUI.releaseView(0, 0);   // slide back
  }, { passive: true });

  /* ---- Back: closes the top-most thing, then returns to Home; false = nothing left, so the app
     asks for a second back press before it exits. ---- */
  window.handleBack = function () {
    if (dialogOpen) { closeDialog(); return true; }
    if (window.NovelAudio && window.NovelAudio.isDuplicateDialogOpen && window.NovelAudio.isDuplicateDialogOpen()) {
      window.NovelAudio.closeDuplicateDialog();
      return true;
    }
    if (window.NovelAudio && window.NovelAudio.isBlacklistDialogOpen && window.NovelAudio.isBlacklistDialogOpen()) {
      window.NovelAudio.closeBlacklistDialog();
      return true;
    }
    // The song options sheet (the "..." menu, song-menu.js) is on top of everything it was opened from, so it goes first.
    if (window.SongDownload && window.SongDownload.closeCrop && window.SongDownload.closeCrop()) return true;
    if (window.NovelAudio && window.NovelAudio.isPlayingOrderOpen && window.NovelAudio.isPlayingOrderOpen()) { window.NovelAudio.closePlayingOrder(); return true; }
    if (window.PlaylistEditor && window.PlaylistEditor.isOpen()) { window.PlaylistEditor.close(); return true; }
    if (window.PlaylistPicker && window.PlaylistPicker.isOpen()) { window.PlaylistPicker.close(); return true; }
    if (window.SongMenu && window.SongMenu.isOpen()) { window.SongMenu.close(); return true; }
    if (window.SettingsMenu && window.SettingsMenu.isOpen()) { window.SettingsMenu.close(); return true; }
    var sheet = document.getElementById('sp-sheet');
    if (sheet && !sheet.classList.contains('hidden')) {
      var close = document.getElementById('sp-sheet-close');
      if (close) close.click();
      return true;
    }
    // A Search category / album / genre page: Back returns to the Search landing page first.
    if (panel.getAttribute('data-view') === 'search' && window.SongSearch && window.SongSearch.back && window.SongSearch.back()) return true;
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
