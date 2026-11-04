// Run with: node tests/song-share.test.js
// The Share button in the song "..." menu: the page API, the menu row, and the native pieces that
// have to agree (bridge method, FileProvider authority, shareable folders).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { launch, check, finish, TRACKS } = require('./audio-harness');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

check('NovelAudio.shareSong hands the song file path to AndroidBridge.songShare', () => {
  const t = launch();
  t.scanFinished();
  const sent = [];
  global.AndroidBridge.songShare = (p) => { sent.push(p); return true; };
  assert.strictEqual(t.app.shareSong(TRACKS[1].id), true);
  assert.deepStrictEqual(sent, [TRACKS[1].path]);
});

check('shareSong says false when it cannot share (unknown song, bridge refuses or throws, no bridge)', () => {
  const t = launch();
  t.scanFinished();
  global.AndroidBridge.songShare = () => true;
  assert.strictEqual(t.app.shareSong('/not/in/the/library.mp3'), false);
  global.AndroidBridge.songShare = () => false;
  assert.strictEqual(t.app.shareSong(TRACKS[0].id), false);
  global.AndroidBridge.songShare = () => { throw new Error('boom'); };
  assert.strictEqual(t.app.shareSong(TRACKS[0].id), false);
  delete global.AndroidBridge.songShare;
  global.AndroidBridge = {};            // outside the Android app there is no bridge method at all
  assert.strictEqual(t.app.shareSong(TRACKS[0].id), false);
});

check('sharing does not touch playback or the queue', () => {
  const t = launch();
  t.scanFinished();
  global.AndroidBridge.songShare = () => true;
  const before = JSON.stringify({ cur: t.state.currentTrackId, repeat: t.state.repeat });
  t.app.shareSong(TRACKS[2].id);
  assert.strictEqual(JSON.stringify({ cur: t.state.currentTrackId, repeat: t.state.repeat }), before);
});

check('the "..." menu has a Share row that calls shareSong and uses an icon that exists', () => {
  const menu = read('app/src/main/assets/song-menu.js');
  assert.ok(/row\('i-share', 'Share song'/.test(menu), 'menu row missing');
  assert.ok(menu.includes('a.shareSong(track.id)'));
  assert.ok(read('app/src/main/assets/index.html').includes('<symbol id="i-share"'), 'icon i-share missing');
});

check('the native side agrees: bridge method, FileProvider authority, shareable folders', () => {
  const main = read('app/src/main/java/com/scell/moonlight/MainActivity.kt');
  const manifest = read('app/src/main/AndroidManifest.xml');
  assert.ok(/@JavascriptInterface\s+fun songShare\(path: String\): Boolean/.test(main));
  assert.ok(main.includes('"$packageName.songshare"'), 'Kotlin authority must be <package>.songshare');
  assert.ok(manifest.includes('androidx.core.content.FileProvider') && manifest.includes('${applicationId}.songshare'));
  assert.ok(/android:grantUriPermissions="true"/.test(manifest) && /android:exported="false"/.test(manifest.slice(manifest.indexOf('FileProvider'))));
  assert.ok(manifest.includes('@xml/share_paths'));
  const paths = read('app/src/main/res/xml/share_paths.xml');
  assert.ok(paths.includes('path="Moonlight/Songs/"') && paths.includes('path="Novel/Audio/"'), 'both music folders must be shareable');
  assert.ok(!/path="\.?\/?"/.test(paths), 'never share the whole storage');
  // only songs that resolveAudioFile() accepts may be shared
  const body = main.slice(main.indexOf('fun songShare('));
  assert.ok(body.slice(0, 400).includes('resolveAudioFile(path)'));
});

finish();
