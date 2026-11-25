// Run with: node tests/song-download.test.js
// The "Download songs" tab (app/src/main/assets/song-download.js): link parsing, playlist and song
// name cleaning, the wizard's state machine (download, name, playlist, place, play) and that the
// page, the native bridge and the script agree. The tab's own DOM code needs a page and is not
// covered here (it was driven by hand in a headless browser).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const SD = require('../app/src/main/assets/song-download.js');

let n = 0;
function check(name, fn) { fn(); n++; console.log('ok -', name); }

const STAGED = (i) => '/storage/emulated/0/Moonlight/Songs/.staging/s_' + i + '/Song ' + i + ' (Official).mp3';

// A wizard wired to a fake native side that records what it was asked and lets a test answer.
function setup({ failStage = null } = {}) {
  const log = [], played = [], changes = [];
  const w = SD.createWizard({
    stage(id, url) {
      if (failStage === 'throw') throw new Error('Not connected to the app yet');
      log.push('stage ' + id + ' ' + url);
    },
    place(id, p, name, folder) { log.push('place ' + id + ' ' + p + ' | ' + name + ' | ' + folder); },
    cancel() { log.push('cancel'); },
    discard() { log.push('discard'); },
    play(p, folder) { played.push(p + ' | ' + folder); },
    onChange(state) { changes.push(state.step); },
  });
  const ids = (kind) => log.filter((l) => l.startsWith(kind + ' ')).map((l) => l.split(' ')[1]);
  return { w, s: w.state, log, played, changes, ids, step: () => w.state.step };
}

check('parseLinks keeps web links, drops duplicates, counts what it skipped', () => {
  const r = SD.parseLinks('https://a.example/x\nhttps://a.example/x  http://b.example/y, not-a-link\n\nftp://c');
  assert.deepStrictEqual(r.links, ['https://a.example/x', 'http://b.example/y']);
  assert.strictEqual(r.skipped, 2);
  assert.deepStrictEqual(SD.parseLinks(null), { links: [], skipped: 0 });
});

check('parseLinks stops at 50 links and counts the rest as skipped', () => {
  const text = Array.from({ length: 53 }, (_, i) => 'https://x.example/' + i).join('\n');
  const r = SD.parseLinks(text);
  assert.strictEqual(r.links.length, 50);
  assert.strictEqual(r.skipped, 3);
});

check('cleanFolderName keeps only safe characters and never lets ".." through', () => {
  assert.strictEqual(SD.cleanFolderName("Lo-fi Focus"), 'Lo-fi Focus');
  assert.strictEqual(SD.cleanFolderName("  Rock  &   Roll's (Best), v2.0  "), "Rock & Roll's (Best), v2.0");
  assert.strictEqual(SD.cleanFolderName('../../etc'), 'etc');
  assert.strictEqual(SD.cleanFolderName('..'), '');
  assert.strictEqual(SD.cleanFolderName('a/b\\c:d*e?"f<g>h|i'), 'abcdefghi');
  assert.strictEqual(SD.cleanFolderName('音楽'), '');
  assert.strictEqual(SD.cleanFolderName(null), '');
  assert.strictEqual(SD.cleanFolderName('x'.repeat(100)).length, 60);
});

check('cleanSongName drops what a file name cannot hold, keeps any language, caps at 120', () => {
  assert.strictEqual(SD.cleanSongName('Back In Black'), 'Back In Black');
  assert.strictEqual(SD.cleanSongName('AC/DC: "Hells Bells" <live> | 1980?'), 'ACDC Hells Bells live  1980'.replace('  ', ' '));
  assert.strictEqual(SD.cleanSongName('  ..Mix..  '), 'Mix');
  assert.strictEqual(SD.cleanSongName('音楽 – Ünïcode ♪ 100%'), '音楽 – Ünïcode ♪ 100%');
  assert.strictEqual(SD.cleanSongName('a\tb\nc\u0000d'), 'a b c d');
  assert.strictEqual(SD.cleanSongName('\\/:*?'), '');
  assert.strictEqual(SD.cleanSongName(null), '');
  assert.strictEqual(Array.from(SD.cleanSongName('x'.repeat(200))).length, 120);
  assert.strictEqual(Array.from(SD.cleanSongName('😀'.repeat(200))).length, 120);   // never cuts an emoji in half
});

check('starting a run: only from the first step, discards leftovers, downloads the first song', () => {
  const t = setup();
  assert.strictEqual(t.w.start([]), false);
  assert.strictEqual(t.w.start(['https://a/1', 'https://a/2']), true);
  assert.strictEqual(t.step(), 'download');
  assert.deepStrictEqual(t.log, ['discard', 'stage s1 https://a/1']);
  assert.strictEqual(t.w.start(['https://a/9']), false);          // a run is already going
});

check('a downloaded song goes to the name step, named after its file, with the next song downloading behind it', () => {
  const t = setup();
  t.w.start(['https://a/1', 'https://a/2', 'https://a/3']);
  t.w.report('s1', 'done', STAGED(1));
  assert.strictEqual(t.step(), 'name');
  assert.strictEqual(t.w.current().path, STAGED(1));
  assert.strictEqual(t.w.current().name, 'Song 1 (Official)');
  assert.deepStrictEqual(t.ids('stage'), ['s1', 's2']);           // the next one is already on its way
  t.w.report('s2', 'done', STAGED(2));
  assert.deepStrictEqual(t.ids('stage'), ['s1', 's2']);           // but only one ahead: song 3 waits
});

check('a song is never downloaded two at a time', () => {
  const t = setup();
  t.w.start(['https://a/1', 'https://a/2']);
  t.w.report('s1', 'running', 'x');
  assert.deepStrictEqual(t.ids('stage'), ['s1']);
  t.w.report('s1', 'done', STAGED(1));
  assert.deepStrictEqual(t.ids('stage'), ['s1', 's2']);
  t.w.report('s1', 'done', STAGED(1));                            // a repeated answer changes nothing
  assert.deepStrictEqual(t.ids('stage'), ['s1', 's2']);
});

check('Save moves on to the playlists with the cleaned name; an emptied name keeps the song\'s own', () => {
  const t = setup();
  t.w.start(['https://a/1']);
  t.w.report('s1', 'done', STAGED(1));
  t.w.rename('  My / own: name  ');
  t.w.save();
  assert.strictEqual(t.step(), 'playlist');
  assert.strictEqual(t.w.current().name, 'My own name');

  const u = setup();
  u.w.start(['https://a/1']);
  u.w.report('s1', 'done', STAGED(1));
  u.w.rename('  ');
  u.w.save();
  assert.strictEqual(u.w.current().name, 'Song 1 (Official)');
});

check('choosing a playlist places the song, then plays it and moves on to the next one', () => {
  const t = setup();
  t.w.start(['https://a/1', 'https://a/2']);
  t.w.report('s1', 'done', STAGED(1));
  t.w.report('s2', 'done', STAGED(2));
  t.w.rename('First');
  t.w.save();
  assert.strictEqual(t.w.choose('Road Trip!'), true);
  assert.strictEqual(t.step(), 'placing');
  assert.strictEqual(t.s.folder, 'Road Trip');                    // cleaned
  assert.ok(t.log.includes('place p3 ' + STAGED(1) + ' | First | Road Trip'));
  t.w.report('p3', 'done', '/storage/emulated/0/Novel/Audio/Road Trip/First.mp3');
  assert.deepStrictEqual(t.played, ['/storage/emulated/0/Novel/Audio/Road Trip/First.mp3 | Road Trip']);
  assert.strictEqual(t.step(), 'name');                           // song 2 was ready: straight to its name
  assert.strictEqual(t.w.current().path, STAGED(2));
  assert.strictEqual(t.s.folder, '');
});

check('"No playlist" places the song directly in Audio; every placed song starts playing', () => {
  const t = setup();
  t.w.start(['https://a/1']);
  t.w.report('s1', 'done', STAGED(1));
  t.w.save();
  assert.strictEqual(t.w.choose(''), true);
  assert.ok(t.log.some((l) => /^place p\d+ .* \| Song 1 \(Official\) \| $/.test(l)));
  t.w.report('p2', 'done', '/storage/emulated/0/Novel/Audio/Song 1 (Official).mp3');
  assert.deepStrictEqual(t.played, ['/storage/emulated/0/Novel/Audio/Song 1 (Official).mp3 | ']);
  assert.strictEqual(t.step(), 'done');
});

check('New playlist: its own step, a name that cleans to nothing is refused, Back returns to the tiles', () => {
  const t = setup();
  t.w.start(['https://a/1']);
  t.w.report('s1', 'done', STAGED(1));
  t.w.save();
  t.w.chooseNew();
  assert.strictEqual(t.step(), 'newplaylist');
  assert.strictEqual(t.w.choose('???'), false);
  assert.strictEqual(t.w.choose('../..'), false);
  assert.strictEqual(t.step(), 'newplaylist');
  t.w.backToPlaylists();
  assert.strictEqual(t.step(), 'playlist');
  t.w.chooseNew();
  assert.strictEqual(t.w.choose('  Lo-fi  Focus '), true);
  assert.strictEqual(t.s.folder, 'Lo-fi Focus');
});

check('choosing is only possible on the playlist steps', () => {
  const t = setup();
  t.w.start(['https://a/1']);
  assert.strictEqual(t.w.choose('Rock'), false);                  // still downloading
  t.w.report('s1', 'done', STAGED(1));
  assert.strictEqual(t.w.choose('Rock'), false);                  // still on the name
  t.w.save();
  assert.strictEqual(t.w.choose('Rock'), true);
  assert.strictEqual(t.w.choose('Jazz'), false);                  // already placing
});

check('a failed download offers Retry (same song again) and Skip (on to the next)', () => {
  const t = setup();
  t.w.start(['https://a/1', 'https://a/2']);
  t.w.report('s1', 'failed', 'Video unavailable');
  assert.strictEqual(t.step(), 'download');
  assert.strictEqual(t.w.current().state, 'failed');
  assert.strictEqual(t.w.current().error, 'Video unavailable');
  assert.deepStrictEqual(t.ids('stage'), ['s1']);                 // nothing else starts behind a failure
  t.w.retryDownload();
  assert.deepStrictEqual(t.ids('stage'), ['s1', 's2']);           // a fresh job for the same song
  t.w.report('s2', 'failed', 'Still no');
  t.w.skip();
  assert.deepStrictEqual(t.ids('stage'), ['s1', 's2', 's3']);     // song 2 of the run is now on screen
  assert.strictEqual(t.w.current().url, 'https://a/2');
  t.w.report('s3', 'done', STAGED(2));
  assert.strictEqual(t.step(), 'name');
});

check('a song that fails in the background waits until its turn; skipping everything ends the run', () => {
  const t = setup();
  t.w.start(['https://a/1', 'https://a/2']);
  t.w.report('s1', 'done', STAGED(1));
  t.w.report('s2', 'failed', 'Private video');                    // song 2, while song 1 is being named
  assert.strictEqual(t.step(), 'name');                           // the user is not interrupted
  t.w.save();
  t.w.choose('Rock');
  t.w.report('p3', 'done', '/x/Rock/a.mp3');
  assert.strictEqual(t.step(), 'download');
  assert.strictEqual(t.w.current().error, 'Private video');
  t.w.skip();
  assert.strictEqual(t.step(), 'done');
});

check('a failed placement keeps the song: Try again, or go back and change the name', () => {
  const t = setup();
  t.w.start(['https://a/1']);
  t.w.report('s1', 'done', STAGED(1));
  t.w.rename('Taken');
  t.w.save();
  t.w.choose('Rock');
  t.w.report('p2', 'failed', 'A song called “Taken” is already in Rock. Change the name.');
  assert.strictEqual(t.step(), 'placefail');
  assert.ok(t.s.error.includes('already in Rock'));
  assert.deepStrictEqual(t.played, []);
  t.w.retryPlace();
  assert.strictEqual(t.step(), 'placing');
  t.w.report('p3', 'failed', 'again');
  t.w.backToName();
  assert.strictEqual(t.step(), 'name');
  assert.strictEqual(t.w.current().name, 'Taken');                // what was typed is still there
  t.w.rename('Fixed');
  t.w.save();
  t.w.choose('Rock');
  assert.ok(t.log.some((l) => l.endsWith('| Fixed | Rock')));
});

check('after the last song: All done, then Paste more starts over', () => {
  const t = setup();
  t.w.start(['https://a/1']);
  t.w.report('s1', 'done', STAGED(1));
  t.w.save();
  t.w.choose('');
  t.w.report('p2', 'done', '/x/a.mp3');
  assert.strictEqual(t.step(), 'done');
  t.w.again();
  assert.strictEqual(t.step(), 'paste');
  assert.deepStrictEqual(t.s.items, []);
  assert.strictEqual(t.w.start(['https://a/2']), true);
});

check('leaving mid-run cancels the jobs and deletes the staged songs; late answers are ignored', () => {
  const t = setup();
  t.w.start(['https://a/1', 'https://a/2']);
  t.w.report('s1', 'done', STAGED(1));                            // song 2 is downloading behind it
  t.log.length = 0;
  t.w.leave();
  assert.deepStrictEqual(t.log, ['cancel', 'discard']);
  assert.strictEqual(t.step(), 'paste');
  assert.deepStrictEqual(t.s.items, []);
  t.w.report('s2', 'done', STAGED(2));                            // arrives after leaving
  assert.strictEqual(t.step(), 'paste');
  assert.deepStrictEqual(t.log, ['cancel', 'discard']);
});

check('leaving costs nothing on the first step or after All done', () => {
  const t = setup();
  t.w.leave();
  assert.deepStrictEqual(t.log, []);
  t.w.start(['https://a/1']);
  t.w.report('s1', 'done', STAGED(1));
  t.w.save();
  t.w.choose('');
  t.w.report('p2', 'done', '/x/a.mp3');
  t.log.length = 0;
  t.w.leave();
  assert.deepStrictEqual(t.log, []);
  assert.strictEqual(t.step(), 'paste');
});

check('without the native side a song fails at once with the reason, and can be skipped', () => {
  const t = setup({ failStage: 'throw' });
  t.w.start(['https://a/1']);
  assert.strictEqual(t.step(), 'download');
  assert.strictEqual(t.w.current().state, 'failed');
  assert.strictEqual(t.w.current().error, 'Not connected to the app yet');
  t.w.skip();
  assert.strictEqual(t.step(), 'done');
});

check('job ids never repeat, even across runs, so a late answer from an old run cannot be mistaken', () => {
  const t = setup();
  t.w.start(['https://a/1']);
  t.w.leave();
  t.w.start(['https://a/1']);
  assert.deepStrictEqual(t.ids('stage'), ['s1', 's2']);
  t.w.report('s1', 'done', STAGED(1));                            // the old run's answer
  assert.strictEqual(t.step(), 'download');
  t.w.report('s2', 'done', STAGED(2));
  assert.strictEqual(t.step(), 'name');
});

check('a message on the first step (nothing on the clipboard) is shown there only', () => {
  const t = setup();
  t.w.setMessage('No song link on the clipboard.');
  assert.strictEqual(t.s.message, 'No song link on the clipboard.');
  t.w.start(['https://a/1']);
  assert.strictEqual(t.s.message, '');
  t.w.setMessage('ignored');
  assert.strictEqual(t.s.message, '');
});

check('the page, the native bridge and the script agree on names', () => {
  const assets = path.join(__dirname, '../app/src/main/assets');
  const kdir = path.join(__dirname, '../app/src/main/java/com/scell/moonlight');
  const kt = fs.readFileSync(path.join(kdir, 'MainActivity.kt'), 'utf8');
  const dl = fs.readFileSync(path.join(kdir, 'SongDownloader.kt'), 'utf8');
  const js = fs.readFileSync(path.join(assets, 'song-download.js'), 'utf8');
  ['stageSong', 'placeSong', 'cancelSongDownload', 'discardStagedSongs', 'readClipboard'].forEach((name) => {
    assert.ok(js.includes(name), 'page does not use ' + name);
    assert.ok(new RegExp('@JavascriptInterface\\s+fun ' + name + '\\(').test(kt), 'MainActivity has no bridge method ' + name);
  });
  ['lookupSongTitle', 'downloadSong'].forEach((old) => assert.ok(!kt.includes('fun ' + old), old + ' should be gone'));
  assert.ok(kt.includes('"onSongDownloadStatus"') && js.includes('root.onSongDownloadStatus'));
  ['fun stage(', 'fun place(', 'fun cancel(', 'fun isBusy('].forEach((m) => assert.ok(dl.includes(m), 'SongDownloader.kt lost ' + m));
  assert.ok(js.includes('playAfterRescan') && fs.readFileSync(path.join(assets, 'audio-player.js'), 'utf8').includes('playAfterRescan('));
  assert.ok(js.includes('SpotifyUI.getCover') && fs.readFileSync(path.join(assets, 'spotify-ui.js'), 'utf8').includes('getCover'));
  const manifest = fs.readFileSync(path.join(__dirname, '../app/src/main/AndroidManifest.xml'), 'utf8');
  // yt-dlp runs inside the app now: it needs the internet, and the song code never touches Termux
  // (the manifest's RUN_COMMAND permission is for the chapter scripts, see ChapterTools.kt)
  assert.ok(manifest.includes('android.permission.INTERNET'));
  assert.ok(!/termux/i.test(dl) && !/termux/i.test(js), 'the song downloader should not use Termux');
  const gradle = fs.readFileSync(path.join(__dirname, '../app/build.gradle'), 'utf8');
  const versionOf = (name) => (gradle.match(new RegExp('youtubedl-android:' + name + ':([\\d.]+)')) || [])[1];
  assert.ok(versionOf('library'), 'the youtubedl-android library is not a dependency');
  assert.strictEqual(versionOf('library'), versionOf('ffmpeg'), 'library and ffmpeg modules must be the same version');
  assert.ok(/useLegacyPackaging\s*=\s*true/.test(gradle), 'the bundled binaries must be unpacked on install');
  const rules = fs.readFileSync(path.join(__dirname, '../app/proguard-rules.pro'), 'utf8');
  assert.ok(rules.includes('-keep class com.yausername.**'), 'R8 would strip the downloader library');
});

check('the staging folder is inside the music folder, and the music scan skips it', () => {
  const kdir = path.join(__dirname, '../app/src/main/java/com/scell/moonlight');
  const kt = fs.readFileSync(path.join(kdir, 'MainActivity.kt'), 'utf8');
  const dl = fs.readFileSync(path.join(kdir, 'SongDownloader.kt'), 'utf8');
  assert.ok(dl.includes('STAGING_DIR = "/storage/emulated/0/Moonlight/Songs/.staging"'));
  assert.ok(dl.includes('AUDIO_DIR = "/storage/emulated/0/Novel/Audio"'));
  assert.ok(/walkTopDown\(\)[\s\S]{0,400}startsWith\("\."\)/.test(kt), 'the scan must skip folders that start with a dot');
});

check('every element the page looks up exists in index.html, and Download is a tab of the music panel', () => {
  const assets = path.join(__dirname, '../app/src/main/assets');
  const html = fs.readFileSync(path.join(assets, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(assets, 'song-download.js'), 'utf8');
  const ids = new Set([...js.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]));
  assert.ok(ids.size >= 3, 'found the ids the page uses');
  ids.forEach((id) => assert.ok(new RegExp('id="' + id + '"').test(html), 'index.html has no #' + id));
  ['dl-links', 'dl-go', 'dl-review', 'dl-jobs', 'dl-folders', 'dl-sheet', 'dl-open-btn'].forEach((old) =>
    assert.ok(!html.includes('id="' + old + '"'), 'the old #' + old + ' is gone'));
  assert.ok(/data-sp-view="download"/.test(html), 'the bottom bar has a Download tab');
  assert.ok(/data-view="download"\] #sp-view-download/.test(html), 'the download view can be shown');
  ['i-check', 'i-close', 'i-plus', 'i-moon-music'].forEach((icon) =>
    assert.ok(html.includes('id="' + icon + '"'), 'icon ' + icon + ' exists'));
});

check('download screen buttons and layouts are horizontally centred', () => {
  const assets = path.join(__dirname, '../app/src/main/assets');
  const html = fs.readFileSync(path.join(assets, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(assets, 'song-download.js'), 'utf8');
  assert.ok(/\.dl-primary,\s*\.dl-secondary\s*\{[\s\S]*?justify-content:\s*center/.test(html));
  assert.ok(/\.dl-primary,\s*\.dl-secondary\s*\{[\s\S]*?text-align:\s*center/.test(html));
  assert.ok(/\.dl-row-end\s*\{[\s\S]*?justify-content:\s*center/.test(html));
  assert.ok(/\.dl-crop-actions\s*\{[\s\S]*?justify-content:\s*center/.test(html));
  assert.ok(/\.dl-sp-action-bar\{[\s\S]*?justify-content:\s*center/.test(html));
  assert.ok(/\.dl-sp-save-btn\{[\s\S]*?justify-content:\s*center/.test(html));
  assert.ok(/\.dl-sp-page\{[\s\S]*?margin:\s*0 auto/.test(html));
  assert.ok(/\.dl-sp-song-list\{[\s\S]*?margin:\s*0 auto/.test(html));
  assert.ok(/\.dl-pl-step\s*\{[\s\S]*?align-items:\s*center/.test(html));
  assert.ok(js.includes('buildPlResolving') && js.includes('dl-spinner') && js.includes('dl-bar'));
});

check('parsePlaylistLinksText extracts playlist name, description, and songs while dropping duplicate links', () => {
  const sample = [
    '# Moonlight playlist links',
    '# name: Chill Wave & Lo-Fi',
    '# description: Favorite chill tracks',
    '# songs: 3 (3 with a source link)',
    '# One link per line. Lines that start with # are notes.',
    '',
    '# Track One - Artist A',
    'https://www.youtube.com/watch?v=abc12345',
    '',
    '# Track Two - Artist B',
    'https://youtu.be/def67890',
    '',
    '# Duplicate link should be ignored',
    'https://www.youtube.com/watch?v=abc12345',
    '',
    '# Track Three',
    'https://soundcloud.com/artist/track-three'
  ].join('\n');

  const res = SD.parsePlaylistLinksText(sample);
  assert.strictEqual(res.title, 'Chill Wave & Lo-Fi');
  assert.strictEqual(res.description, 'Favorite chill tracks');
  assert.strictEqual(res.links.length, 3);
  assert.strictEqual(res.links[0], 'https://www.youtube.com/watch?v=abc12345');
  assert.strictEqual(res.links[1], 'https://youtu.be/def67890');
  assert.strictEqual(res.links[2], 'https://soundcloud.com/artist/track-three');
});

check('parsePlaylistLinksText falls back to provided filename title when # name: is missing', () => {
  const sample = 'https://youtu.be/123\nhttps://youtu.be/456';
  const res = SD.parsePlaylistLinksText(sample, 'Summer Vacation');
  assert.strictEqual(res.title, 'Summer Vacation');
  assert.strictEqual(res.links.length, 2);
});

check('System share receiver and intent wiring in AndroidManifest.xml and MainActivity.kt', () => {
  const manifest = fs.readFileSync(path.join(__dirname, '../app/src/main/AndroidManifest.xml'), 'utf8');
  assert.ok(manifest.includes('android:name="android.intent.action.SEND"'), 'manifest handles ACTION_SEND');
  assert.ok(manifest.includes('android:mimeType="text/plain"'), 'manifest filters text/plain MIME type');
  assert.ok(manifest.includes('android:launchMode="singleTask"'), 'MainActivity uses singleTask launch mode');

  const main = fs.readFileSync(path.join(__dirname, '../app/src/main/java/com/scell/moonlight/MainActivity.kt'), 'utf8');
  assert.ok(main.includes('handleIncomingSendIntent'), 'MainActivity handles incoming send intents');
  assert.ok(main.includes('onIncomingShareLink'), 'calls onIncomingShareLink page callback');
  assert.ok(main.includes('open.spotify.com'), 'filters out Spotify links');
  assert.ok(main.includes('onShowFileChooser'), 'implements onShowFileChooser for HTML5 file picker');
  assert.ok(main.includes('fileChooserLauncher'), 'implements fileChooserLauncher for file chooser result');
});

check('Downloads tab UI contains Import playlist button and file input for .moonlight and .txt', () => {
  const js = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/song-download.js'), 'utf8');
  assert.ok(js.includes("button('Import playlist', 'dl-secondary dl-big'"), 'has Import playlist button');
  assert.ok(!js.includes('Import playlist .moonlight / .txt'), 'old verbose button label is removed');
  assert.ok(js.includes("setAttribute('aria-label', 'Import playlist')"), 'file input aria-label is Import playlist');
  assert.ok(js.includes('.moonlight') && js.includes('.txt'), 'file input accepts .moonlight and .txt');
  assert.ok(js.includes('root.onIncomingShareLink ='), 'defines window.onIncomingShareLink');
  assert.ok(js.includes('root.onIncomingMoonlightFile ='), 'defines window.onIncomingMoonlightFile');
  assert.ok(js.includes('startCustomPlaylistFlow'), 'defines startCustomPlaylistFlow');
});

check('formatEta formats seconds cleanly into MM:SS and H:MM:SS', () => {
  assert.strictEqual(SD.formatEta(0), '00:00');
  assert.strictEqual(SD.formatEta(45), '00:45');
  assert.strictEqual(SD.formatEta(125), '02:05');
  assert.strictEqual(SD.formatEta(3665), '1:01:05');
});

check('wizard progress updates track real percent, speed, and ETA per job without cross-talk', () => {
  const t = setup();
  t.w.start(['https://a/1', 'https://a/2']);
  
  // Progress on song 1
  const item1 = t.w.progress('s1', {
    percent: 42.5,
    eta: 12,
    speed: '2.5MiB/s',
    downloaded: '4.2MiB',
    total: '10.0MiB'
  });
  assert.strictEqual(item1.percent, 42.5);
  assert.strictEqual(item1.eta, 12);
  assert.strictEqual(item1.speed, '2.5MiB/s');
  assert.strictEqual(item1.downloaded, '4.2MiB');
  assert.strictEqual(item1.total, '10.0MiB');

  // Song 1 completes
  t.w.report('s1', 'done', STAGED(1));
  assert.strictEqual(item1.state, 'ready');
  assert.strictEqual(item1.percent, 100);

  // Song 2 begins and receives independent progress
  assert.deepStrictEqual(t.ids('stage'), ['s1', 's2']);
  const item2 = t.w.progress('s2', {
    percent: 15.0,
    eta: 25,
    speed: '1.8MiB/s'
  });
  assert.strictEqual(item2.percent, 15.0);
  assert.strictEqual(item2.eta, 25);
  assert.strictEqual(item2.speed, '1.8MiB/s');
  // Verify song 1 wasn't affected
  assert.strictEqual(item1.percent, 100);
});

check('Native progress wiring and UI styles agreement', () => {
  const downloaderKt = fs.readFileSync(path.join(__dirname, '../app/src/main/java/com/scell/moonlight/SongDownloader.kt'), 'utf8');
  assert.ok(downloaderKt.includes('onPage("onSongDownloadProgress"'), 'SongDownloader forwards progress to page');
  assert.ok(downloaderKt.includes('parseYtDlpLine'), 'SongDownloader parses yt-dlp stdout lines');

  const mainKt = fs.readFileSync(path.join(__dirname, '../app/src/main/java/com/scell/moonlight/MainActivity.kt'), 'utf8');
  assert.ok(mainKt.includes('callPage("onSongDownloadProgress"'), 'MainActivity forwards onSongDownloadProgress to WebView');

  const js = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/song-download.js'), 'utf8');
  assert.ok(js.includes('root.onSongDownloadProgress ='), 'song-download.js defines root.onSongDownloadProgress');
  assert.ok(js.includes('dl-determinate'), 'song-download.js uses dl-determinate for determinate bars');
  assert.ok(js.includes('dl-sp-item-bar-fill'), 'song-download.js renders playlist row progress bars');

  const html = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/index.html'), 'utf8');
  assert.ok(html.includes('.dl-bar.dl-determinate'), 'index.html contains .dl-bar.dl-determinate CSS');
  assert.ok(html.includes('.dl-sp-item-bar-fill'), 'index.html contains .dl-sp-item-bar-fill CSS');
});

check('Single-song download cancel button and .moonlight format handling', () => {
  const html = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/index.html'), 'utf8');
  assert.ok(html.includes('.dl-cancel-btn'), 'index.html defines .dl-cancel-btn CSS');

  const js = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/song-download.js'), 'utf8');
  assert.ok(js.includes('dl-cancel-btn'), 'song-download.js renders cancel button');
  assert.ok(js.includes('wizard.leave()'), 'cancel button triggers wizard.leave');
  assert.ok(js.includes('root.onIncomingMoonlightFile'), 'song-download.js handles onIncomingMoonlightFile');

  const manifest = fs.readFileSync(path.join(__dirname, '../app/src/main/AndroidManifest.xml'), 'utf8');
  assert.ok(manifest.includes('application/x-moonlight'), 'AndroidManifest handles application/x-moonlight');
  assert.ok(manifest.includes('.moonlight'), 'AndroidManifest handles .moonlight files');
  assert.ok(manifest.includes('android:priority="100"'), 'AndroidManifest sets priority 100 for default opening');
  assert.ok(manifest.includes('android:pathPattern=".*\\\\.moonlight"'), 'AndroidManifest matches .moonlight pathPattern');
  assert.ok(manifest.includes('android:pathSuffix=".moonlight"'), 'AndroidManifest matches .moonlight pathSuffix');
  assert.ok(manifest.includes('android:mimeType="application/octet-stream"'), 'AndroidManifest matches octet-stream');
  assert.ok(manifest.includes('android:mimeType="text/*"'), 'AndroidManifest matches text/*');

  const mainKt = fs.readFileSync(path.join(__dirname, '../app/src/main/java/com/scell/moonlight/MainActivity.kt'), 'utf8');
  assert.ok(mainKt.includes('handleIncomingViewIntent'), 'MainActivity handles VIEW intents');
  assert.ok(mainKt.includes('intent.clipData'), 'handleIncomingViewIntent reads from clipData fallback');
  assert.ok(mainKt.includes('onIncomingMoonlightFile'), 'MainActivity calls onIncomingMoonlightFile');

  const fgServiceKt = fs.readFileSync(path.join(__dirname, '../app/src/main/java/com/scell/moonlight/DownloadForegroundService.kt'), 'utf8');
  assert.ok(fgServiceKt.includes('ACTION_CANCEL'), 'DownloadForegroundService defines ACTION_CANCEL');
  assert.ok(fgServiceKt.includes('cancelHandler'), 'DownloadForegroundService exposes cancelHandler');
});

check('.moonlight default file association intent filters and intent.clipData resolution', () => {
  const manifest = fs.readFileSync(path.join(__dirname, '../app/src/main/AndroidManifest.xml'), 'utf8');

  // Verify filter with scheme="content" and no mimeType
  const contentNoMimeRegex = /<intent-filter[^>]*android:priority="100"[^>]*>[\s\S]*?<data[^>]*android:scheme="content"[^>]*>[\s\S]*?<data[^>]*android:pathSuffix="\.moonlight"[^>]*>[\s\S]*?<\/intent-filter>/;
  assert.ok(contentNoMimeRegex.test(manifest), 'manifest has priority 100 content filter with pathSuffix and no mimeType');

  // Verify filter with scheme="file" and no mimeType
  const fileNoMimeRegex = /<intent-filter[^>]*android:priority="100"[^>]*>[\s\S]*?<data[^>]*android:scheme="file"[^>]*>[\s\S]*?<data[^>]*android:pathSuffix="\.moonlight"[^>]*>[\s\S]*?<\/intent-filter>/;
  assert.ok(fileNoMimeRegex.test(manifest), 'manifest has priority 100 file filter with pathSuffix and no mimeType');

  // Verify filter with scheme="content", mimeType="*/*", pathPattern and pathSuffix
  const contentMimeRegex = /<intent-filter[^>]*android:priority="100"[^>]*>[\s\S]*?<data[^>]*android:scheme="content"[^>]*>[\s\S]*?<data[^>]*android:mimeType="\*\/\*"[^>]*>[\s\S]*?<\/intent-filter>/;
  assert.ok(contentMimeRegex.test(manifest), 'manifest has priority 100 content filter with */* mimeType');

  const mainKt = fs.readFileSync(path.join(__dirname, '../app/src/main/java/com/scell/moonlight/MainActivity.kt'), 'utf8');
  assert.ok(mainKt.includes('val uri = intent.data ?: intent.clipData?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.uri ?: return'), 'reads uri from data or clipData');
  assert.ok(mainKt.includes('Uri.decode(fileName)'), 'decodes URL-encoded file names');
});

check('custom download notification system and lifecycle fixes', () => {
  const fgServiceKt = fs.readFileSync(path.join(__dirname, '../app/src/main/java/com/scell/moonlight/DownloadForegroundService.kt'), 'utf8');
  assert.ok(fgServiceKt.includes('START_NOT_STICKY'), 'DownloadForegroundService uses START_NOT_STICKY');
  assert.ok(!/\breturn\s+START_STICKY\b/.test(fgServiceKt), 'DownloadForegroundService never returns START_STICKY');
  assert.ok(fgServiceKt.includes('isActiveCheck'), 'DownloadForegroundService verifies active download state on start');
  assert.ok(fgServiceKt.includes('DecoratedCustomViewStyle'), 'DownloadForegroundService uses DecoratedCustomViewStyle custom notifications');
  assert.ok(fgServiceKt.includes('notification_download_collapsed'), 'collapsed custom layout is referenced');
  assert.ok(fgServiceKt.includes('notification_download_expanded'), 'expanded custom layout is referenced');
  assert.ok(fgServiceKt.includes('notification_download_result'), 'result custom layout is referenced');

  const resDir = path.join(__dirname, '../app/src/main/res');
  assert.ok(fs.existsSync(path.join(resDir, 'layout/notification_download_collapsed.xml')), 'collapsed layout exists');
  assert.ok(fs.existsSync(path.join(resDir, 'layout/notification_download_expanded.xml')), 'expanded layout exists');
  assert.ok(fs.existsSync(path.join(resDir, 'layout/notification_download_result.xml')), 'result layout exists');
  assert.ok(fs.existsSync(path.join(resDir, 'drawable/notif_progress_bar.xml')), 'custom progress bar drawable exists');

  const downloaderKt = fs.readFileSync(path.join(__dirname, '../app/src/main/java/com/scell/moonlight/SongDownloader.kt'), 'utf8');
  assert.ok(downloaderKt.includes('isDownloading()'), 'SongDownloader exposes isDownloading()');
  assert.ok(downloaderKt.includes('onDownloadCancelledFromNotification'), 'SongDownloader notifies page on notification cancel');
  assert.ok(downloaderKt.includes('if (status == "failed" && message == "Stopped") return'), 'cancelled jobs do not post error notifications');
  assert.ok(downloaderKt.includes('playlistSucceeded'), 'SongDownloader tracks successful playlist items separately from failures');
  assert.ok(downloaderKt.includes('LinkedHashSet<String>()'), 'SongDownloader uses deterministic LinkedHashSet for active downloads');
  assert.ok(fgServiceKt.includes('if (!state.active || isActiveCheck?.invoke() != true) return'), 'DownloadForegroundService.start guards against stale/inactive state');

  const playbackKt = fs.readFileSync(path.join(__dirname, '../app/src/main/java/com/scell/moonlight/PlaybackService.kt'), 'utf8');
  assert.ok(!playbackKt.includes('cancelAll()'), 'PlaybackService does not wipe unrelated app notifications on idle');
});

check('playlist notification includes skipped songs and stops queue on Stopped', () => {
  const vm = require('vm');
  const { createNode } = require('./fake-dom');
  const viewEl = createNode('div');
  const stageEl = createNode('div');
  const notifCalls = [];
  const staged = [];
  const doc = {
    createElement: (tag) => createNode(tag),
    createElementNS: (_, tag) => createNode(tag),
    getElementById: (id) => (id === 'dl-stage' ? stageEl : id === 'sp-view-download' ? viewEl : null),
    activeElement: null,
  };
  const win = {
    document: doc,
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    Math,
    Array,
    RegExp,
    Error,
    Set,
    AndroidBridge: {
      stageSong: (id, url) => { staged.push({ id, url }); return true; },
      placeSong: () => true,
      cancelSongDownload: () => {},
      discardStagedSongs: () => {},
      notifyPlaylistProgress: (title, done, total) => notifCalls.push({ title, done, total }),
      getArtwork: () => '',
    },
    SongMemory: {
      normalizeUrl: (u) => u,
      findDownloaded: (u) => u.includes('skip') ? { name: 'Skipped Song' } : null,
      isPresent: () => true,
    },
  };
  win.window = win;
  const ctx = vm.createContext(win);
  const code = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/song-download.js'), 'utf8');
  vm.runInContext(code, ctx);

  win.onIncomingMoonlightFile('# name: Mix\nhttps://youtu.be/skip1\nhttps://youtu.be/keep1\nhttps://youtu.be/keep2\nhttps://youtu.be/keep3\nhttps://youtu.be/keep4', 'Mix.moonlight');

  // 1 skipped + 3 started (PL_CONCURRENCY = 3)
  assert.strictEqual(staged.length, 3);
  // Simulate notification cancel returning 'Stopped' for the first job
  win.onSongDownloadStatus(staged[0].id, 'failed', 'Stopped');
  // Must NOT kick off the 4th queued song after Stopped
  assert.strictEqual(staged.length, 3);

  // Now simulate notification cancel callback resetting UI and clearing notification
  win.onDownloadCancelledFromNotification();
  assert.strictEqual(stageEl.getAttribute('data-step'), 'paste');

  // Test a playlist where 1 song is skipped and 1 song completes: done must reach total (2 >= 2)
  notifCalls.length = 0;
  staged.length = 0;
  win.onIncomingMoonlightFile('# name: Small\nhttps://youtu.be/skip1\nhttps://youtu.be/keep1', 'Small.moonlight');
  assert.strictEqual(staged.length, 1);
  win.onSongDownloadStatus(staged[0].id, 'done', '/storage/emulated/0/Moonlight/Songs/.staging/s_1/song.mp3');
  const last = notifCalls[notifCalls.length - 1];
  assert.deepStrictEqual(last, { title: 'Small', done: 2, total: 2 });

  // Test cancelling a playlist via #dl-cancel-btn: must call cancelSongDownload and notifyPlaylistProgress(title, 0, 0), never (1, 1)
  const callOrder = [];
  const cancelBtn = createNode('button');
  const win2 = {
    document: {
      createElement: (tag) => createNode(tag),
      createElementNS: (_, tag) => createNode(tag),
      getElementById: (id) => (id === 'dl-stage' ? createNode('div') : id === 'sp-view-download' ? createNode('div') : id === 'dl-cancel-btn' ? cancelBtn : null),
      activeElement: null,
    },
    setTimeout, clearTimeout, Date, JSON, Math, Array, RegExp, Error, Set,
    AndroidBridge: {
      stageSong: () => true,
      placeSong: () => true,
      cancelSongDownload: () => callOrder.push('cancelSongDownload'),
      discardStagedSongs: () => callOrder.push('discardStagedSongs'),
      notifyPlaylistProgress: (title, done, total) => callOrder.push(`notify:${title}:${done}/${total}`),
    },
  };
  win2.window = win2;
  vm.runInContext(code, vm.createContext(win2));
  win2.onIncomingMoonlightFile('# name: CancelTest\nhttps://youtu.be/a1\nhttps://youtu.be/a2', 'CancelTest.moonlight');
  callOrder.length = 0;
  const { click } = require('./fake-dom');
  click(cancelBtn);
  assert.strictEqual(callOrder[0], 'cancelSongDownload', 'cancelSongDownload runs before notifyPlaylistProgress');
  assert.ok(callOrder.includes('notify:CancelTest:0/0'), 'cancel notifies (0, 0) instead of (1, 1)');
  assert.ok(!callOrder.some((c) => c.endsWith(':1/1')), 'cancel never sends 1/1 completion signal');
});

check('dynamic notification accent colours across Kotlin, XML layouts, and spotify-ui.js', () => {
  const kdir = path.join(__dirname, '../app/src/main/java/com/scell/moonlight');
  const resDir = path.join(__dirname, '../app/src/main/res');
  const mainKt = fs.readFileSync(path.join(kdir, 'MainActivity.kt'), 'utf8');
  const fgKt = fs.readFileSync(path.join(kdir, 'DownloadForegroundService.kt'), 'utf8');
  const pbKt = fs.readFileSync(path.join(kdir, 'PlaybackService.kt'), 'utf8');
  const bgKt = fs.readFileSync(path.join(kdir, 'BackgroundUpdater.kt'), 'utf8');
  const collapsedXml = fs.readFileSync(path.join(resDir, 'layout/notification_download_collapsed.xml'), 'utf8');
  const expandedXml = fs.readFileSync(path.join(resDir, 'layout/notification_download_expanded.xml'), 'utf8');
  const spotifyJs = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/spotify-ui.js'), 'utf8');

  assert.ok(/@JavascriptInterface\s+fun setNotificationAccent\(accentHex:\s*String,\s*accentStrongHex:\s*String\)/.test(mainKt),
    'MainActivity exposes setNotificationAccent bridge method');
  assert.ok(fgKt.includes('getSharedPreferences(PREFS_ACCENT, Context.MODE_PRIVATE)'),
    'DownloadForegroundService persists accent in SharedPreferences');
  assert.ok(fgKt.includes('refreshActiveNotification(context)'),
    'DownloadForegroundService live-refreshes active download notification');
  assert.ok(fgKt.includes('setTextColor(R.id.notif_dl_badge, accentColor)'),
    'DownloadForegroundService tints badge text dynamically');
  assert.ok(fgKt.includes('setImageViewBitmap(R.id.notif_dl_progress'),
    'DownloadForegroundService renders progress bar onto Bitmap for RemoteViews');
  assert.ok(fgKt.includes('renderProgressBarBitmap('),
    'DownloadForegroundService has renderProgressBarBitmap');
  assert.ok(pbKt.includes('DownloadForegroundService.getAccentColor(appContext)'),
    'PlaybackService uses persisted accent fallback');
  assert.ok(!pbKt.includes('ACCENT_FALLBACK = 0xFFBC44DD'),
    'PlaybackService no longer hardcodes ACCENT_FALLBACK');
  assert.ok(bgKt.includes('setColor(DownloadForegroundService.getAccentColor(context))'),
    'BackgroundUpdater tints update notification with persisted accent');
  assert.ok(collapsedXml.includes('<ImageView') && collapsedXml.includes('@+id/notif_dl_progress'),
    'collapsed layout uses ImageView for minSdk 24 progress bar');
  assert.ok(expandedXml.includes('<ImageView') && expandedXml.includes('@+id/notif_dl_progress'),
    'expanded layout uses ImageView for minSdk 24 progress bar');
  assert.ok(spotifyJs.includes('setNotificationAccent(') && spotifyJs.includes('syncNotificationAccent()'),
    'spotify-ui.js syncs notification accent to AndroidBridge');
});

check('spotify-ui.js syncs notification accent on load, tint, theme switch, and bridge retry', () => {
  const vm = require('vm');
  const spotifyCode = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/spotify-ui.js'), 'utf8');
  const { createNode } = require('./fake-dom');
  const panel = createNode('div', { id: 'audio-panel' });
  panel.style.setProperty = (k, v) => { panel.style[k] = v; };
  panel.style.removeProperty = (k) => { delete panel.style[k]; };
  const seek = createNode('input', { id: 'audio-seek' });
  seek.disabled = false;
  const artwork = createNode('div', { id: 'audio-artwork' });
  const docEl = createNode('html');
  const mutationCallbacks = [];
  let themeAccent = '#bc44dd';
  let themeStrong = '#cb6fe5';
  let coverTintEnabled = true;
  let shouldThrowOnce = true;
  const calls = [];

  const sandbox = {
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    getComputedStyle: () => ({
      getPropertyValue: (name) => {
        if (name === '--bg') return '#0b0d12';
        if (name === '--accent') return themeAccent;
        if (name === '--accent-strong') return themeStrong;
        return '';
      },
    }),
    MutationObserver: class {
      constructor(cb) { this.cb = cb; mutationCallbacks.push(cb); }
      observe() {}
    },
    document: {
      hidden: false,
      documentElement: docEl,
      getElementById: (id) => (id === 'audio-panel' ? panel : id === 'audio-seek' ? seek : id === 'audio-artwork' ? artwork : null),
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    NovelAudio: {
      getSetting: (k) => (k === 'coverTint' ? coverTintEnabled : true),
    },
    AndroidBridge: {
      setNotificationAccent: (a, s) => {
        if (shouldThrowOnce) {
          shouldThrowOnce = false;
          throw new Error('bridge not ready');
        }
        calls.push([a, s]);
      },
    },
  };
  sandbox.window = sandbox;
  vm.runInContext(spotifyCode, vm.createContext(sandbox));

  // setView->sync->resetTint->pushTint throws once; line 1940 initial syncNotificationAccent() retries and succeeds
  assert.strictEqual(shouldThrowOnce, false, 'first call threw as expected');
  assert.deepStrictEqual(calls[0], ['#bc44dd', '#cb6fe5'], 'retries initial theme accent after bridge error');

  sandbox.SpotifyUI.syncTint();
  assert.strictEqual(calls.length, 1, 'deduplicates unchanged accent');

  themeAccent = 'rgb(153 43 184)';
  themeStrong = '#83229e';
  mutationCallbacks[0]();
  assert.deepStrictEqual(calls[1], ['#992bb8', '#83229e'],
    'MutationObserver syncs light theme accent and parses space-separated rgb()');

  sandbox.SpotifyUI.applyTint([220, 60, 40]);
  assert.strictEqual(calls.length, 3, 'applyTint pushes cover-art accent to AndroidBridge');
  assert.match(calls[2][0], /^#[0-9a-f]{6}$/);
  assert.match(calls[2][1], /^#[0-9a-f]{6}$/);
  assert.notStrictEqual(calls[2][0], '#992bb8', 'cover-art tint replaces theme accent');

  coverTintEnabled = false;
  sandbox.SpotifyUI.refreshTint();
  assert.strictEqual(calls.length, 3, 'refreshTint runs cleanly when coverTint is disabled');
});

check('single-song backgrounding & persistence wiring in Kotlin and JS', () => {
  const kdir = path.join(__dirname, '../app/src/main/java/com/scell/moonlight');
  const dlKt = fs.readFileSync(path.join(kdir, 'SongDownloader.kt'), 'utf8');
  const mainKt = fs.readFileSync(path.join(kdir, 'MainActivity.kt'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/song-download.js'), 'utf8');

  // SongDownloader is application-scoped, detachable, buffers results, and notifies for s1/s2/...
  assert.ok(dlKt.includes('fun getInstance(context: Context): SongDownloader'), 'SongDownloader has getInstance');
  assert.ok(dlKt.includes('fun attach(') && dlKt.includes('fun detach('), 'SongDownloader has attach/detach');
  assert.ok(dlKt.includes('fun shouldKeepAliveOnDestroy(): Boolean'), 'SongDownloader has shouldKeepAliveOnDestroy');
  assert.ok(dlKt.includes('fun consumeSyncStateJson(): String'), 'SongDownloader has consumeSyncStateJson');
  assert.ok(dlKt.includes("jobId[0] == 's' && jobId[1].isDigit()"), 'postSongResultNotification handles s1/s2/... jobs');

  // MainActivity detaches onDestroy when active & enabled, and exposes bridge helpers
  assert.ok(mainKt.includes('SongDownloader.getInstance(applicationContext)'), 'MainActivity uses SongDownloader.getInstance');
  assert.ok(mainKt.includes('if (songDownloader.shouldKeepAliveOnDestroy())'), 'MainActivity checks shouldKeepAliveOnDestroy in onDestroy');
  assert.ok(mainKt.includes('songDownloader.detach()'), 'MainActivity detaches instead of releasing');
  assert.ok(/@JavascriptInterface\s+fun isStagedFile\(path:\s*String\):\s*Boolean/.test(mainKt), 'MainActivity exposes isStagedFile');
  assert.ok(/@JavascriptInterface\s+fun getSongDownloadSyncState\(\):\s*String/.test(mainKt), 'MainActivity exposes getSongDownloadSyncState');

  // MutationObserver does not call wizard.leave() on tab switch
  const observerBlock = js.match(/new MutationObserver\(\(\) => \{[\s\S]*?\}\)\.observe/);
  assert.ok(observerBlock && !observerBlock[0].includes('wizard.leave()'), 'tab switch MutationObserver does not call wizard.leave()');
});

check('wizard.snapshot and wizard.restore reconcile ready, downloading, placing, and dead jobs', () => {
  // 1. Ready item kept if staged, crop re-applied; downloading item reattached if still active
  const persisted = [];
  const crops = [];
  const log1 = [];
  const w1 = SD.createWizard({
    stage(id, url) { log1.push('stage ' + id + ' ' + url); return true; },
    place(id, p, name, folder) { log1.push('place ' + id + ' ' + p + ' | ' + name + ' | ' + folder); return true; },
    onPersist(snap) { persisted.push(snap); },
  });
  const saved1 = {
    step: 'name',
    index: 0,
    folder: '',
    message: '',
    error: '',
    seq: 2,
    items: [
      { id: 1, url: 'https://a/1', state: 'ready', path: STAGED(1), name: 'My Song', crop: { x: 0.1, y: 0.2, size: 0.5 }, error: '', jobId: '' },
      { id: 2, url: 'https://a/2', state: 'downloading', path: '', name: '', crop: null, error: '', jobId: 's2' },
    ],
  };
  assert.strictEqual(w1.restore(saved1, {
    isStaged: (p) => p === STAGED(1),
    activeJobs: ['s2'],
    bufferedResults: {},
    onCrop: (p, c) => crops.push({ p, c }),
  }), true);
  assert.strictEqual(w1.state.step, 'name');
  assert.deepStrictEqual(crops, [{ p: STAGED(1), c: { x: 0.1, y: 0.2, size: 0.5 } }]);
  assert.deepStrictEqual(log1, [], 'active s2 is not restarted');

  // Reattached s2 receives progress and completion
  const pItem = w1.progress('s2', { percent: 55, speed: '1.2MiB/s', eta: 5 });
  assert.strictEqual(pItem.percent, 55);
  w1.report('s2', 'done', STAGED(2));
  assert.strictEqual(w1.state.items[1].state, 'ready');

  // rename() persists without triggering onChange
  let changed = 0;
  const wRename = SD.createWizard({
    stage: () => true,
    onChange: () => { changed++; },
    onPersist: (snap) => persisted.push(snap),
  });
  wRename.start(['https://a/1']);
  wRename.report('s1', 'done', STAGED(1));
  const beforeRename = changed;
  const beforePersist = persisted.length;
  wRename.rename('Typed Name');
  assert.strictEqual(changed, beforeRename, 'rename does not trigger onChange');
  assert.strictEqual(persisted.length, beforePersist + 1, 'rename triggers onPersist');
  assert.strictEqual(persisted[persisted.length - 1].items[0].name, 'Typed Name');

  // 2. Downloading item finished while closed (bufferedResults) transitions to name and pumps next song
  const log2 = [];
  const w2 = SD.createWizard({
    stage(id, url) { log2.push('stage ' + id + ' ' + url); return true; },
  });
  w2.restore({
    step: 'download',
    index: 0,
    seq: 1,
    items: [
      { id: 1, url: 'https://a/1', state: 'downloading', jobId: 's1' },
      { id: 2, url: 'https://a/2', state: 'waiting', jobId: '' },
    ],
  }, {
    isStaged: () => true,
    activeJobs: [],
    bufferedResults: { s1: { jobId: 's1', status: 'done', message: STAGED(1) } },
  });
  assert.strictEqual(w2.state.step, 'name');
  assert.strictEqual(w2.state.items[0].path, STAGED(1));
  assert.deepStrictEqual(log2, ['stage s2 https://a/2'], 'pumps next song with non-colliding seq');

  // 3. Process died while downloading & staged file missing -> resets to waiting and pumps
  const log3 = [];
  const w3 = SD.createWizard({
    stage(id, url) { log3.push('stage ' + id + ' ' + url); return true; },
  });
  w3.restore({
    step: 'name',
    index: 0,
    seq: 3,
    items: [
      { id: 1, url: 'https://a/1', state: 'ready', path: STAGED(1), name: 'Gone' },
      { id: 2, url: 'https://a/2', state: 'downloading', jobId: 's3' },
    ],
  }, {
    isStaged: () => false,
    activeJobs: [],
    bufferedResults: {},
  });
  assert.strictEqual(w3.state.step, 'download');
  assert.strictEqual(w3.state.items[0].state, 'downloading');
  assert.strictEqual(w3.state.items[1].state, 'waiting');
  assert.deepStrictEqual(log3, ['stage s4 https://a/1']);

  // 4. Placing interrupted -> placefail if staged file still exists
  const w4 = SD.createWizard({ stage: () => true, place: () => true });
  w4.restore({
    step: 'placing',
    index: 0,
    folder: 'Rock',
    seq: 2,
    items: [{ id: 1, url: 'https://a/1', state: 'ready', path: STAGED(1), name: 'Song', jobId: 'p2' }],
  }, {
    isStaged: (p) => p === STAGED(1),
    activeJobs: [],
    bufferedResults: {},
  });
  assert.strictEqual(w4.state.step, 'placefail');
  assert.strictEqual(w4.state.folder, 'Rock');

  // 5. Placing finished while detached (file already moved out of staging -> isStaged false) -> replays placeDone
  const placedLog5 = [];
  const w5 = SD.createWizard({
    stage: () => true,
    place: () => true,
    play(path, folder) { placedLog5.push('play ' + path + ' ' + folder); },
  });
  w5.restore({
    step: 'placing',
    index: 0,
    folder: 'Rock',
    seq: 3,
    items: [
      { id: 1, url: 'https://a/1', state: 'ready', path: STAGED(1), name: 'Song', jobId: 'p2' },
      { id: 2, url: 'https://a/2', state: 'ready', path: STAGED(2), name: 'Next', jobId: '' },
    ],
  }, {
    isStaged: (p) => p === STAGED(2),
    activeJobs: [],
    bufferedResults: { p2: { jobId: 'p2', status: 'done', message: '/Songs/Song.mp3' } },
  });
  assert.strictEqual(w5.state.items[0].state, 'placed');
  assert.strictEqual(w5.state.index, 1);
  assert.strictEqual(w5.state.step, 'name');
  assert.deepStrictEqual(placedLog5, ['play /Songs/Song.mp3 Rock']);

  // 6. Placing still active while detached (file already moved, addSong in progress) -> reattaches p2
  const placedLog6 = [];
  const w6 = SD.createWizard({
    stage: () => true,
    place: () => true,
    play(path, folder) { placedLog6.push('play ' + path + ' ' + folder); },
  });
  w6.restore({
    step: 'placing',
    index: 0,
    folder: 'Rock',
    seq: 2,
    items: [{ id: 1, url: 'https://a/1', state: 'ready', path: STAGED(1), name: 'Song', jobId: 'p2' }],
  }, {
    isStaged: () => false,
    activeJobs: ['p2'],
    bufferedResults: {},
  });
  assert.strictEqual(w6.state.step, 'placing');
  w6.report('p2', 'done', '/Songs/Song.mp3');
  assert.strictEqual(w6.state.items[0].state, 'placed');
  assert.strictEqual(w6.state.step, 'done');
  assert.deepStrictEqual(placedLog6, ['play /Songs/Song.mp3 Rock']);
});

check('song-download.js persists wizard state in localStorage, restores on reopen, and survives tab switch', () => {
  const vm = require('vm');
  const { createNode } = require('./fake-dom');
  const store = {};
  const localStorageMock = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const code = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/song-download.js'), 'utf8');

  function mountApp(bridgeOverrides = {}) {
    const viewEl = createNode('div');
    const stageEl = createNode('div');
    const panelEl = createNode('div');
    panelEl.setAttribute('data-view', 'download');
    let observerCb = null;
    const win = {
      document: {
        createElement: (tag) => createNode(tag),
        createElementNS: (_, tag) => createNode(tag),
        getElementById: (id) => (id === 'dl-stage' ? stageEl : id === 'sp-view-download' ? viewEl : id === 'audio-panel' ? panelEl : null),
        activeElement: null,
      },
      MutationObserver: class {
        constructor(cb) { observerCb = cb; }
        observe() {}
      },
      localStorage: localStorageMock,
      setTimeout, clearTimeout, Date, JSON, Math, Array, RegExp, Error, Set,
      AndroidBridge: Object.assign({
        stageSong: () => true,
        placeSong: () => true,
        cancelSongDownload: () => {},
        discardStagedSongs: () => {},
        isStagedFile: () => true,
        getSongDownloadSyncState: () => JSON.stringify({ activeJobs: [], results: [], cancelled: false }),
        getArtwork: () => '',
      }, bridgeOverrides),
    };
    win.window = win;
    vm.runInContext(code, vm.createContext(win));
    return { win, stageEl, panelEl, triggerObserver: () => observerCb && observerCb() };
  }

  // First session: start download, switch away from Download tab -> wizard stays alive
  const s1 = mountApp();
  s1.win.SongDownload.wizard.start(['https://a/1', 'https://a/2']);
  s1.panelEl.setAttribute('data-view', 'library');
  s1.triggerObserver();
  assert.strictEqual(s1.win.SongDownload.wizard.state.step, 'download', 'tab switch keeps download running');
  assert.ok(store.moonlight_song_dl_wizard_v1, 'wizard state persisted to localStorage');

  // Second session (app closed & reopened): s1 finished while closed
  const s2 = mountApp({
    getSongDownloadSyncState: () => JSON.stringify({
      activeJobs: [],
      results: [{ jobId: 's1', status: 'done', message: STAGED(1) }],
      cancelled: false,
    }),
  });
  assert.strictEqual(s2.win.SongDownload.wizard.state.step, 'name', 'restored and replayed buffered s1 -> name step');
  assert.strictEqual(s2.win.SongDownload.wizard.state.items[0].path, STAGED(1));
  assert.strictEqual(s2.stageEl.getAttribute('data-step'), 'name');

  // Playlist flow persistence across app close & reopen:
  delete store.moonlight_song_dl_wizard_v1;
  const pStaged = [];
  const p1 = mountApp({
    stageSong: (id, url) => { pStaged.push({ id, url }); return true; },
  });
  p1.win.onIncomingMoonlightFile('# name: Road\nhttps://youtu.be/r1\nhttps://youtu.be/r2', 'Road.moonlight');
  assert.ok(store.moonlight_pl_dl_v1, 'playlist state persisted to localStorage');
  assert.strictEqual(pStaged.length, 2);

  // Reopen app: r1 finished while closed, r2 still active -> transitions to pl-downloading with 1 done, 1 active
  const p2 = mountApp({
    getSongDownloadSyncState: () => JSON.stringify({
      activeJobs: [pStaged[1].id],
      results: [{ jobId: pStaged[0].id, status: 'done', message: STAGED(1) }],
      cancelled: false,
    }),
  });
  assert.strictEqual(p2.stageEl.getAttribute('data-step'), 'pl-downloading');
  // r2 finishes in reopened session -> transitions to pl-edit
  p2.win.onSongDownloadStatus(pStaged[1].id, 'done', STAGED(2));
  assert.strictEqual(p2.stageEl.getAttribute('data-step'), 'pl-edit');
});

console.log(n + ' checks passed');
