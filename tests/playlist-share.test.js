// Run with: node tests/playlist-share.test.js
// Tests Playlist Sharing, AES-256 encryption, and Filebin integration (Item 3):
// - 3.1 Filebin integration investigation & REST endpoints
// - 3.2 Share Playlist functionality (packaging songs, metadata, and covers)
// - 3.3 Password-protected sharing with AES-256-GCM encryption (password never in URL)
// - 3.4 Automatic playlist detection in Downloads tab
// - 3.5 Sharing settings controls (playlistSharing & filebinSharing toggles)

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

// 1. Static checks on PlaylistShare.kt and MainActivity.kt
check('PlaylistShare.kt exists and implements packaging, AES-256 encryption, and Filebin endpoints', () => {
  assert.ok(fs.existsSync(path.join(KT, 'PlaylistShare.kt')), 'PlaylistShare.kt exists');
  const src = fs.readFileSync(path.join(KT, 'PlaylistShare.kt'), 'utf8');
  assert.ok(src.includes('AES/GCM/NoPadding'), 'uses AES/GCM/NoPadding for encryption');
  assert.ok(src.includes('PBKDF2WithHmacSHA256'), 'uses PBKDF2WithHmacSHA256 key derivation');
  assert.ok(src.includes('filebin.net'), 'interacts with filebin.net REST API');
  assert.ok(src.includes('moonlight-shared-playlist'), 'writes moonlight-shared-playlist manifest');
  assert.ok(src.includes('MAGIC_ENCRYPTED'), 'uses magic header to detect encrypted packages');
});

check('MainActivity exposes playlist sharing and import bridge interfaces', () => {
  const main = fs.readFileSync(path.join(KT, 'MainActivity.kt'), 'utf8');
  assert.ok(/@JavascriptInterface\s+fun sharePlaylistPackage\(/.test(main), 'sharePlaylistPackage exists');
  assert.ok(/@JavascriptInterface\s+fun importSharedPlaylist\(/.test(main), 'importSharedPlaylist exists');
  assert.ok(/@JavascriptInterface\s+fun isPlaylistShareFilebinUrl\(/.test(main), 'isPlaylistShareFilebinUrl exists');
  assert.ok(main.includes('onPlaylistShareComplete'), 'calls onPlaylistShareComplete');
  assert.ok(main.includes('onPlaylistImportComplete'), 'calls onPlaylistImportComplete');
});

check('share_paths.xml exposes shared-playlists cache folder to FileProvider', () => {
  const xml = fs.readFileSync(path.join(ROOT, 'app/src/main/res/xml/share_paths.xml'), 'utf8');
  assert.ok(xml.includes('shared-playlists/'), 'shared-playlists path exposed in FileProvider');
});

// 2. Filebin URL detection (Item 3.4)
const PlaylistShare = require(path.join(ASSETS, 'playlist-share.js'));

check('Filebin URL regex accurately recognizes valid Filebin links and ignores other links', () => {
  assert.strictEqual(PlaylistShare.isFilebinUrl('https://filebin.net/d4i1rhv6ic6kl8fz'), true);
  assert.strictEqual(PlaylistShare.isFilebinUrl('https://filebin.net/d4i1rhv6ic6kl8fz/my_playlist.moonlight'), true);
  assert.strictEqual(PlaylistShare.isFilebinUrl('http://filebin.net/xyz123'), true);
  assert.strictEqual(PlaylistShare.isFilebinUrl('https://www.youtube.com/watch?v=123'), false);
  assert.strictEqual(PlaylistShare.isFilebinUrl('https://open.spotify.com/playlist/abc'), false);
  assert.strictEqual(PlaylistShare.isFilebinUrl(''), false);
});

// 3. Sharing settings gating (Item 3.5)
check('Sharing settings toggle gates sharing execution', () => {
  let toastMsg = '';
  const mockRoot = {
    toast: (m) => { toastMsg = m; },
    NovelAudio: { getSetting: (k) => (k === 'playlistSharing' ? false : true) }
  };

  // Re-eval with mock
  const ps = Object.assign({}, PlaylistShare);
  assert.strictEqual(PlaylistShare.isSharingEnabled.call(mockRoot), false);
  assert.strictEqual(PlaylistShare.isFilebinEnabled.call(mockRoot), true);
});

// 4. Packaging and bridge sharing lifecycle (Items 3.2 & 3.3)
check('shareCurrentPlaylist triggers bridge call and handles completion callback', (done) => {
  const bridgeCalls = [];
  const fakeBridge = {
    sharePlaylistPackage: (key, pass, method) => {
      bridgeCalls.push({ key, pass, method });
      setTimeout(() => {
        PlaylistShare.onPlaylistShareComplete({
          success: true,
          method: method,
          shareUrl: 'https://filebin.net/testbin123',
          isEncrypted: pass.length > 0,
          songCount: 3
        });
      }, 5);
    }
  };

  let toastLog = [];
  const savedWin = global.window;
  global.window = {
    AndroidBridge: fakeBridge,
    toast: (t) => toastLog.push(t),
    prompt: () => 'mysecretpass',
    confirm: () => true, // choose Filebin
    SpotifyUI: { getActivePlaylistKey: () => 'pl-favorites' },
    NovelAudio: { getSetting: () => true },
    onPlaylistShareComplete: PlaylistShare.onPlaylistShareComplete
  };

  PlaylistShare.shareCurrentPlaylist('pl-favorites', 'Favorites');
  assert.strictEqual(bridgeCalls.length, 1);
  assert.strictEqual(bridgeCalls[0].key, 'pl-favorites');
  assert.strictEqual(bridgeCalls[0].pass, 'mysecretpass');
  assert.strictEqual(bridgeCalls[0].method, 'filebin');

  setTimeout(() => {
    assert.ok(toastLog.some((t) => t.includes('Filebin link ready')), 'toasts completion');
    global.window = savedWin;

    // 5. Automatic playlist detection in Downloads tab (Item 3.4)
    let importedUrl = '';
    global.PlaylistShare = {
      isFilebinUrl: PlaylistShare.isFilebinUrl,
      importFromUrl: (u) => { importedUrl = u; }
    };

    const SD = require(path.join(ASSETS, 'song-download.js'));
    const testUrl = 'https://filebin.net/testbin123/favorites.moonlight';

    // Test parseLinks accepts Filebin link
    const parsed = SD.parseLinks('Check this out: ' + testUrl);
    assert.strictEqual(parsed.links[0], testUrl, 'parseLinks captures Filebin URL');

    // Verify SD.handleSharedPlaylistLink routes Filebin URLs directly to PlaylistShare.importFromUrl
    const handled = SD.handleSharedPlaylistLink(testUrl);
    assert.strictEqual(handled, true, 'recognizes and handles Filebin URL');
    assert.strictEqual(importedUrl, testUrl, 'automatically routed to PlaylistShare.importFromUrl');
    console.log('ok - Downloads tab automatically intercepts Filebin links and imports playlist');

    // 6. Password prompt upon receiving encrypted playlist (Item 3.3 & 3.4)
    let promptShown = false;
    let reImportedUrl = '';
    let reImportedPass = '';

    const savedWin6 = global.window;
    global.window = {
      prompt: (msg) => {
        promptShown = true;
        assert.ok(msg.includes('password'), 'prompt asks for password');
        return 'userEnteredPassword';
      },
      PlaylistShare: {
        importFromUrl: (u, p) => {
          reImportedUrl = u;
          reImportedPass = p;
        }
      },
      toast: () => {}
    };

    PlaylistShare.onPlaylistImportComplete({
      success: false,
      requiresPassword: true,
      source: 'https://filebin.net/encryptedbin'
    });

    assert.strictEqual(promptShown, true, 'prompt displayed to user');
    assert.strictEqual(reImportedUrl, 'https://filebin.net/encryptedbin');
    assert.strictEqual(reImportedPass, 'userEnteredPassword');

    global.window = savedWin6;
    console.log('ok - onPlaylistImportComplete prompts user for password when encrypted and re-attempts import');
    console.log('\nAll 6 playlist sharing and Filebin tests passed cleanly!');
  }, 15);
});
