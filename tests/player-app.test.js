// Run with: node tests/player-app.test.js
// Moonlight was carved out of the Novel Reader app. These checks make sure nothing of the
// reader is still expected, and that the page, MainActivity, the manifest and the workflow agree.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '../app/src/main/assets');
const KT = path.join(__dirname, '../app/src/main/java/com/scell/moonlight');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const html = read(ASSETS, 'index.html');
const main = read(KT, 'MainActivity.kt');
const manifest = read(__dirname, '../app/src/main/AndroidManifest.xml');
const scripts = fs.readdirSync(ASSETS).filter((f) => f.endsWith('.js'));

let n = 0;
function check(name, fn) {
  try { fn(); } catch (e) { console.log('FAIL -', name); throw e; }
  n++; console.log('ok -', name);
}

check('the music panel is open from the start and fills the screen', () => {
  assert.ok(/<div id="audio-panel" data-view="album">/.test(html), 'the panel must not start hidden');
  assert.ok(/#audio-panel, #audio-panel\.hidden, #audio-panel:not\(\.hidden\) \{[^}]*position: fixed !important/.test(html));
  assert.ok(html.includes('<body class="player-app">'));
});

check('every AndroidBridge method a script calls exists in MainActivity', () => {
  const pageSrc = scripts.map((f) => read(ASSETS, f)).join('\n');
  const used = new Set();
  // the scripts reach the bridge as window.AndroidBridge, or through a local called bridge / b
  for (const m of pageSrc.matchAll(/\b(?:AndroidBridge|bridge)\.([a-zA-Z]+)\(/g)) used.add(m[1]);
  assert.ok(used.size >= 15, 'found too few bridge calls: ' + used.size);
  const gone = [...used].filter((name) => !new RegExp('@JavascriptInterface\\s+fun ' + name + '\\(').test(main));
  assert.deepStrictEqual(gone, [], 'bridge methods the page calls but MainActivity lost: ' + gone.join(', '));
});

check('every window.onXxx the app calls exists in the page', () => {
  const pageSrc = scripts.map((f) => read(ASSETS, f)).join('\n');
  const names = new Set();
  for (const m of (main + read(KT, 'SongDownloader.kt') + read(KT, 'AppUpdater.kt')).matchAll(/callPage\(\s*"(on[A-Za-z]+)"/g)) names.add(m[1]);
  assert.ok(names.size >= 8, 'found too few callPage names: ' + names.size);
  const missing = [...names].filter((fn) => !new RegExp('(?:window|root)\\.' + fn + '\\s*=|function ' + fn + '\\b').test(pageSrc));
  assert.deepStrictEqual(missing, [], 'the app calls page functions that do not exist: ' + missing.join(', '));
});

check('nothing of the reader is left: no reader scripts, bridge methods, permissions or class names', () => {
  ['reader.js', 'chapter-swipe.js', 'moon-lock.js', 'color-wheel.js', 'peek-mode.js'].forEach((f) => assert.ok(!scripts.includes(f), f + ' should not be here'));
  ['ChapterTools', 'MoonUnlockStore', 'AdaptiveBrightness', 'chapterTools', 'moonUnlock', 'nightLock', 'novelRoot', 'listNovels',
    'loadNovelChapters', 'getNovelCover', 'termux', 'Termux'].forEach((w) => assert.ok(!main.includes(w), 'MainActivity still mentions ' + w));
  assert.ok(!/termux/i.test(manifest), 'manifest still mentions Termux');
  assert.ok(!fs.existsSync(path.join(ASSETS, 'scripts')), 'the chapter scripts do not belong here');
  assert.ok(!main.includes('novelreader'), 'old package name left in MainActivity');
  assert.ok(!html.includes('id="reader"') && !html.includes('id="sidebar"'));
});

check('settings.txt has its own place, and only holds the music settings', () => {
  assert.ok(main.includes('File(playerRoot, "settings.txt")') && main.includes('"/storage/emulated/0/Moonlight"'));
  const sf = read(ASSETS, 'settings-file.js');
  assert.ok(/OBJECT_KEYS = \{\s*'novelReader_audioPrefs': 'audio'\s*\}/.test(sf));
  assert.ok(/STRING_KEYS = \{\}/.test(sf));
});

check('the moon badge still finds its maths (moon-phase.js before moon-theme.js)', () => {
  const loaded = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(loaded.indexOf('moon-phase.js') >= 0 && loaded.indexOf('moon-phase.js') < loaded.indexOf('moon-theme.js'));
  const mp = require(path.join(ASSETS, 'moon-phase.js'));
  const info = mp.moonPhaseInfo(new Date(Date.UTC(2000, 0, 6, 18, 14))); // the new moon of 6 Jan 2000
  assert.strictEqual(info.name, 'New Moon');
  assert.strictEqual(mp.moonPhasePath(0, 60, 60, 50), '');
});

check('the package, the manifest and the build agree on the new name', () => {
  const gradle = read(__dirname, '../app/build.gradle');
  assert.ok(gradle.includes("namespace 'com.scell.moonlight'") && gradle.includes('applicationId "com.scell.moonlight"'));
  fs.readdirSync(KT).forEach((f) => assert.ok(/^package com\.scell\.moonlight\b/m.test(read(KT, f)), f + ' has the wrong package'));
  assert.ok(manifest.includes('Theme.Moonlight') && !manifest.includes('NovelReader'));
  const wf = read(__dirname, '../.github/workflows/build-apk.yml');
  assert.ok(wf.includes('moonlight-$TAG.apk') && !wf.includes('novel-reader'));
  assert.ok(read(KT, 'AppUpdater.kt').includes('FILE_PREFIX = "moonlight-"'));
});

check('the resources the manifest needs exist and are not empty (an emptied strings.xml once slipped through)', () => {
  const res = path.join(__dirname, '../app/src/main/res');
  assert.ok(/<string name="app_name">Moonlight<\/string>/.test(read(res, 'values/strings.xml')));
  assert.ok(/<style name="Theme\.Moonlight"/.test(read(res, 'values/themes.xml')));
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const empty = walk(path.join(__dirname, '../app/src')).filter((f) => fs.statSync(f).size === 0);
  assert.deepStrictEqual(empty, [], 'empty files: ' + empty.join(', '));
});

console.log(n + ' checks passed');
