/* Moonlight — Playlist Sharing & AnonDrop anonymous integration (playlist-share.js)
   - AnonDrop anonymous cloud integration: chunked upload & instant direct-download link (no login/accounts required).
   - Filebin fallback link detection and download for backward compatibility.
   - Share Playlist: packages songs, playlist metadata, and cover into an archive.
   - Password-protected sharing: AES-256 encryption, password never leaked in link.
   - Automatic playlist detection in Downloads tab: detects AnonDrop & Filebin links and imports.
   - Sharing settings: gated by playlistSharing and anonDropSharing toggles.
*/
(function (root) {
  'use strict';

  var ANONDROP_REGEX = /https?:\/\/(?:www\.)?anondrop\.net\/([a-zA-Z0-9]+)(?:\/([^\s/?#]+))?/i;
  var FILEBIN_REGEX = /https?:\/\/filebin\.net\/([a-zA-Z0-9_-]+)(?:\/([^\s/?#]+))?/i;
  var lastImportSource = '';

  function isAnonDropUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return ANONDROP_REGEX.test(url.trim());
  }

  function isFilebinUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return FILEBIN_REGEX.test(url.trim());
  }

  function isRecognizedShareUrl(url) {
    return isAnonDropUrl(url) || isFilebinUrl(url);
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

  function isFilebinEnabled() {
    var a = (this && this.NovelAudio) || (typeof window !== 'undefined' ? window.NovelAudio : null) || (typeof global !== 'undefined' ? global.NovelAudio : null) || root.NovelAudio;
    if (a && typeof a.getSetting === 'function') {
      return a.getSetting('filebinSharing') !== false;
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

  function shareCurrentPlaylist(playlistKey, playlistName) {
    if (!isSharingEnabled()) {
      showToast('Playlist sharing is disabled in Settings');
      return;
    }

    var key = playlistKey || getPlaylistKey();
    var name = playlistName || getPlaylistDisplayName() || key;
    if (!key || key === 'all' || key === '@liked' || key === '@recent') {
      showToast('No playlist selected to share');
      return;
    }

    // Ask user for optional password
    var promptFn = typeof window !== 'undefined' && window.prompt ? window.prompt : null;
    var password = '';
    if (promptFn) {
      var passInput = promptFn('Set a password for playlist "' + name + '" (optional, leave blank for no password):', '');
      if (passInput === null) return; // User cancelled
      password = passInput.trim();
    }

    // Check if cloud sharing is preferred/available (AnonDrop primary, Filebin fallback)
    var method = 'direct';
    if (isAnonDropEnabled()) {
      var confirmFn = typeof window !== 'undefined' && window.confirm ? window.confirm : null;
      if (confirmFn) {
        var useCloud = confirmFn('Share via AnonDrop cloud link?\n(Click OK for AnonDrop anonymous cloud link, or Cancel to share file directly)');
        if (useCloud) method = 'anondrop';
      } else {
        method = 'anondrop';
      }
    } else if (isFilebinEnabled()) {
      var confirmFn = typeof window !== 'undefined' && window.confirm ? window.confirm : null;
      if (confirmFn) {
        var useFilebin = confirmFn('Share via Filebin cloud link?\n(Click OK for Filebin link [expires in 6 days], or Cancel to share file directly)');
        if (useFilebin) method = 'filebin';
      }
    }

    startShare(key, password, method);
  }

  function startShare(playlistKey, password, method) {
    var b = root.AndroidBridge || (typeof window !== 'undefined' ? window.AndroidBridge : null);
    var toastMsg = 'Packaging playlist files...';
    if (method === 'anondrop') {
      toastMsg = 'Packaging and uploading to AnonDrop (see notification for progress)...';
    } else if (method === 'filebin') {
      toastMsg = 'Packaging and uploading to Filebin (see notification for progress)...';
    }
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
            isEncrypted: !!password,
            songCount: 1
          });
        } else if (method === 'filebin') {
          onPlaylistShareComplete({
            success: true,
            method: 'filebin',
            shareUrl: 'https://filebin.net/mockbin123/' + encodeURIComponent(playlistKey) + '.moonlight',
            isEncrypted: !!password,
            songCount: 1
          });
        } else {
          onPlaylistShareComplete({
            success: true,
            method: 'direct',
            filePath: '/storage/emulated/0/Download/' + encodeURIComponent(playlistKey) + '.moonlight',
            isEncrypted: !!password,
            songCount: 1
          });
        }
      }, 50);
    }
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
        var msg = 'AnonDrop link ready! Recipient can download without an account.';
        if (res.isEncrypted) msg += ' Password protection active.';
        showToast(msg);
        var promptFn = typeof window !== 'undefined' && window.prompt ? window.prompt : null;
        if (promptFn && res.shareUrl) {
          promptFn('AnonDrop Share Link (copy & send):', res.shareUrl);
        }
      } else if (res.method === 'filebin') {
        var msg = 'Filebin link ready! Note: Links expire in 6 days.';
        if (res.isEncrypted) msg += ' Password protection active.';
        showToast(msg);
        var promptFn = typeof window !== 'undefined' && window.prompt ? window.prompt : null;
        if (promptFn && res.shareUrl) {
          promptFn('Filebin Share Link (copy & send):', res.shareUrl);
        }
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
      var promptFn = typeof window !== 'undefined' && window.prompt ? window.prompt : null;
      if (promptFn) {
        var pass = promptFn('This shared playlist is encrypted. Enter password to unlock:', '');
        if (pass !== null && pass.trim().length > 0) {
          var source = res.source || res.filePath || lastImportSource || '';
          var ps = (typeof window !== 'undefined' ? window.PlaylistShare : null) || api;
          (ps && ps.importFromUrl ? ps.importFromUrl : importFromUrl)(source, pass.trim());
          return;
        }
      }
      showToast('Playlist import cancelled: password required');
      return;
    }

    if (res.success) {
      var name = res.playlistName || 'Shared playlist';
      var count = res.songCount || 0;
      showToast('Imported "' + name + '" with ' + count + ' songs!');
      if (root.SpotifyUI && typeof root.SpotifyUI.refreshPlaylists === 'function') {
        root.SpotifyUI.refreshPlaylists();
      }
    } else {
      showToast('Import failed: ' + (res.error || 'Unknown error'));
    }
  }

  function initUI() {
    if (typeof document === 'undefined') return;
    var shareBtn = document.getElementById('sp-album-share');
    if (shareBtn && !shareBtn._shareBound) {
      shareBtn._shareBound = true;
      shareBtn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var key = getPlaylistKey();
        var title = getPlaylistDisplayName();
        shareCurrentPlaylist(key, title);
      });
    }
  }

  var api = {
    ANONDROP_REGEX: ANONDROP_REGEX,
    FILEBIN_REGEX: FILEBIN_REGEX,
    isAnonDropUrl: isAnonDropUrl,
    isFilebinUrl: isFilebinUrl,
    isRecognizedShareUrl: isRecognizedShareUrl,
    isSharingEnabled: isSharingEnabled,
    isAnonDropEnabled: isAnonDropEnabled,
    isFilebinEnabled: isFilebinEnabled,
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
