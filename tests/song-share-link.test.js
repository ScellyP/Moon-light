// Run with: node tests/song-share-link.test.js
// The plain "Share" row in the song "..." menu: it sends the song's source LINK (no file), only for songs that have one.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createNode, findAll, hasClass } = require('./fake-dom');
const { check, finish } = require('./audio-harness');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// song-menu.js on the fake page, with a stub player.
function menu(track, bridge) {
  const listeners = {};
  const body = createNode('body');
  const doc = { body, createElement: createNode, createElementNS: (ns, t) => createNode(t), addEventListener(t, f, cap) { (listeners[t] = listeners[t] || []).push({ f, cap }); } };
  const win = {
    document: doc, AndroidBridge: bridge, setTimeout: (f) => { f(); return 1; }, clearTimeout() {},
    NovelAudio: {
      getTrackRecord: (id) => (id === track.id ? track : null), isLiked: () => false, getActivePlaylistKey: () => '',
      isLoopingSong: () => false,
    },
  };
  new Function('window', 'document', read('app/src/main/assets/song-menu.js').replace("})(typeof window !== 'undefined' ? window : this);", '})(window);'))(win, doc);
  const button = createNode('button');
  button.attrs['data-song-more'] = track.id;
  listeners.click.filter((l) => l.cap).forEach((l) => l.f({ target: button, preventDefault() {}, stopPropagation() {} }));
  const layer = () => body.children.find((c) => c.classList.contains('sm-layer'));
  const labels = () => findAll(layer(), hasClass('sm-row-label')).map((n) => n.textContent);
  const tap = (name) => {
    const r = findAll(layer(), hasClass('sm-row')).find((x) => findAll(x, hasClass('sm-row-label'))[0].textContent === name);   // the exact label: "Share" is not "Share song"
    (r.listeners.click || []).forEach((f) => f({ stopPropagation() {} }));
  };
  return { win, layer, labels, tap };
}

const LINK = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

check('a song with a source link gets a plain "Share" row; one without gets none', () => {
  const withLink = menu({ id: 'a', path: 'a', title: 'A', source: LINK }, {});
  assert.ok(withLink.labels().includes('Share'));
  assert.ok(!withLink.labels().includes('Share source link'), 'the row just says Share');
  const without = menu({ id: 'b', path: 'b', title: 'B' }, {});
  assert.ok(!without.labels().includes('Share'));
});

check('Share sends exactly the link to the share sheet and closes the menu', () => {
  const sent = [];
  const m = menu({ id: 'a', path: 'a', title: 'A', source: LINK }, { shareText: (t) => { sent.push(t); return true; } });
  m.tap('Share');
  assert.deepStrictEqual(sent, [LINK]);
  assert.ok(m.layer().classList.contains('hidden'));
});

check('outside the Android app the link is copied instead', () => {
  const m = menu({ id: 'a', path: 'a', title: 'A', source: LINK }, undefined);
  let copied = null;
  m.win.navigator = { clipboard: { writeText: (t) => { copied = t; } } };
  m.tap('Share');
  assert.strictEqual(copied, LINK);
});

check('the native side agrees: shareText exists, takes only web links, and the icon exists', () => {
  const main = read('app/src/main/java/com/scell/moonlight/MainActivity.kt');
  assert.ok(/@JavascriptInterface\s+fun shareText\(text: String\): Boolean/.test(main));
  const body = main.slice(main.indexOf('fun shareText('));
  assert.ok(body.slice(0, 600).includes('startsWith("https://")') && body.slice(0, 600).includes('startsWith("http://")'), 'only web links');
  assert.ok(read('app/src/main/assets/index.html').includes('<symbol id="i-link"'), 'icon i-link missing');
  assert.ok(read('app/src/main/assets/song-menu.js').includes("row('i-share', 'Share song'"), 'the file Share song row stays');
});

finish();
