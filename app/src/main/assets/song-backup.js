/* Moonlight — Backup and restore (song-backup.js)
   Portable backup system (Item 4):
   - Packages downloaded songs, playlists, covers and metadata into a standard ZIP archive.
   - Preserves original audio files without transcoding or quality loss.
   - Saves backup to device's Downloads folder.
   - Provides restore capability with automatic library refresh on completion.
*/
(function (root) {
  'use strict';

  var backupStatusEl = null;
  var restoreStatusEl = null;
  var backupBtn = null;
  var restoreBtn = null;

  function initUI() {
    if (typeof document === 'undefined') return;
    backupStatusEl = document.getElementById('backup-status-text');
    restoreStatusEl = document.getElementById('restore-status-text');
    backupBtn = document.getElementById('backup-create-btn');
    restoreBtn = document.getElementById('backup-restore-btn');

    if (backupBtn && !backupBtn._backupBound) {
      backupBtn._backupBound = true;
      backupBtn.addEventListener('click', function () {
        startBackup();
      });
    }

    if (restoreBtn && !restoreBtn._restoreBound) {
      restoreBtn._restoreBound = true;
      restoreBtn.addEventListener('click', function () {
        startRestore();
      });
    }
  }

  function startBackup() {
    var b = root.AndroidBridge || (typeof window !== 'undefined' ? window.AndroidBridge : null);
    if (backupBtn) {
      backupBtn.disabled = true;
      backupBtn.textContent = 'Backing up...';
    }
    if (backupStatusEl) {
      backupStatusEl.textContent = 'Collecting songs and playlists...';
    }

    if (b && typeof b.createBackup === 'function') {
      try {
        b.createBackup();
      } catch (e) {
        onBackupComplete({ success: false, error: e.message || 'Bridge error' });
      }
    } else {
      // Browser / simulated environment fallback
      setTimeout(function () {
        onBackupProgress({ percent: 50, item: 'backup-manifest.json', total: 2 });
        setTimeout(function () {
          onBackupComplete({
            success: true,
            path: '/storage/emulated/0/Download/moonlight-backup-simulated.zip',
            songCount: 1,
            playlistCount: 1
          });
        }, 80);
      }, 40);
    }
  }

  function startRestore(filePath) {
    var b = root.AndroidBridge || (typeof window !== 'undefined' ? window.AndroidBridge : null);
    if (restoreBtn) {
      restoreBtn.disabled = true;
      restoreBtn.textContent = 'Restoring...';
    }
    if (restoreStatusEl) {
      restoreStatusEl.textContent = 'Restoring library from backup...';
    }

    if (b && typeof b.restoreBackup === 'function') {
      try {
        b.restoreBackup(filePath || '');
      } catch (e) {
        onRestoreComplete({ success: false, error: e.message || 'Bridge error' });
      }
    } else {
      // Browser / simulated environment fallback
      setTimeout(function () {
        onRestoreProgress({ percent: 50, item: 'songs/simulated.mp3', total: 2 });
        setTimeout(function () {
          onRestoreComplete({
            success: true,
            restoredSongs: 1,
            restoredPlaylists: 1
          });
        }, 80);
      }, 40);
    }
  }

  function onBackupProgress(data) {
    var p = typeof data === 'string' ? JSON.parse(data) : data;
    if (backupStatusEl) {
      backupStatusEl.textContent = 'Backing up: ' + (p.percent || 0) + '% (' + (p.item || '') + ')';
    }
  }

  function onBackupComplete(data) {
    var res = typeof data === 'string' ? JSON.parse(data) : data;
    if (backupBtn) {
      backupBtn.disabled = false;
      backupBtn.textContent = 'Backup';
    }
    if (backupStatusEl) {
      if (res.success) {
        var fileName = res.path ? res.path.replace(/^.*[\\\/]/, '') : 'archive';
        backupStatusEl.textContent = 'Saved to Downloads: ' + fileName;
      } else {
        backupStatusEl.textContent = 'Backup failed: ' + (res.error || 'Unknown error');
      }
    }
    if (typeof root.toast === 'function') {
      root.toast(res.success ? 'Backup saved to Downloads' : ('Backup failed: ' + res.error));
    }
  }

  function onRestoreProgress(data) {
    var p = typeof data === 'string' ? JSON.parse(data) : data;
    if (restoreStatusEl) {
      restoreStatusEl.textContent = 'Restoring: ' + (p.percent || 0) + '% (' + (p.item || '') + ')';
    }
  }

  function onRestoreComplete(data) {
    var res = typeof data === 'string' ? JSON.parse(data) : data;
    if (restoreBtn) {
      restoreBtn.disabled = false;
      restoreBtn.textContent = 'Restore';
    }
    if (restoreStatusEl) {
      if (res.success) {
        restoreStatusEl.textContent = 'Restored ' + (res.restoredSongs || 0) + ' songs and ' + (res.restoredPlaylists || 0) + ' playlists.';
      } else {
        restoreStatusEl.textContent = 'Restore failed: ' + (res.error || 'Unknown error');
      }
    }
    if (typeof root.toast === 'function') {
      root.toast(res.success ? 'Library restored from backup' : ('Restore failed: ' + res.error));
    }
  }

  var api = {
    startBackup: startBackup,
    startRestore: startRestore,
    onBackupProgress: onBackupProgress,
    onBackupComplete: onBackupComplete,
    onRestoreProgress: onRestoreProgress,
    onRestoreComplete: onRestoreComplete,
    initUI: initUI
  };

  if (typeof window !== 'undefined') {
    window.SongBackup = api;
    window.onBackupProgress = onBackupProgress;
    window.onBackupComplete = onBackupComplete;
    window.onRestoreProgress = onRestoreProgress;
    window.onRestoreComplete = onRestoreComplete;
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
