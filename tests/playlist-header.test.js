// Run with: node tests/playlist-header.test.js
// The Songs-tab layout (Find in playlist, share, Add / Edit / Name and details chips) and the native pieces of
// "share source links": checked in the markup, the wiring and the Kotlin / FileProvider files.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { check, finish } = require('./audio-harness');

const root = path.join(__dirname, '..', 'app/src/main');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const html = read('assets/index.html');
const ui = read('assets/spotify-ui.js');

check('Songs tab layout: Find in playlist on top, cover, title, share / more / shuffle / play, then the Add / Edit / Name and details chips', () => {
  const at = (id) => html.indexOf('id="' + id + '"');
  const order = ['sp-album-find', 'sp-album-cover', 'sp-album-title', 'sp-album-meta', 'sp-album-actions', 'sp-album-chips', 'audio-queue'].map(at);
  assert.ok(order.every((n) => n > 0) && order.every((n, i) => i === 0 || n > order[i - 1]), 'in the Spotify order');
  assert.ok(/id="sp-album-find-input"[^>]*placeholder="Find in playlist"/.test(html));
  const chips = html.slice(at('sp-album-chips'), at('sp-album-find-empty'));
  const labels = [...chips.matchAll(/<span>([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepStrictEqual(labels, ['Add', 'Edit', 'Name and details']);
  assert.ok(/id="sp-album-chips" class="hidden"/.test(html));          // hidden for lists without a record
  const actions = html.slice(at('sp-album-actions'), at('sp-album-chips'));
  assert.ok(actions.indexOf('sp-album-share') < actions.indexOf('data-sp-more') && actions.indexOf('data-sp-more') < actions.indexOf('sp-album-shuffle') && actions.indexOf('sp-album-shuffle') < actions.indexOf('sp-album-play'));
  assert.ok(!/id="sp-album-edit"[^>]*sp-icon-btn|sp-icon-btn[^>]*id="sp-album-add"/.test(html));   // the old icon buttons are gone
});

check('the chips and the share button are wired: Add = picker, Edit = edit screen, Name and details = sheet, share icon = nothing yet', () => {
  assert.ok(/target\.closest\('#sp-album-add'\)[\s\S]{0,260}PlaylistPicker\.open/.test(ui));
  assert.ok(/target\.closest\('#sp-album-reorder'\)[\s\S]{0,260}PlaylistEditor\.open/.test(ui));
  assert.ok(/target\.closest\('#sp-album-edit'\)[\s\S]{0,260}SongMenu\.openEdit/.test(ui));
  assert.ok(/target\.closest\('#sp-album-share'\)\) return;/.test(ui));              // the share icon does nothing for now
  assert.ok(!/#sp-album-share'\)\) return shareLinks/.test(ui));
  assert.ok(/case 'sharelinks': \{\s*closeSheet\(\);\s*shareLinks\(\);/.test(ui));       // the links file stays in the ... menu
  assert.ok(/case 'sharelinks'/.test(ui) && /data-sp-act="sharelinks"/.test(html));
  assert.ok(/albumChips\.classList\.toggle\('hidden', !sum\.canEdit\)/.test(ui));
});

check('Find in playlist: filters the rows by title + artist, ignores case and accents, clears when another playlist opens', () => {
  assert.ok(/function findNorm/.test(ui) && /normalize\('NFKD'\)/.test(ui));
  assert.ok(/li\.classList\.toggle\('sp-find-miss', !hit\)/.test(ui));
  assert.ok(/#audio-queue li\.sp-find-miss \{ display: none; \}/.test(html));
  assert.ok(/lastFindPlaylist !== playlist/.test(ui));
  assert.ok(/MutationObserver/.test(ui.slice(ui.indexOf('function initFind'))));          // rows rebuilt after an add / remove are filtered too
  assert.ok(/initFind\(\);\s*setView\('library'\)/.test(ui));
});

check('share links, native side: a .txt in the app cache handed to the share sheet through FileProvider', () => {
  const kt = read('java/com/scell/moonlight/MainActivity.kt');
  assert.ok(/@JavascriptInterface\s+fun playlistShareLinks\(fileName: String, text: String\): Boolean/.test(kt));
  const body = kt.slice(kt.indexOf('fun playlistShareLinks'), kt.indexOf('fun playlistShareLinks') + 1800);
  assert.ok(/cacheDir/.test(body) && /playlist-links/.test(body) && /type = "text\/plain"/.test(body) && /FLAG_GRANT_READ_URI_PERMISSION/.test(body));
  assert.ok(/\.songshare/.test(body));
  const xml = read('res/xml/share_paths.xml');
  assert.ok(/<cache-path name="playlist_links" path="playlist-links\/" \/>/.test(xml));
  // the page only calls bridge methods that exist
  assert.ok(/playlistShareLinks/.test(read('assets/audio-player.js')));
});

check('the edit screen is loaded, and Android Back closes it before the picker and the sheets', () => {
  assert.ok(/<script src="playlist-editor\.js"><\/script>/.test(html));
  const app = read('assets/player-app.js');
  assert.ok(app.indexOf('PlaylistEditor.isOpen()') > 0 && app.indexOf('PlaylistEditor.isOpen()') < app.indexOf('PlaylistPicker.isOpen()') && app.indexOf('PlaylistPicker.isOpen()') < app.indexOf('SongMenu.isOpen()'));
});

finish();
