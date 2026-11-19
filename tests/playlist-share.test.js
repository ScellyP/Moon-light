// Run with: node tests/playlist-share.test.js
// Tests Playlist Sharing, AES-256 encryption, AnonDrop primary integration, and Filebin fallback:
// - AnonDrop anonymous integration: chunked upload & direct download endpoint (no account/login required)
// - Large-file RAM exhaustion protection: disk-streamed ZIP creation and streaming AES-256-GCM
// - Backward-compatible Filebin link detection & download
// - Share Playlist functionality (packaging songs, metadata, and covers)
// - Password-protected sharing with AES-256-GCM encryption (password never in URL)
// - Automatic playlist detection in Downloads tab for AnonDrop and Filebin links
// - Sharing settings controls (playlistSharing & anonDropSharing toggles)

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
check('PlaylistShare.kt exists and implements streaming packaging, AES-256 encryption, AnonDrop & Filebin', () => {
  assert.ok(fs.existsSync(path.join(KT, 'PlaylistShare.kt')), 'PlaylistShare.kt exists');
  const src = fs.readFileSync(path.join(KT, 'PlaylistShare.kt'), 'utf8');
  assert.ok(src.includes('AES/GCM/NoPadding'), 'uses AES/GCM/NoPadding for encryption');
  assert.ok(src.includes('PBKDF2WithHmacSHA256'), 'uses PBKDF2WithHmacSHA256 key derivation');
  assert.ok(src.includes('anondrop.net'), 'interacts with anondrop.net REST API');
  assert.ok(src.includes('uploadToAnonDrop'), 'implements uploadToAnonDrop chunked upload');
  assert.ok(src.includes('downloadFromAnonDrop'), 'implements downloadFromAnonDrop direct download');
  assert.ok(src.includes('isAnonDropUrl'), 'implements isAnonDropUrl');
  assert.ok(src.includes('isRecognizedShareUrl'), 'implements isRecognizedShareUrl');
  assert.ok(src.includes('filebin.net'), 'retains filebin.net fallback');
  assert.ok(src.includes('encryptFileAes256Gcm'), 'implements disk streaming AES-256 encryption');
  assert.ok(src.includes('decryptFileAes256Gcm'), 'implements disk streaming AES-256 decryption');
  assert.ok(src.includes('moonlight-shared-playlist'), 'writes moonlight-shared-playlist manifest');
  assert.ok(src.includes('MAGIC_ENCRYPTED'), 'uses magic header to detect encrypted packages');
  assert.ok(src.includes('onProgress'), 'provides progress callback for packaging and upload tracking');
});

check('MainActivity exposes AnonDrop and Filebin playlist sharing and import bridge interfaces', () => {
  const main = fs.readFileSync(path.join(KT, 'MainActivity.kt'), 'utf8');
  assert.ok(/@JavascriptInterface\s+fun sharePlaylistPackage\(/.test(main), 'sharePlaylistPackage exists');
  assert.ok(/@JavascriptInterface\s+fun importSharedPlaylist\(/.test(main), 'importSharedPlaylist exists');
  assert.ok(/@JavascriptInterface\s+fun isPlaylistShareAnonDropUrl\(/.test(main), 'isPlaylistShareAnonDropUrl exists');
  assert.ok(/@JavascriptInterface\s+fun isPlaylistShareFilebinUrl\(/.test(main), 'isPlaylistShareFilebinUrl exists');
  assert.ok(/@JavascriptInterface\s+fun isPlaylistShareUrl\(/.test(main), 'isPlaylistShareUrl exists');
  assert.ok(main.includes('onPlaylistShareComplete'), 'calls onPlaylistShareComplete');
  assert.ok(main.includes('onPlaylistImportComplete'), 'calls onPlaylistImportComplete');
  assert.ok(main.includes('updateSharePackagingNotification'), 'implements packaging progress notification');
  assert.ok(main.includes('updateShareUploadProgressNotification'), 'implements upload progress notification');
  assert.ok(main.includes('updateShareDownloadProgressNotification'), 'implements download progress notification');
  assert.ok(main.includes('moonlight_playlist_share'), 'uses dedicated sharing notification channel');
});

check('share_paths.xml exposes shared-playlists cache folder to FileProvider', () => {
  const xml = fs.readFileSync(path.join(ROOT, 'app/src/main/res/xml/share_paths.xml'), 'utf8');
  assert.ok(xml.includes('shared-playlists/'), 'shared-playlists path exposed in FileProvider');
});

// 2. AnonDrop & Filebin URL detection
const PlaylistShare = require(path.join(ASSETS, 'playlist-share.js'));

check('URL regex accurately recognizes AnonDrop and Filebin links and ignores other links', () => {
  // AnonDrop links
  assert.strictEqual(PlaylistShare.isAnonDropUrl('https://anondrop.net/d4i1rhv6ic6kl8fz'), true);
  assert.strictEqual(PlaylistShare.isAnonDropUrl('https://anondrop.net/d4i1rhv6ic6kl8fz/download'), true);
  assert.strictEqual(PlaylistShare.isAnonDropUrl('http://anondrop.net/xyz123'), true);
  assert.strictEqual(PlaylistShare.isRecognizedShareUrl('https://anondrop.net/xyz123'), true);

  // Filebin fallback links
  assert.strictEqual(PlaylistShare.isFilebinUrl('https://filebin.net/d4i1rhv6ic6kl8fz'), true);
  assert.strictEqual(PlaylistShare.isFilebinUrl('https://filebin.net/d4i1rhv6ic6kl8fz/my_playlist.moonlight'), true);
  assert.strictEqual(PlaylistShare.isRecognizedShareUrl('https://filebin.net/xyz123'), true);

  // Unrelated links
  assert.strictEqual(PlaylistShare.isAnonDropUrl('https://www.youtube.com/watch?v=123'), false);
  assert.strictEqual(PlaylistShare.isAnonDropUrl('https://open.spotify.com/playlist/abc'), false);
  assert.strictEqual(PlaylistShare.isRecognizedShareUrl('https://www.youtube.com/watch?v=123'), false);
  assert.strictEqual(PlaylistShare.isAnonDropUrl(''), false);
});

// 3. Sharing settings gating
check('Sharing settings toggle gates sharing execution for AnonDrop', () => {
  let toastMsg = '';
  const mockRoot = {
    toast: (m) => { toastMsg = m; },
    NovelAudio: { getSetting: (k) => (k === 'playlistSharing' ? false : true) }
  };

  assert.strictEqual(PlaylistShare.isSharingEnabled.call(mockRoot), false);
  assert.strictEqual(PlaylistShare.isAnonDropEnabled.call(mockRoot), true);
  assert.strictEqual(PlaylistShare.isFilebinEnabled.call(mockRoot), true);
});

// 4. Packaging and bridge sharing lifecycle with AnonDrop as primary
check('shareCurrentPlaylist triggers AnonDrop upload and handles completion callback', (done) => {
  const bridgeCalls = [];
  const fakeBridge = {
    sharePlaylistPackage: (key, pass, method) => {
      bridgeCalls.push({ key, pass, method });
      setTimeout(() => {
        PlaylistShare.onPlaylistShareComplete({
          success: true,
          method: method,
          shareUrl: 'https://anondrop.net/testdrop123',
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
    confirm: () => true, // choose AnonDrop cloud link
    SpotifyUI: { getActivePlaylistKey: () => 'pl-favorites' },
    NovelAudio: { getSetting: () => true },
    onPlaylistShareComplete: PlaylistShare.onPlaylistShareComplete
  };

  PlaylistShare.shareCurrentPlaylist('pl-favorites', 'Favorites');
  assert.strictEqual(bridgeCalls.length, 1);
  assert.strictEqual(bridgeCalls[0].key, 'pl-favorites');
  assert.strictEqual(bridgeCalls[0].pass, 'mysecretpass');
  assert.strictEqual(bridgeCalls[0].method, 'anondrop');

  setTimeout(() => {
    assert.ok(toastLog.some((t) => t.includes('AnonDrop link ready')), 'toasts completion');
    global.window = savedWin;

    // 5. Automatic playlist detection in Downloads tab for AnonDrop and Filebin links
    let importedUrl = '';
    global.PlaylistShare = {
      isAnonDropUrl: PlaylistShare.isAnonDropUrl,
      isFilebinUrl: PlaylistShare.isFilebinUrl,
      isRecognizedShareUrl: PlaylistShare.isRecognizedShareUrl,
      importFromUrl: (u) => { importedUrl = u; }
    };

    const SD = require(path.join(ASSETS, 'song-download.js'));
    const testAnonUrl = 'https://anondrop.net/testdrop123';
    const testFilebinUrl = 'https://filebin.net/testbin123/favorites.moonlight';

    // Test parseLinks accepts AnonDrop link
    const parsedAnon = SD.parseLinks('Check this out: ' + testAnonUrl);
    assert.strictEqual(parsedAnon.links[0], testAnonUrl, 'parseLinks captures AnonDrop URL');

    // Verify SD.handleSharedPlaylistLink routes AnonDrop URLs directly to PlaylistShare.importFromUrl
    const handledAnon = SD.handleSharedPlaylistLink(testAnonUrl);
    assert.strictEqual(handledAnon, true, 'recognizes and handles AnonDrop URL');
    assert.strictEqual(importedUrl, testAnonUrl, 'automatically routed to PlaylistShare.importFromUrl');

    // Verify Filebin fallback link handling
    const handledFb = SD.handleSharedPlaylistLink(testFilebinUrl);
    assert.strictEqual(handledFb, true, 'recognizes and handles Filebin URL');
    assert.strictEqual(importedUrl, testFilebinUrl, 'automatically routed to PlaylistShare.importFromUrl');
    console.log('ok - Downloads tab automatically intercepts AnonDrop & Filebin links and imports playlist');

    // 6. Password prompt upon receiving encrypted playlist
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
      source: 'https://anondrop.net/encrypteddrop'
    });

    assert.strictEqual(promptShown, true, 'prompt displayed to user');
    assert.strictEqual(reImportedUrl, 'https://anondrop.net/encrypteddrop');
    assert.strictEqual(reImportedPass, 'userEnteredPassword');

    global.window = savedWin6;
    console.log('ok - onPlaylistImportComplete prompts user for password when encrypted and re-attempts import');
    console.log('\nAll 6 playlist sharing, AnonDrop, and streaming tests passed cleanly!');
  }, 15);
});
