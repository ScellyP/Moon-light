// Run with: node tests/playlist-editor.test.js
// The full-screen "Edit playlist" (playlist-editor.js): drag to reorder, minus to take out, Select, one Save.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createNode, findAll, hasClass } = require('./fake-dom');
const { check, finish } = require('./audio-harness');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app/src/main/assets/playlist-editor.js'), 'utf8');

function editor(opts) {
  const o = opts || {};
  const tracks = Array.from({ length: o.count === undefined ? 250 : o.count }, (_, i) => ({ id: 's' + i, path: '/m/s' + i + '.mp3', title: 'Song ' + i, artist: 'Artist ' + (i % 5) }));
  const calls = [], toasts = [], timers = [], docListeners = {};
  const body = createNode('body');
  const doc = {
    body, createElement: createNode, createElementNS: (ns, t) => createNode(t),
    addEventListener: (t, f) => { (docListeners[t] = docListeners[t] || []).push(f); },
    removeEventListener: (t, f) => { docListeners[t] = (docListeners[t] || []).filter((x) => x !== f); },
  };
  const audio = {
    getPlaylistInfo: (k) => (k === 'name:Mix' ? { key: k, name: 'Mix', canEdit: true } : null),
    getPlaylistTracks: (n) => { calls.push(['tracksOf', n]); return tracks; },
    applyPlaylistEdit: (k, order, removed) => { calls.push(['apply', k, order, removed]); return o.saveFails ? { ok: false, error: 'save' } : { ok: true, removed: removed.length }; },
  };
  const win = { document: doc, setTimeout: (f) => { timers.push(f); return timers.length; }, clearTimeout() {}, NovelAudio: audio, SongMenu: { toast: (m) => toasts.push(m) },
    AndroidBridge: {}, SpotifyUI: { syncTint: () => calls.push(['tint']) } };
  new Function('window', SRC.replace("})(typeof window !== 'undefined' ? window : this);", '})(window);'))(win);
  const layer = () => body.children.find((c) => c.id === 'pe-layer');
  const list = () => findAll(layer(), hasClass('pe-list'))[0];
  const rows = () => findAll(layer(), hasClass('pe-row'));
  const ids = () => rows().map((r) => r.getAttribute('data-id'));
  const tap = (n) => (n.listeners.click || []).forEach((f) => f({ target: n }));
  const byLabel = (txt) => findAll(layer(), (n) => n.tag === 'button' && n.textContent === txt)[0];
  const part = (row, cls) => findAll(row, hasClass(cls))[0];
  const fire = (type, ev) => (docListeners[type] || []).slice().forEach((f) => f(ev));
  const drag = (row, fromY, toY) => {
    const grip = part(row, 'pe-grip');
    (grip.listeners.pointerdown || []).forEach((f) => f({ clientY: fromY, pointerId: 1, currentTarget: grip, target: grip, preventDefault() {} }));
    fire('pointermove', { clientY: toY });
  };
  const drop = () => fire('pointerup', {});
  const scrollDown = () => { const l = list(); l.scrollTop = 1e9; l.clientHeight = 600; l.scrollHeight = 0; (l.listeners.scroll || []).forEach((f) => f({})); };
  return { win, calls, toasts, timers, layer, list, rows, ids, tap, byLabel, part, drag, drop, scrollDown, tracks, docListeners };
}
const names = (arr) => arr.map((i) => 's' + i);

check('opens like the Spotify screen: back, "Edit playlist", Save (off until something changes), rows with minus / art / title / grip, Select', () => {
  const e = editor();
  assert.strictEqual(e.win.PlaylistEditor.open('name:Mix', 'Mix'), true);
  assert.ok(e.win.PlaylistEditor.isOpen());
  assert.ok(/Edit playlist/.test(e.layer().textContent));
  assert.strictEqual(e.byLabel('Save').disabled, true);
  assert.ok(e.byLabel('Select'));
  assert.strictEqual(e.rows().length, 100);                               // a first chunk of a 250-song playlist
  const r = e.rows()[0];
  assert.ok(e.part(r, 'pe-minus') && e.part(r, 'pe-art') && e.part(r, 'pe-grip'));
  assert.strictEqual(e.part(r, 'pe-name').textContent, 'Song 0');
  assert.strictEqual(e.part(r, 'pe-artist').textContent, 'Artist 0');
  assert.deepStrictEqual(e.calls.find((c) => c[0] === 'tracksOf'), ['tracksOf', 'Mix']);
  assert.ok(e.calls.some((c) => c[0] === 'tint'));                        // follows the song colours
  assert.ok(/dyn-colours/.test(e.layer().className));
  e.scrollDown(); e.scrollDown();
  assert.strictEqual(e.rows().length, 250);
});

check('a playlist that does not exist does not open', () => {
  const e = editor();
  assert.strictEqual(e.win.PlaylistEditor.open('name:Nope', 'Nope'), false);
  assert.strictEqual(e.win.PlaylistEditor.isOpen(), false);
});

check('drag: the row follows the finger in whole rows, springs back when dropped, and Save sends the new order once', () => {
  const e = editor();
  e.win.PlaylistEditor.open('name:Mix', 'Mix');
  const row = e.rows()[0];
  e.drag(row, 100, 100 + 72 * 2 + 10);                                    // two rows down, ten pixels over
  assert.deepStrictEqual(e.ids().slice(0, 4), ['s1', 's2', 's0', 's3']);
  assert.strictEqual(row.style.transform, 'translateY(10px)');            // the rest is just the transform
  assert.ok(row.className.indexOf('dragging') !== -1);
  e.drop();
  assert.strictEqual(row.style.transform, '');
  assert.ok(row.className.indexOf('dragging') === -1);
  assert.strictEqual(e.byLabel('Save').disabled, false);
  assert.strictEqual(e.calls.filter((c) => c[0] === 'apply').length, 0);   // nothing is written while dragging
  e.tap(e.byLabel('Save'));
  const apply = e.calls.filter((c) => c[0] === 'apply');
  assert.strictEqual(apply.length, 1);                                    // ONE call, however many moves
  assert.deepStrictEqual(apply[0].slice(0, 2), ['apply', 'name:Mix']);
  assert.deepStrictEqual(apply[0][2].slice(0, 4), ['s1', 's2', 's0', 's3']);
  assert.strictEqual(apply[0][2].length, 250);                            // rows not drawn yet are kept, in place
  assert.deepStrictEqual(apply[0][3], []);
  assert.ok(!e.win.PlaylistEditor.isOpen());
  assert.deepStrictEqual(e.toasts, ['Playlist updated']);
});

check('drag up, and never past either end', () => {
  const e = editor({ count: 6 });
  e.win.PlaylistEditor.open('name:Mix', 'Mix');
  e.drag(e.rows()[4], 500, 500 - 72 * 3);
  assert.deepStrictEqual(e.ids(), ['s0', 's4', 's1', 's2', 's3', 's5']);
  e.drop();
  e.drag(e.rows()[0], 100, 100 - 900);                                    // far above the top: stays first
  assert.strictEqual(e.ids()[0], 's0');
  e.drop();
  e.drag(e.rows()[0], 100, 100 + 9000);                                   // far below the end: last
  assert.strictEqual(e.ids()[5], 's0');
  e.drop();
  assert.strictEqual(e.docListeners.pointermove.length, 0);               // the listeners were taken off again
});

check('a drag that ends where it started changes nothing', () => {
  const e = editor({ count: 5 });
  e.win.PlaylistEditor.open('name:Mix', 'Mix');
  e.drag(e.rows()[2], 300, 305);
  e.drop();
  assert.strictEqual(e.byLabel('Save').disabled, true);
  assert.deepStrictEqual(e.ids(), ['s0', 's1', 's2', 's3', 's4']);
});

check('minus takes a song out of the copy; it is sent as removed on Save and nothing before that', () => {
  const e = editor({ count: 5 });
  e.win.PlaylistEditor.open('name:Mix', 'Mix');
  e.tap(e.part(e.rows()[1], 'pe-minus'));
  assert.deepStrictEqual(e.ids(), ['s0', 's2', 's3', 's4']);
  assert.strictEqual(e.byLabel('Save').disabled, false);
  assert.strictEqual(e.calls.filter((c) => c[0] === 'apply').length, 0);
  e.tap(e.byLabel('Save'));
  const apply = e.calls.find((c) => c[0] === 'apply');
  assert.deepStrictEqual(apply[2], ['s0', 's2', 's3', 's4']);
  assert.deepStrictEqual(apply[3], ['s1']);
  assert.deepStrictEqual(e.toasts, ['Playlist updated. 1 song taken out.']);
});

check('Select: tick songs, then Remove n; Cancel leaves selecting; Android Back leaves selecting first', () => {
  const e = editor({ count: 6 });
  e.win.PlaylistEditor.open('name:Mix', 'Mix');
  e.tap(e.byLabel('Select'));
  assert.ok(/selecting/.test(e.layer().className));
  assert.strictEqual(e.byLabel('Remove').disabled, true);
  e.tap(e.part(e.rows()[0], 'pe-minus')); e.tap(e.part(e.rows()[3], 'pe-minus'));
  assert.strictEqual(e.rows().length, 6);                                 // ticking removes nothing yet
  assert.ok(e.byLabel('Remove 2'));
  e.tap(e.part(e.rows()[3], 'pe-minus'));                                 // tick again = untick
  assert.ok(e.byLabel('Remove 1'));
  e.tap(e.byLabel('Remove 1'));
  assert.deepStrictEqual(e.ids(), ['s1', 's2', 's3', 's4', 's5']);
  assert.ok(!/selecting/.test(e.layer().className));
  e.tap(e.byLabel('Select'));
  e.win.PlaylistEditor.close();                                           // Android Back while selecting
  assert.ok(!/selecting/.test(e.layer().className));
  assert.ok(e.win.PlaylistEditor.isOpen());
  e.tap(e.byLabel('Save'));
  assert.deepStrictEqual(e.calls.find((c) => c[0] === 'apply')[3], ['s0']);
});

check('Back with unsaved changes warns first and only the second tap discards; with no changes it just closes', () => {
  const e = editor({ count: 4 });
  e.win.PlaylistEditor.open('name:Mix', 'Mix');
  e.win.PlaylistEditor.close();
  assert.ok(!e.win.PlaylistEditor.isOpen());
  e.win.PlaylistEditor.open('name:Mix', 'Mix');
  e.tap(e.part(e.rows()[0], 'pe-minus'));
  e.win.PlaylistEditor.close();
  assert.ok(e.win.PlaylistEditor.isOpen());
  assert.ok(/Unsaved changes/.test(e.toasts[0]));
  e.win.PlaylistEditor.close();
  assert.ok(!e.win.PlaylistEditor.isOpen());
  assert.strictEqual(e.calls.filter((c) => c[0] === 'apply').length, 0);   // discarded, nothing written
  e.win.PlaylistEditor.open('name:Mix', 'Mix');                           // reopened: the copy starts fresh
  assert.strictEqual(e.rows().length, 4);
});

check('a failed save keeps the screen open with the changes', () => {
  const e = editor({ count: 3, saveFails: true });
  e.win.PlaylistEditor.open('name:Mix', 'Mix');
  e.tap(e.part(e.rows()[0], 'pe-minus'));
  e.tap(e.byLabel('Save'));
  assert.deepStrictEqual(e.toasts, ['Could not save the playlist']);
  assert.ok(e.win.PlaylistEditor.isOpen());
  assert.deepStrictEqual(e.ids(), ['s1', 's2']);
});

check('an empty playlist says so and has no Select', () => {
  const e = editor({ count: 0 });
  e.win.PlaylistEditor.open('name:Mix', 'Mix');
  assert.ok(/No songs in this playlist yet/.test(e.layer().textContent));
  assert.ok(e.byLabel('Select').className.indexOf('hidden') !== -1);
});

finish();
