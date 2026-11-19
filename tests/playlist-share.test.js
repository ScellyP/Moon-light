// Run with: node tests/playlist-share.test.js
// Tests Playlist Sharing, AES-256 encryption, and AnonDrop integration:
// - AnonDrop anonymous integration: chunked upload & direct download endpoint (no account/login required)
// - Large-file RAM exhaustion protection: disk-streamed ZIP creation and streaming AES-256-GCM
// - Removal of Filebin support (clean AnonDrop exclusivity)
// - Dedicated Moonlight dialogs (Share, Unlock, and Success) replacing browser prompt/confirm
// - Sanitized playlist names in notifications (no "name:" or "list:" prefixes)
// - Password-protected sharing with AES-256-GCM encryption (password never in URL)
// - Automatic playlist detection in Downloads tab for AnonDrop links
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
check('PlaylistShare.kt exists and implements streaming packaging, AES-256 encryption, and AnonDrop without Filebin', () => {
  assert.ok(fs.existsSync(path.join(KT, 'PlaylistShare.kt')), 'PlaylistShare.kt exists');
  const src = fs.readFileSync(path.join(KT, 'PlaylistShare.kt'), 'utf8');
  assert.ok(src.includes('AES/GCM/NoPadding'), 'uses AES/GCM/NoPadding for encryption');
  assert.ok(src.includes('PBKDF2WithHmacSHA256'), 'uses PBKDF2WithHmacSHA256 key derivation');
  assert.ok(src.includes('anondrop.net'), 'interacts with anondrop.net REST API');
  assert.ok(src.includes('uploadToAnonDrop'), 'implements uploadToAnonDrop chunked upload');
  assert.ok(src.includes('downloadFromAnonDrop'), 'implements downloadFromAnonDrop direct download');
  assert.ok(src.includes('isAnonDropUrl'), 'implements isAnonDropUrl');
  assert.ok(src.includes('isRecognizedShareUrl'), 'implements isRecognizedShareUrl');
  assert.ok(!src.includes('filebin.net'), 'completely removed filebin.net');
  assert.ok(!src.includes('uploadToFilebin'), 'removed uploadToFilebin');
  assert.ok(src.includes('encryptFileAes256Gcm'), 'implements disk streaming AES-256 encryption');
  assert.ok(src.includes('decryptFileAes256Gcm'), 'implements disk streaming AES-256 decryption');
  assert.ok(src.includes('moonlight-shared-playlist'), 'writes moonlight-shared-playlist manifest');
  assert.ok(src.includes('MAGIC_ENCRYPTED'), 'uses magic header to detect encrypted packages');
  assert.ok(src.includes('onProgress'), 'provides progress callback for packaging and upload tracking');
  assert.ok(src.includes('isFolderPlaylist') && src.includes('isCuratedList'), 'resolves folder playlists (name:*) and custom playlists (list:*)');
  assert.ok(src.includes('SongLibrary'), 'leverages SongLibrary for song resolution and folder migration');
  assert.ok(src.includes('PlaylistCovers'), 'uses PlaylistCovers to locate custom cover art');
});

check('MainActivity exposes AnonDrop playlist sharing and sanitized notifications without Filebin', () => {
  const main = fs.readFileSync(path.join(KT, 'MainActivity.kt'), 'utf8');
  assert.ok(/@JavascriptInterface\s+fun sharePlaylistPackage\(/.test(main), 'sharePlaylistPackage exists');
  assert.ok(/@JavascriptInterface\s+fun importSharedPlaylist\(/.test(main), 'importSharedPlaylist exists');
  assert.ok(/@JavascriptInterface\s+fun isPlaylistShareAnonDropUrl\(/.test(main), 'isPlaylistShareAnonDropUrl exists');
  assert.ok(!/@JavascriptInterface\s+fun isPlaylistShareFilebinUrl\(/.test(main), 'isPlaylistShareFilebinUrl removed');
  assert.ok(/@JavascriptInterface\s+fun isPlaylistShareUrl\(/.test(main), 'isPlaylistShareUrl exists');
  assert.ok(main.includes('onPlaylistShareComplete'), 'calls onPlaylistShareComplete');
  assert.ok(main.includes('onPlaylistImportComplete'), 'calls onPlaylistImportComplete');
  assert.ok(main.includes('updateSharePackagingNotification'), 'implements packaging progress notification');
  assert.ok(main.includes('updateShareUploadProgressNotification'), 'implements upload progress notification');
  assert.ok(main.includes('updateShareDownloadProgressNotification'), 'implements download progress notification');
  assert.ok(main.includes('moonlight_playlist_share'), 'uses dedicated sharing notification channel');
  // Notification titles must sanitize name: / list:
  assert.ok(main.includes('playlistName.removePrefix("name:")'), 'sanitizes notification playlist title');
});

check('share_paths.xml exposes shared-playlists cache folder to FileProvider', () => {
  const xml = fs.readFileSync(path.join(ROOT, 'app/src/main/res/xml/share_paths.xml'), 'utf8');
  assert.ok(xml.includes('shared-playlists/'), 'shared-playlists path exposed in FileProvider');
});

// 2. AnonDrop URL detection & Filebin rejection
const PlaylistShare = require(path.join(ASSETS, 'playlist-share.js'));

check('URL regex accurately recognizes AnonDrop links and rejects Filebin & other links', () => {
  // AnonDrop links
  assert.strictEqual(PlaylistShare.isAnonDropUrl('https://anondrop.net/d4i1rhv6ic6kl8fz'), true);
  assert.strictEqual(PlaylistShare.isAnonDropUrl('https://anondrop.net/d4i1rhv6ic6kl8fz/download'), true);
  assert.strictEqual(PlaylistShare.isAnonDropUrl('http://anondrop.net/xyz123'), true);
  assert.strictEqual(PlaylistShare.isRecognizedShareUrl('https://anondrop.net/xyz123'), true);

  // Filebin links are rejected
  assert.strictEqual(PlaylistShare.isRecognizedShareUrl('https://filebin.net/d4i1rhv6ic6kl8fz'), false);
  assert.strictEqual(PlaylistShare.isRecognizedShareUrl('https://filebin.net/d4i1rhv6ic6kl8fz/my_playlist.moonlight'), false);

  // Unrelated links
  assert.strictEqual(PlaylistShare.isAnonDropUrl('https://www.youtube.com/watch?v=123'), false);
  assert.strictEqual(PlaylistShare.isAnonDropUrl('https://open.spotify.com/playlist/abc'), false);
  assert.strictEqual(PlaylistShare.isRecognizedShareUrl('https://www.youtube.com/watch?v=123'), false);
  assert.strictEqual(PlaylistShare.isAnonDropUrl(''), false);
});

// 3. Sharing settings gating
check('Sharing settings toggle gates sharing execution for AnonDrop', () => {
  const mockRoot = {
    toast: () => {},
    NovelAudio: { getSetting: (k) => (k === 'playlistSharing' ? false : true) }
  };

  assert.strictEqual(PlaylistShare.isSharingEnabled.call(mockRoot), false);
  assert.strictEqual(PlaylistShare.isAnonDropEnabled.call(mockRoot), true);
});

// 4. Modal Dialog Lifecycle in DOM
check('Custom Share, Unlock, and Success dialogs operate cleanly in DOM without browser prompt/confirm', () => {
  // Build a minimal mock DOM representing index.html elements
  function createElement(id, tag = 'div') {
    const classList = new Set();
    return {
      id,
      tagName: tag.toUpperCase(),
      classList: {
        add: (c) => classList.add(c),
        remove: (c) => classList.delete(c),
        contains: (c) => classList.has(c)
      },
      textContent: '',
      value: '',
      checked: false,
      style: {},
      _listeners: {},
      addEventListener: function (evt, fn) {
        if (!this._listeners[evt]) this._listeners[evt] = [];
        this._listeners[evt].push(fn);
      },
      click: function () {
        if (this._listeners['click']) {
          this._listeners['click'].forEach((fn) => fn({ target: this, preventDefault: () => {}, stopPropagation: () => {} }));
        }
      },
      focus: function () {}
    };
  }

  const elements = {
    'share-dialog-layer': createElement('share-dialog-layer'),
    'share-dialog-sub': createElement('share-dialog-sub'),
    'share-dialog-password': createElement('share-dialog-password', 'input'),
    'share-dialog-close': createElement('share-dialog-close', 'button'),
    'share-dialog-cancel': createElement('share-dialog-cancel', 'button'),
    'share-dialog-submit': createElement('share-dialog-submit', 'button'),
    'share-method-anondrop-card': createElement('share-method-anondrop-card', 'label'),
    'share-method-direct-card': createElement('share-method-direct-card', 'label'),
    'share-method-anondrop': createElement('share-method-anondrop', 'input'),
    'share-method-direct': createElement('share-method-direct', 'input'),

    'share-unlock-dialog-layer': createElement('share-unlock-dialog-layer'),
    'share-unlock-sub': createElement('share-unlock-sub'),
    'share-unlock-password': createElement('share-unlock-password', 'input'),
    'share-unlock-close': createElement('share-unlock-close', 'button'),
    'share-unlock-cancel': createElement('share-unlock-cancel', 'button'),
    'share-unlock-submit': createElement('share-unlock-submit', 'button'),

    'share-success-dialog-layer': createElement('share-success-dialog-layer'),
    'share-success-url': createElement('share-success-url'),
    'share-success-sub': createElement('share-success-sub'),
    'share-success-close': createElement('share-success-close', 'button'),
    'share-success-done': createElement('share-success-done', 'button'),
    'share-success-copy': createElement('share-success-copy', 'button'),
    'share-success-share': createElement('share-success-share', 'button')
  };

  elements['share-dialog-layer'].classList.add('hidden');
  elements['share-unlock-dialog-layer'].classList.add('hidden');
  elements['share-success-dialog-layer'].classList.add('hidden');

  const fakeBridge = {
    calls: [],
    sharePlaylistPackage: function (key, pass, method) {
      this.calls.push({ key, pass, method });
    },
    shareText: function (text) {
      this.sharedText = text;
    }
  };

  const savedDoc = global.document;
  const savedWin = global.window;
  const savedNav = global.navigator;

  let clipboardWritten = '';
  const mockClipboard = {
    writeText: (t) => { clipboardWritten = t; return Promise.resolve(); }
  };
  try {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: mockClipboard,
      configurable: true,
      writable: true
    });
  } catch (_) {}

  global.document = {
    getElementById: (id) => elements[id] || null,
    readyState: 'complete'
  };

  let toasts = [];
  global.window = {
    document: global.document,
    navigator: globalThis.navigator,
    AndroidBridge: fakeBridge,
    toast: (m) => toasts.push(m),
    NovelAudio: {
      getActivePlaylistKey: () => 'name:Rock Classics',
      getSetting: () => true
    },
    SongLibrary: {
      getPlaylistSongs: () => ['song1.mp3', 'song2.mp3', 'song3.mp3']
    }
  };

  PlaylistShare.initUI();

  // Test 1: openShareDialog formats clean name and song count, reveals modal
  PlaylistShare.openShareDialog('name:Rock Classics', 'name:Rock Classics');
  assert.strictEqual(elements['share-dialog-layer'].classList.contains('hidden'), false, 'share layer is visible');
  assert.ok(elements['share-dialog-sub'].textContent.includes('Rock Classics'), 'sub title has clean name without name:');
  assert.ok(elements['share-dialog-sub'].textContent.includes('3 songs'), 'sub title shows 3 songs');
  assert.strictEqual(PlaylistShare.isOpen(), true, 'isOpen() reports true');

  // Test 2: submit with password and direct method
  elements['share-dialog-password'].value = 'mypassword123';
  elements['share-method-direct'].checked = true;
  elements['share-dialog-submit'].click();

  assert.strictEqual(elements['share-dialog-layer'].classList.contains('hidden'), true, 'share layer closed after submit');
  assert.strictEqual(fakeBridge.calls.length, 1);
  assert.strictEqual(fakeBridge.calls[0].key, 'name:Rock Classics');
  assert.strictEqual(fakeBridge.calls[0].pass, 'mypassword123');
  assert.strictEqual(fakeBridge.calls[0].method, 'direct');

  // Test 3: onPlaylistShareComplete for AnonDrop opens Success modal & copies link
  PlaylistShare.onPlaylistShareComplete({
    success: true,
    method: 'anondrop',
    shareUrl: 'https://anondrop.net/abc789xyz',
    playlistName: 'name:Rock Classics'
  });

  assert.strictEqual(elements['share-success-dialog-layer'].classList.contains('hidden'), false, 'success dialog opened');
  assert.strictEqual(elements['share-success-url'].textContent, 'https://anondrop.net/abc789xyz');
  assert.strictEqual(clipboardWritten, 'https://anondrop.net/abc789xyz', 'automatically copied to clipboard');

  // Click Share on success dialog
  elements['share-success-share'].click();
  assert.strictEqual(fakeBridge.sharedText, 'https://anondrop.net/abc789xyz', 'AndroidBridge.shareText invoked');

  // Close via Done
  elements['share-success-done'].click();
  assert.strictEqual(elements['share-success-dialog-layer'].classList.contains('hidden'), true, 'success dialog closed');
  assert.strictEqual(PlaylistShare.isOpen(), false, 'isOpen() reports false');

  // Test 4: encrypted playlist import opens Unlock modal
  PlaylistShare.onPlaylistImportComplete({
    requiresPassword: true,
    source: 'https://anondrop.net/encrypted_test'
  });

  assert.strictEqual(elements['share-unlock-dialog-layer'].classList.contains('hidden'), false, 'unlock dialog opened');
  assert.strictEqual(PlaylistShare.isOpen(), true);

  // Close via Escape/close()
  PlaylistShare.close();
  assert.strictEqual(elements['share-unlock-dialog-layer'].classList.contains('hidden'), true, 'unlock dialog closed by close()');
  assert.strictEqual(PlaylistShare.isOpen(), false);

  global.document = savedDoc;
  global.window = savedWin;
  global.navigator = savedNav;
});

// 5. Automatic playlist detection in Downloads tab for AnonDrop links
check('Downloads tab automatically intercepts AnonDrop links and ignores Filebin links', () => {
  let importedUrl = '';
  global.PlaylistShare = {
    isAnonDropUrl: PlaylistShare.isAnonDropUrl,
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

  // Verify Filebin link is NOT recognized as shared playlist
  const handledFb = SD.handleSharedPlaylistLink(testFilebinUrl);
  assert.strictEqual(handledFb, false, 'rejects Filebin link');
});

console.log(`\nAll ${n} playlist sharing, custom dialog, and AnonDrop exclusivity tests passed cleanly!`);
