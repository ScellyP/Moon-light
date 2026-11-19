/* Moonlight — Playlist Sharing & AnonDrop Integration (playlist-share.js)
   - AnonDrop anonymous cloud integration: chunked upload & instant direct-download link (no login/accounts required).
   - Dedicated Moonlight custom dialogs for Share, Unlock (password), and Success (copy & share link) actions.
   - Streamed ZIP packaging of songs, playlist metadata, and covers.
   - Password-protected sharing with AES-256-GCM encryption (password never stored or sent in URLs).
   - Automatic shared playlist detection in Downloads tab: detects AnonDrop links and imports seamlessly.
   - Sharing settings: gated by playlistSharing and anonDropSharing toggles.
*/
(function (root) {
  'use strict';

  var ANONDROP_REGEX = /https?:\/\/(?:www\.)?anondrop\.net\/([a-zA-Z0-9]+)(?:\/([^\s/?#]+))?/i;
  var lastImportSource = '';
  var activeShareKey = '';
  var activeShareName = '';
  var activeUnlockSource = '';
  var activeShareUrl = '';

  function isAnonDropUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return ANONDROP_REGEX.test(url.trim());
  }

  function isRecognizedShareUrl(url) {
    return isAnonDropUrl(url);
  }

  function isSharingEnabled() {
    var a = (this && this.NovelAudio) || (typeof window !== 'undefined' ? window.NovelAudio : null) || (typeof global !== 'undefined' ? global.NovelAudio : null) || root.NovelAudio;
    if (a && typeof a.getSetting === 'function') {
      return a.getSetting('playlistSharing') !== false;
    }
    return true;
  }

  function isAnonDropEnabled() {
    var a = (this && this.NovelAudio) || (typeof window !== 'undefined' ? window.NovelAudio : null) || (typeof global !== 'undefined' ? global.NovelAudio : null) || root.NovelAudio;
    if (a && typeof a.getSetting === 'function') {
      return a.getSetting('anonDropSharing') !== false;
    }
    return true;
  }

  function showToast(msg) {
    var fn = (typeof window !== 'undefined' ? window.toast : null)
      || (typeof global !== 'undefined' ? global.toast : null)
      || (typeof window !== 'undefined' && window.SongMenu && window.SongMenu.toast ? window.SongMenu.toast : null)
      || (root.SongMenu && root.SongMenu.toast ? root.SongMenu.toast : null)
      || root.toast;
    if (typeof fn === 'function') fn(msg);
  }

  function getPlaylistKey() {
    var a = (typeof window !== 'undefined' ? window.NovelAudio : null) || (typeof global !== 'undefined' ? global.NovelAudio : null) || root.NovelAudio;
    var ui = (typeof window !== 'undefined' ? window.SpotifyUI : null) || (typeof global !== 'undefined' ? global.SpotifyUI : null) || root.SpotifyUI;
    if (a && typeof a.getActivePlaylistKey === 'function') {
      var k = a.getActivePlaylistKey();
      if (k) return k;
    }
    if (ui && typeof ui.getActivePlaylistKey === 'function') {
      var k2 = ui.getActivePlaylistKey();
      if (k2) return k2;
    }
    if (typeof document !== 'undefined') {
      var cover = document.getElementById('sp-album-cover');
      if (cover) {
        var pk = cover.getAttribute('data-pl-key');
        if (pk && pk !== 'all' && pk !== '@liked' && pk !== '@recent') {
          return pk.indexOf('name:') === 0 || pk.indexOf('list:') === 0 ? pk : 'name:' + pk;
        }
      }
    }
    return '';
  }

  function getPlaylistDisplayName() {
    var ui = (typeof window !== 'undefined' ? window.SpotifyUI : null) || (typeof global !== 'undefined' ? global.SpotifyUI : null) || root.SpotifyUI;
    if (ui && typeof ui.getPlaylistTitle === 'function') {
      var t = ui.getPlaylistTitle();
      if (t) return t;
    }
    if (typeof document !== 'undefined') {
      var titleEl = document.getElementById('sp-album-title');
      if (titleEl && titleEl.textContent) return titleEl.textContent.trim();
    }
    return '';
  }

  function isOpen() {
    if (typeof document === 'undefined') return false;
    var d1 = document.getElementById('share-dialog-layer');
    var d2 = document.getElementById('share-unlock-dialog-layer');
    var d3 = document.getElementById('share-success-dialog-layer');
    return (d1 && !d1.classList.contains('hidden')) ||
           (d2 && !d2.classList.contains('hidden')) ||
           (d3 && !d3.classList.contains('hidden'));
  }

  function close() {
    closeShareDialog();
    closeUnlockDialog(true);
    closeSuccessDialog();
  }

  /* ---- Share Dialog ---- */
  function openShareDialog(playlistKey, playlistName) {
    if (!isSharingEnabled()) {
      showToast('Playlist sharing is disabled in Settings');
      return;
    }

    var key = playlistKey || getPlaylistKey();
    if (!key || key === 'all' || key === '@liked' || key === '@recent') {
      showToast('No playlist selected to share');
      return;
    }

    var rawName = playlistName || getPlaylistDisplayName() || key;
    var cleanName = String(rawName).replace(/^(?:name:|list:)/, '').trim() || 'Playlist';
    activeShareKey = key;
    activeShareName = cleanName;

    if (typeof document !== 'undefined' && document.getElementById('share-dialog-layer')) {
      var count = 0;
      try {
        var sl = (typeof window !== 'undefined' ? window.SongLibrary : null)
          || (typeof global !== 'undefined' ? global.SongLibrary : null)
          || root.SongLibrary;
        if (sl && typeof sl.getPlaylistSongs === 'function') {
          var songs = sl.getPlaylistSongs(key);
          if (Array.isArray(songs)) count = songs.length;
        }
      } catch (_) {}

      var subText = cleanName;
      if (count > 0) subText += ' • ' + count + (count === 1 ? ' song' : ' songs');
      var subEl = document.getElementById('share-dialog-sub');
      if (subEl) subEl.textContent = subText;

      var passInput = document.getElementById('share-dialog-password');
      if (passInput) passInput.value = '';

      var anonAvailable = isAnonDropEnabled();
      var anonCard = document.getElementById('share-method-anondrop-card');
      var directCard = document.getElementById('share-method-direct-card');
      var anonRadio = document.getElementById('share-method-anondrop');
      var directRadio = document.getElementById('share-method-direct');

      if (!anonAvailable) {
        if (anonCard) anonCard.style.display = 'none';
        if (directRadio) directRadio.checked = true;
        if (directCard) directCard.classList.add('active');
        if (anonCard) anonCard.classList.remove('active');
      } else {
        if (anonCard) anonCard.style.display = '';
        if (anonRadio) anonRadio.checked = true;
        if (anonCard) anonCard.classList.add('active');
        if (directCard) directCard.classList.remove('active');
      }

      closeUnlockDialog(false);
      closeSuccessDialog();
      var layer = document.getElementById('share-dialog-layer');
      if (layer) {
        layer.classList.remove('hidden');
        if (passInput) {
          try { passInput.focus({ preventScroll: true }); } catch (_) {}
        }
      }
      return;
    }

    // Headless / browser fallback without custom DOM
    var promptFn = typeof window !== 'undefined' && window.prompt ? window.prompt : null;
    var password = '';
    if (promptFn) {
      var passInputVal = promptFn('Set a password for playlist "' + cleanName + '" (optional, leave blank for no password):', '');
      if (passInputVal === null) return;
      password = passInputVal.trim();
    }

    var method = 'direct';
    if (isAnonDropEnabled()) {
      var confirmFn = typeof window !== 'undefined' && window.confirm ? window.confirm : null;
      if (confirmFn) {
        var useCloud = confirmFn('Share via AnonDrop cloud link?\n(Click OK for AnonDrop anonymous cloud link, or Cancel to share file directly)');
        if (useCloud) method = 'anondrop';
      } else {
        method = 'anondrop';
      }
    }

    startShare(key, password, method);
  }

  function closeShareDialog() {
    if (typeof document === 'undefined') return;
    var layer = document.getElementById('share-dialog-layer');
    if (layer) layer.classList.add('hidden');
  }

  function submitShareDialog() {
    if (typeof document === 'undefined') return;
    var passInput = document.getElementById('share-dialog-password');
    var password = passInput ? passInput.value.trim() : '';
    var directRadio = document.getElementById('share-method-direct');
    var method = (directRadio && directRadio.checked) ? 'direct' : 'anondrop';
    var key = activeShareKey;
    closeShareDialog();
    startShare(key, password, method);
  }

  function shareCurrentPlaylist(playlistKey, playlistName) {
    openShareDialog(playlistKey, playlistName);
  }

  function startShare(playlistKey, password, method) {
    var b = root.AndroidBridge || (typeof window !== 'undefined' ? window.AndroidBridge : null);
    var toastMsg = method === 'anondrop'
      ? 'Packaging and uploading to AnonDrop (see notification for progress)...'
      : 'Packaging playlist files...';
    showToast(toastMsg);

    if (b && typeof b.sharePlaylistPackage === 'function') {
      try {
        b.sharePlaylistPackage(playlistKey, password || '', method || 'direct');
      } catch (e) {
        onPlaylistShareComplete({ success: false, error: e.message || 'Bridge error' });
      }
    } else {
      // Browser / test mock fallback
      setTimeout(function () {
        if (method === 'anondrop') {
          onPlaylistShareComplete({
            success: true,
            method: 'anondrop',
            shareUrl: 'https://anondrop.net/mockid123',
            playlistName: activeShareName || playlistKey,
            isEncrypted: !!password,
            songCount: 1
          });
        } else {
          onPlaylistShareComplete({
            success: true,
            method: 'direct',
            filePath: '/storage/emulated/0/Download/' + encodeURIComponent(playlistKey) + '.moonlight',
            playlistName: activeShareName || playlistKey,
            isEncrypted: !!password,
            songCount: 1
          });
        }
      }, 50);
    }
  }

  /* ---- Unlock Dialog (Password Entry) ---- */
  function openUnlockDialog(source) {
    activeUnlockSource = source || lastImportSource || '';

    if (typeof document !== 'undefined' && document.getElementById('share-unlock-dialog-layer')) {
      var passInput = document.getElementById('share-unlock-password');
      if (passInput) passInput.value = '';

      var subEl = document.getElementById('share-unlock-sub');
      if (subEl) {
        var srcLabel = activeUnlockSource;
        if (srcLabel.length > 32) {
          srcLabel = '...' + srcLabel.slice(-28);
        }
        subEl.textContent = srcLabel || 'Password required';
      }

      closeShareDialog();
      closeSuccessDialog();
      var layer = document.getElementById('share-unlock-dialog-layer');
      if (layer) {
        layer.classList.remove('hidden');
        if (passInput) {
          try { passInput.focus({ preventScroll: true }); } catch (_) {}
        }
      }
      return;
    }

    // Headless / fallback prompt
    var promptFn = typeof window !== 'undefined' && window.prompt ? window.prompt : null;
    if (promptFn) {
      var pass = promptFn('This shared playlist is encrypted. Enter password to unlock:', '');
      if (pass !== null && pass.trim().length > 0) {
        var ps = (typeof window !== 'undefined' ? window.PlaylistShare : null) || api;
        (ps && ps.importFromUrl ? ps.importFromUrl : importFromUrl)(activeUnlockSource, pass.trim());
        return;
      }
    }
    showToast('Playlist import cancelled: password required');
  }

  function closeUnlockDialog(cancelled) {
    if (typeof document === 'undefined') return;
    var layer = document.getElementById('share-unlock-dialog-layer');
    if (layer) layer.classList.add('hidden');
    if (cancelled) {
      showToast('Playlist import cancelled: password required');
    }
  }

  function submitUnlockDialog() {
    if (typeof document === 'undefined') return;
    var passInput = document.getElementById('share-unlock-password');
    var pass = passInput ? passInput.value.trim() : '';
    if (!pass) {
      showToast('Please enter a password');
      if (passInput) {
        try { passInput.focus({ preventScroll: true }); } catch (_) {}
      }
      return;
    }
    var source = activeUnlockSource;
    closeUnlockDialog(false);
    importFromUrl(source, pass);
  }

  /* ---- Success Dialog (AnonDrop Link Ready) ---- */
  function openSuccessDialog(shareUrl, playlistName) {
    activeShareUrl = shareUrl || '';
    if (playlistName) activeShareName = String(playlistName).replace(/^(?:name:|list:)/, '');

    // Copy to clipboard immediately
    var nav = (typeof window !== 'undefined' ? window.navigator : null)
      || (typeof navigator !== 'undefined' ? navigator : null);
    if (activeShareUrl && nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      nav.clipboard.writeText(activeShareUrl).catch(function () {});
    }

    if (typeof document !== 'undefined' && document.getElementById('share-success-dialog-layer')) {
      var urlBox = document.getElementById('share-success-url');
      if (urlBox) urlBox.textContent = activeShareUrl;

      var subEl = document.getElementById('share-success-sub');
      if (subEl) subEl.textContent = 'Link copied to clipboard';

      closeShareDialog();
      closeUnlockDialog(false);
      var layer = document.getElementById('share-success-dialog-layer');
      if (layer) layer.classList.remove('hidden');
      return;
    }

    // Headless / fallback
    showToast('AnonDrop link ready! Recipient can download without an account.');
    var promptFn = typeof window !== 'undefined' && window.prompt ? window.prompt : null;
    if (promptFn && activeShareUrl) {
      promptFn('AnonDrop Share Link (copy & send):', activeShareUrl);
    }
  }

  function closeSuccessDialog() {
    if (typeof document === 'undefined') return;
    var layer = document.getElementById('share-success-dialog-layer');
    if (layer) layer.classList.add('hidden');
  }

  function copySuccessLink() {
    if (!activeShareUrl) return;
    var copyBtn = document.getElementById('share-success-copy');
    var nav = (typeof window !== 'undefined' ? window.navigator : null)
      || (typeof navigator !== 'undefined' ? navigator : null);
    if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      nav.clipboard.writeText(activeShareUrl).then(function () {
        showToast('Share link copied to clipboard');
      }).catch(function () {
        showToast('Share link: ' + activeShareUrl);
      });
    } else {
      showToast('Share link: ' + activeShareUrl);
    }

    if (copyBtn) {
      copyBtn.textContent = 'Copied!';
      setTimeout(function () {
        if (copyBtn) copyBtn.textContent = 'Copy link';
      }, 1800);
    }
  }

  function shareSuccessLink() {
    if (!activeShareUrl) return;
    var b = root.AndroidBridge || (typeof window !== 'undefined' ? window.AndroidBridge : null);
    if (b && typeof b.shareText === 'function') {
      b.shareText(activeShareUrl);
      return;
    }
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      navigator.share({
        title: activeShareName || 'Shared playlist',
        url: activeShareUrl
      }).catch(function () {});
      return;
    }
    copySuccessLink();
  }

  function importFromUrl(url, password) {
    if (url) lastImportSource = url;
    var b = root.AndroidBridge || (typeof window !== 'undefined' ? window.AndroidBridge : null);
    showToast('Downloading and importing shared playlist (see notification for progress)...');

    if (b && typeof b.importSharedPlaylist === 'function') {
      try {
        b.importSharedPlaylist(url, password || '');
      } catch (e) {
        onPlaylistImportComplete({ success: false, error: e.message || 'Bridge error' });
      }
    } else {
      // Mock / fallback
      setTimeout(function () {
        onPlaylistImportComplete({
          success: true,
          playlistId: 'imported-test',
          playlistName: 'Imported Playlist',
          songCount: 2
        });
      }, 50);
    }
  }

  function onPlaylistShareComplete(data) {
    var res = typeof data === 'string' ? JSON.parse(data) : data;
    if (res.success) {
      if (res.method === 'anondrop') {
        openSuccessDialog(res.shareUrl, res.playlistName);
      } else {
        showToast('Playlist package ready to share!');
      }
    } else {
      showToast('Share failed: ' + (res.error || 'Unknown error'));
    }
  }

  function onPlaylistImportComplete(data) {
    var res = typeof data === 'string' ? JSON.parse(data) : data;
    if (res.requiresPassword) {
      openUnlockDialog(res.source || res.filePath || lastImportSource);
      return;
    }

    if (res.success) {
      var rawName = res.playlistName || 'Shared playlist';
      var cleanName = String(rawName).replace(/^(?:name:|list:)/, '');
      var count = res.songCount || 0;
      showToast('Imported "' + cleanName + '" with ' + count + ' songs!');
      if (root.SpotifyUI && typeof root.SpotifyUI.refreshPlaylists === 'function') {
        root.SpotifyUI.refreshPlaylists();
      }
    } else {
      showToast('Import failed: ' + (res.error || 'Unknown error'));
    }
  }

  function initUI() {
    if (typeof document === 'undefined') return;

    // Album header share button
    var shareBtn = document.getElementById('sp-album-share');
    if (shareBtn && !shareBtn._shareBound) {
      shareBtn._shareBound = true;
      shareBtn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var key = getPlaylistKey();
        var title = getPlaylistDisplayName();
        openShareDialog(key, title);
      });
    }

    // Share dialog controls
    var shareClose = document.getElementById('share-dialog-close');
    var shareCancel = document.getElementById('share-dialog-cancel');
    var shareSubmit = document.getElementById('share-dialog-submit');
    var shareLayer = document.getElementById('share-dialog-layer');
    var sharePass = document.getElementById('share-dialog-password');

    if (shareClose && !shareClose._bound) {
      shareClose._bound = true;
      shareClose.addEventListener('click', closeShareDialog);
    }
    if (shareCancel && !shareCancel._bound) {
      shareCancel._bound = true;
      shareCancel.addEventListener('click', closeShareDialog);
    }
    if (shareSubmit && !shareSubmit._bound) {
      shareSubmit._bound = true;
      shareSubmit.addEventListener('click', submitShareDialog);
    }
    if (shareLayer && !shareLayer._bound) {
      shareLayer._bound = true;
      shareLayer.addEventListener('click', function (e) {
        if (e.target === shareLayer) closeShareDialog();
      });
    }
    if (sharePass && !sharePass._bound) {
      sharePass._bound = true;
      sharePass.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          submitShareDialog();
        }
      });
    }

    // Method selection cards
    var anonCard = document.getElementById('share-method-anondrop-card');
    var directCard = document.getElementById('share-method-direct-card');
    var anonRadio = document.getElementById('share-method-anondrop');
    var directRadio = document.getElementById('share-method-direct');

    function syncMethodCards() {
      if (anonRadio && anonRadio.checked) {
        if (anonCard) anonCard.classList.add('active');
        if (directCard) directCard.classList.remove('active');
      } else if (directRadio && directRadio.checked) {
        if (directCard) directCard.classList.add('active');
        if (anonCard) anonCard.classList.remove('active');
      }
    }

    if (anonRadio && !anonRadio._bound) {
      anonRadio._bound = true;
      anonRadio.addEventListener('change', syncMethodCards);
    }
    if (directRadio && !directRadio._bound) {
      directRadio._bound = true;
      directRadio.addEventListener('change', syncMethodCards);
    }
    if (anonCard && !anonCard._bound) {
      anonCard._bound = true;
      anonCard.addEventListener('click', function () {
        if (anonRadio) { anonRadio.checked = true; syncMethodCards(); }
      });
    }
    if (directCard && !directCard._bound) {
      directCard._bound = true;
      directCard.addEventListener('click', function () {
        if (directRadio) { directRadio.checked = true; syncMethodCards(); }
      });
    }

    // Unlock dialog controls
    var unlockClose = document.getElementById('share-unlock-close');
    var unlockCancel = document.getElementById('share-unlock-cancel');
    var unlockSubmit = document.getElementById('share-unlock-submit');
    var unlockLayer = document.getElementById('share-unlock-dialog-layer');
    var unlockPass = document.getElementById('share-unlock-password');

    if (unlockClose && !unlockClose._bound) {
      unlockClose._bound = true;
      unlockClose.addEventListener('click', function () { closeUnlockDialog(true); });
    }
    if (unlockCancel && !unlockCancel._bound) {
      unlockCancel._bound = true;
      unlockCancel.addEventListener('click', function () { closeUnlockDialog(true); });
    }
    if (unlockSubmit && !unlockSubmit._bound) {
      unlockSubmit._bound = true;
      unlockSubmit.addEventListener('click', submitUnlockDialog);
    }
    if (unlockLayer && !unlockLayer._bound) {
      unlockLayer._bound = true;
      unlockLayer.addEventListener('click', function (e) {
        if (e.target === unlockLayer) closeUnlockDialog(true);
      });
    }
    if (unlockPass && !unlockPass._bound) {
      unlockPass._bound = true;
      unlockPass.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          submitUnlockDialog();
        }
      });
    }

    // Success dialog controls
    var successClose = document.getElementById('share-success-close');
    var successDone = document.getElementById('share-success-done');
    var successCopy = document.getElementById('share-success-copy');
    var successShare = document.getElementById('share-success-share');
    var successLayer = document.getElementById('share-success-dialog-layer');

    if (successClose && !successClose._bound) {
      successClose._bound = true;
      successClose.addEventListener('click', closeSuccessDialog);
    }
    if (successDone && !successDone._bound) {
      successDone._bound = true;
      successDone.addEventListener('click', closeSuccessDialog);
    }
    if (successCopy && !successCopy._bound) {
      successCopy._bound = true;
      successCopy.addEventListener('click', copySuccessLink);
    }
    if (successShare && !successShare._bound) {
      successShare._bound = true;
      successShare.addEventListener('click', shareSuccessLink);
    }
    if (successLayer && !successLayer._bound) {
      successLayer._bound = true;
      successLayer.addEventListener('click', function (e) {
        if (e.target === successLayer) closeSuccessDialog();
      });
    }
  }

  var api = {
    ANONDROP_REGEX: ANONDROP_REGEX,
    isAnonDropUrl: isAnonDropUrl,
    isRecognizedShareUrl: isRecognizedShareUrl,
    isSharingEnabled: isSharingEnabled,
    isAnonDropEnabled: isAnonDropEnabled,
    openShareDialog: openShareDialog,
    closeShareDialog: closeShareDialog,
    openUnlockDialog: openUnlockDialog,
    closeUnlockDialog: closeUnlockDialog,
    openSuccessDialog: openSuccessDialog,
    closeSuccessDialog: closeSuccessDialog,
    isOpen: isOpen,
    close: close,
    shareCurrentPlaylist: shareCurrentPlaylist,
    startShare: startShare,
    importFromUrl: importFromUrl,
    onPlaylistShareComplete: onPlaylistShareComplete,
    onPlaylistImportComplete: onPlaylistImportComplete,
    initUI: initUI
  };

  if (typeof window !== 'undefined') {
    window.PlaylistShare = api;
    window.onPlaylistShareComplete = onPlaylistShareComplete;
    window.onPlaylistImportComplete = onPlaylistImportComplete;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initUI);
    } else {
      initUI();
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : this);
