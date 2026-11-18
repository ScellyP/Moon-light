/* Moonlight — Playlist Sharing & Filebin integration (playlist-share.js)
   Item 3:
   - 3.1 Filebin integration: automated upload & link generation with 6-day expiration notice.
   - 3.2 Share Playlist: packages songs, playlist metadata, and cover into an archive.
   - 3.3 Password-protected sharing: AES-256 encryption, password never leaked in link.
   - 3.4 Automatic playlist detection in Downloads tab: detects Filebin links and imports.
   - 3.5 Sharing settings: gated by playlistSharing and filebinSharing toggles.
*/
(function (root) {
  'use strict';

  var FILEBIN_REGEX = /https?:\/\/filebin\.net\/([a-zA-Z0-9_-]+)(?:\/([^\s/?#]+))?/i;
  var lastImportSource = '';

  function isFilebinUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return FILEBIN_REGEX.test(url.trim());
  }

  function isSharingEnabled() {
    var a = (this && this.NovelAudio) || (typeof window !== 'undefined' ? window.NovelAudio : null) || (typeof global !== 'undefined' ? global.NovelAudio : null) || root.NovelAudio;
    if (a && typeof a.getSetting === 'function') {
      return a.getSetting('playlistSharing') !== false;
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
    var fn = (typeof window !== 'undefined' ? window.toast : null) || (typeof global !== 'undefined' ? global.toast : null) || root.toast;
    if (typeof fn === 'function') fn(msg);
  }

  function shareCurrentPlaylist(playlistKey, playlistName) {
    if (!isSharingEnabled()) {
      showToast('Playlist sharing is disabled in Settings');
      return;
    }

    var key = playlistKey || (root.SpotifyUI && root.SpotifyUI.getActivePlaylistKey ? root.SpotifyUI.getActivePlaylistKey() : '');
    if (!key) {
      showToast('No playlist selected to share');
      return;
    }

    // Ask user for optional password
    var promptFn = typeof window !== 'undefined' && window.prompt ? window.prompt : null;
    var password = '';
    if (promptFn) {
      var passInput = promptFn('Set a password for playlist "' + (playlistName || key) + '" (optional, leave blank for no password):', '');
      if (passInput === null) return; // User cancelled
      password = passInput.trim();
    }

    // Check if Filebin is preferred/available
    var method = 'direct';
    if (isFilebinEnabled()) {
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
    showToast(method === 'filebin' ? 'Packaging and uploading to Filebin...' : 'Packaging playlist files...');

    if (b && typeof b.sharePlaylistPackage === 'function') {
      try {
        b.sharePlaylistPackage(playlistKey, password || '', method || 'direct');
      } catch (e) {
        onPlaylistShareComplete({ success: false, error: e.message || 'Bridge error' });
      }
    } else {
      // Browser / test mock fallback
      setTimeout(function () {
        if (method === 'filebin') {
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
    showToast('Downloading and importing shared playlist...');

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
      if (res.method === 'filebin') {
        var msg = 'Filebin link ready! Note: Links expire in 6 days.';
        if (res.isEncrypted) msg += ' Password protection active.';
        showToast(msg);
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
        var key = root.SpotifyUI && root.SpotifyUI.getActivePlaylistKey ? root.SpotifyUI.getActivePlaylistKey() : '';
        shareCurrentPlaylist(key);
      });
    }
  }

  var api = {
    isFilebinUrl: isFilebinUrl,
    isSharingEnabled: isSharingEnabled,
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
