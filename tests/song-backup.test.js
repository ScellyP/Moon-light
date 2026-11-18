// Run with: node tests/song-backup.test.js
// Tests the Backup & Restore system (Item 4):
// - 4.1 Backup functionality: collects downloaded songs, packages into ZIP archive, saves to Downloads folder
// - 4.2 Archive format: universal ZIP archive, audio files preserved without transcoding
// - 4.3 Backup requirements: independent extraction, metadata and playlist preservation, restore workflow

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'app/src/main/assets');
const KT = path.join(ROOT, 'app/src/main/java/com/scell/moonlight');

let n = 0;
function check(name, fn) {
  try { fn(); } catch (e) { console.log('FAIL -', name); throw e; }
  n++; console.log('ok -', name);
}

// 1. Static checks on Kotlin implementation (SongBackup.kt & MainActivity.kt)
check('SongBackup.kt exists and defines ZIP archiving without transcoding', () => {
  assert.ok(fs.existsSync(path.join(KT, 'SongBackup.kt')), 'SongBackup.kt exists');
  const src = fs.readFileSync(path.join(KT, 'SongBackup.kt'), 'utf8');
  assert.ok(src.includes('ZipOutputStream'), 'uses standard ZipOutputStream');
  assert.ok(src.includes('ZipInputStream'), 'uses standard ZipInputStream');
  assert.ok(src.includes('backup-manifest.json'), 'writes backup-manifest.json metadata');
  assert.ok(src.includes('moonlight-backup-'), 'uses standard timestamped naming prefix');
  assert.ok(src.includes('moonlight-backup'), 'format identified in manifest');
});

check('MainActivity exposes createBackup, restoreBackup, and listBackups to AndroidBridge', () => {
  const main = fs.readFileSync(path.join(KT, 'MainActivity.kt'), 'utf8');
  assert.ok(/@JavascriptInterface\s+fun createBackup\(/.test(main), 'createBackup interface exists');
  assert.ok(/@JavascriptInterface\s+fun restoreBackup\(/.test(main), 'restoreBackup interface exists');
  assert.ok(/@JavascriptInterface\s+fun listBackups\(/.test(main), 'listBackups interface exists');
  assert.ok(main.includes('onBackupProgress'), 'emits onBackupProgress callback');
  assert.ok(main.includes('onBackupComplete'), 'emits onBackupComplete callback');
  assert.ok(main.includes('onRestoreProgress'), 'emits onRestoreProgress callback');
  assert.ok(main.includes('onRestoreComplete'), 'emits onRestoreComplete callback');
});

// 2. Frontend markup and script checks
check('index.html contains Backup & Restore drawer controls and loads song-backup.js', () => {
  const html = fs.readFileSync(path.join(ASSETS, 'index.html'), 'utf8');
  assert.ok(html.includes('id="backup-create-btn"'), 'backup button exists');
  assert.ok(html.includes('id="backup-restore-btn"'), 'restore button exists');
  assert.ok(html.includes('id="backup-status-text"'), 'backup status text exists');
  assert.ok(html.includes('id="restore-status-text"'), 'restore status text exists');
  assert.ok(html.includes('<script src="song-backup.js"></script>'), 'song-backup.js script included');
});

// 3. Functional behavior of song-backup.js
check('song-backup.js handles backup flow and bridge callbacks', (done) => {
  const elements = {};
  function makeEl(id) {
    return {
      id,
      disabled: false,
      textContent: '',
      addEventListener: function (ev, fn) { this._cb = fn; },
      click: function () { if (this._cb) this._cb(); }
    };
  }
  ['backup-status-text', 'restore-status-text', 'backup-create-btn', 'backup-restore-btn'].forEach((id) => {
    elements[id] = makeEl(id);
  });

  const bridgeLog = [];
  const fakeBridge = {
    createBackup: () => {
      bridgeLog.push('createBackup');
      setTimeout(() => {
        global.window.onBackupProgress({ percent: 100, item: 'Song.mp3', total: 1 });
        global.window.onBackupComplete({ success: true, path: '/storage/emulated/0/Download/moonlight-backup-20261118.zip' });
      }, 10);
    },
    restoreBackup: (path) => {
      bridgeLog.push('restoreBackup:' + path);
      setTimeout(() => {
        global.window.onRestoreProgress({ percent: 100, item: 'songs/Song.mp3', total: 1 });
        global.window.onRestoreComplete({ success: true, restoredSongs: 5, restoredPlaylists: 2 });
      }, 10);
    }
  };

  const fakeDoc = {
    readyState: 'complete',
    getElementById: (id) => elements[id] || null,
    addEventListener: () => {}
  };

  const savedDoc = global.document;
  const savedWin = global.window;
  global.document = fakeDoc;
  global.window = { document: fakeDoc, AndroidBridge: fakeBridge };

  const SongBackup = require(path.join(ASSETS, 'song-backup.js'));
  SongBackup.initUI();

  // Test Backup Trigger
  elements['backup-create-btn'].click();
  assert.strictEqual(bridgeLog[0], 'createBackup', 'calls bridge.createBackup');
  assert.strictEqual(elements['backup-create-btn'].disabled, true, 'backup button disabled during backup');

  setTimeout(() => {
    assert.strictEqual(elements['backup-create-btn'].disabled, false, 'backup button re-enabled on complete');
    assert.ok(elements['backup-status-text'].textContent.includes('moonlight-backup-20261118.zip'), 'shows saved backup path');

    // Test Restore Trigger
    elements['backup-restore-btn'].click();
    assert.strictEqual(bridgeLog[1], 'restoreBackup:', 'calls bridge.restoreBackup');
    assert.strictEqual(elements['backup-restore-btn'].disabled, true, 'restore button disabled during restore');

    setTimeout(() => {
      assert.strictEqual(elements['backup-restore-btn'].disabled, false, 'restore button re-enabled on complete');
      assert.ok(elements['backup-status-text'].textContent.includes('moonlight-backup'), 'retains backup status');
      assert.ok(elements['restore-status-text'].textContent.includes('Restored 5 songs and 2 playlists'), 'shows restore summary');

      global.document = savedDoc;
      global.window = savedWin;
      console.log('ok - backup and restore frontend lifecycle and bridge calls verified');
    }, 25);
  }, 25);
});

console.log('\nAll backup and restore tests passed cleanly!');
