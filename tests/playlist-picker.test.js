// Run with: node tests/playlist-picker.test.js
// The "Add to this playlist" picker (playlist-picker.js): every song listed, search, + adds a reference once.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createNode, findAll, hasClass } = require('./fake-dom');
const { check, finish } = require('./audio-harness');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app/src/main/assets/playlist-picker.js'), 'utf8');

function picker(opts) {
  const o = opts || {};
  const tracks = o.tracks || Array.from({ length: 150 }, (_, i) => ({ id: 's' + i, path: '/m/s' + i + '.mp3', title: 'Song ' + i, artist: i % 2 ? 'Odd' : 'Even' }));
  const inList = o.inList || [];
  const calls = [], toasts = [];
  const body = createNode('body');
  const doc = { body, createElement: createNode, createElementNS: (ns, t) => createNode(t) };
  const audio = {
    getTracks: () => tracks,
    searchTracks: (q) => tracks.filter((t) => (t.title + ' ' + t.artist).toLowerCase().indexOf(String(q).trim().toLowerCase()) !== -1),
    getPlaylistInfo: (k) => (k === 'name:Mix' ? { key: k, name: 'Mix', canEdit: true } : null),
    getPlaylistOrder: () => inList.map((id) => ({ id })),
    addSongToPlaylist: (k, id, quiet) => { calls.push(['add', k, id, quiet]); return o.addFails ? false : true; },
    refreshPlaylists: () => calls.push(['refresh']),
  };
  const arts = [];
  const win = { document: doc, setTimeout: (f) => { f(); return 1; }, clearTimeout() {}, NovelAudio: audio, SongMenu: { toast: (m) => toasts.push(m) },
    AndroidBridge: { getArtwork: (path) => { arts.push(path); return 'data:image/jpeg;base64,X'; } } };
  if (o.observer) {
    win.IntersectionObserver = function (cb) { o.observer.cb = cb; o.observer.seen = []; this.observe = (n) => o.observer.seen.push(n); this.unobserve = () => {}; this.disconnect = () => { o.observer.seen = []; }; };
  }
  new Function('window', SRC.replace("})(typeof window !== 'undefined' ? window : this);", '})(window);'))(win);
  const layer = () => body.children.find((c) => c.id === 'pp-layer');
  const list = () => findAll(layer(), hasClass('pp-list'))[0];
  const rows = () => findAll(layer(), hasClass('pp-row'));
  const names = () => findAll(layer(), hasClass('pp-name')).map((n) => n.textContent);
  const tap = (n) => (n.listeners.click || []).forEach((f) => f({ target: n }));
  const type = (text) => { const i = findAll(layer(), (n) => n.tag === 'input')[0]; i.value = text; (i.listeners.input || []).forEach((f) => f({})); };
  const scrollDown = () => { const l = list(); l.scrollTop = 1e9; l.clientHeight = 600; l.scrollHeight = 0; (l.listeners.scroll || []).forEach((f) => f({})); };
  const addBtn = (i) => findAll(rows()[i], hasClass('pp-add'))[0];
  return { win, calls, toasts, layer, rows, names, tap, type, scrollDown, addBtn, tracks, arts };
}

check('opens with the playlist name and lists ALL songs, drawing more as you scroll', () => {
  const p = picker();
  assert.strictEqual(p.win.PlaylistPicker.open('name:Mix', 'Mix'), true);
  assert.ok(p.win.PlaylistPicker.isOpen());
  assert.ok(/Add to this playlist/.test(p.layer().textContent) && /Mix/.test(p.layer().textContent));
  assert.strictEqual(p.rows().length, 60);                       // a first screenful, not the whole library at once
  assert.strictEqual(p.names()[0], 'Song 0');
  p.scrollDown(); p.scrollDown();
  assert.strictEqual(p.rows().length, 150);                      // every song is reachable
  assert.strictEqual(new Set(p.names()).size, 150);              // and none is drawn twice
  p.scrollDown();
  assert.strictEqual(p.rows().length, 150);
});

check('opening for a playlist that does not exist does nothing', () => {
  const p = picker();
  assert.strictEqual(p.win.PlaylistPicker.open('name:Nope', 'Nope'), false);
  assert.strictEqual(p.win.PlaylistPicker.isOpen(), false);
});

check('+ adds the song to the playlist record once; it turns into a check and cannot be added again', () => {
  const p = picker();
  p.win.PlaylistPicker.open('name:Mix', 'Mix');
  p.tap(p.addBtn(2));
  assert.deepStrictEqual(p.calls, [['add', 'name:Mix', 's2', true]]);
  assert.ok(p.addBtn(2).className.indexOf('done') !== -1);
  assert.ok(/In the playlist/.test(p.addBtn(2).getAttribute('aria-label')));
  p.tap(p.addBtn(2));
  assert.strictEqual(p.calls.length, 1);                         // no second add
});

check('songs already in the playlist start as a check and are never added again', () => {
  const p = picker({ inList: ['s0', 's1'] });
  p.win.PlaylistPicker.open('name:Mix', 'Mix');
  assert.ok(p.addBtn(0).className.indexOf('done') !== -1 && p.addBtn(1).className.indexOf('done') !== -1);
  assert.ok(p.addBtn(2).className.indexOf('done') === -1);
  p.tap(p.addBtn(0));
  assert.strictEqual(p.calls.length, 0);
});

check('closing redraws the playlist once and says how many songs were added', () => {
  const p = picker();
  p.win.PlaylistPicker.open('name:Mix', 'Mix');
  p.tap(p.addBtn(0)); p.tap(p.addBtn(1)); p.tap(p.addBtn(5));
  assert.strictEqual(p.calls.filter((c) => c[0] === 'refresh').length, 0);      // quiet while picking
  p.win.PlaylistPicker.close();
  assert.strictEqual(p.calls.filter((c) => c[0] === 'refresh').length, 1);
  assert.deepStrictEqual(p.toasts, ['Added 3 songs to \u201cMix\u201d']);
  assert.strictEqual(p.win.PlaylistPicker.isOpen(), false);
  p.win.PlaylistPicker.open('name:Mix', 'Mix');                  // nothing added this time: no refresh, no toast
  p.win.PlaylistPicker.close();
  assert.strictEqual(p.calls.filter((c) => c[0] === 'refresh').length, 1);
  assert.strictEqual(p.toasts.length, 1);
});

check('search narrows the list, says so when nothing matches, and clearing brings every song back', () => {
  const p = picker();
  p.win.PlaylistPicker.open('name:Mix', 'Mix');
  p.type('song 14');
  assert.deepStrictEqual(p.names().slice(0, 3), ['Song 14', 'Song 140', 'Song 141']);
  p.type('zzzz');
  assert.strictEqual(p.rows().length, 0);
  assert.ok(/No songs match/.test(p.layer().textContent));
  p.type('');
  assert.strictEqual(p.rows().length, 60);
  assert.ok(!/No songs match/.test(p.layer().textContent));
});

check('an empty library says so instead of showing a blank screen', () => {
  const p = picker({ tracks: [] });
  p.win.PlaylistPicker.open('name:Mix', 'Mix');
  assert.ok(/No songs on this phone yet/.test(p.layer().textContent));
});

check('a failed add says so and keeps the + so it can be tried again', () => {
  const p = picker({ addFails: true });
  p.win.PlaylistPicker.open('name:Mix', 'Mix');
  p.tap(p.addBtn(0));
  assert.deepStrictEqual(p.toasts, ['Could not add the song']);
  assert.ok(p.addBtn(0).className.indexOf('done') === -1);
  p.win.PlaylistPicker.close();
  assert.strictEqual(p.calls.filter((c) => c[0] === 'refresh').length, 0);
});

check('artwork is asked only for rows that come on screen, one at a time', () => {
  const obs = {};
  const p = picker({ observer: obs });
  p.win.PlaylistPicker.open('name:Mix', 'Mix');
  assert.strictEqual(obs.seen.length, 60);                       // all rows are watched ...
  assert.strictEqual(p.arts.length, 0);                          // ... but none has asked for its picture yet
  obs.cb([{ isIntersecting: true, target: obs.seen[0] }, { isIntersecting: false, target: obs.seen[1] }, { isIntersecting: true, target: obs.seen[2] }]);
  assert.deepStrictEqual(p.arts, ['/m/s0.mp3', '/m/s2.mp3']);    // only the two that are visible
  const tile = findAll(p.rows()[0], hasClass('pp-art'))[0];
  assert.ok(tile.getAttribute('data-pp-cover'));
});

finish();
