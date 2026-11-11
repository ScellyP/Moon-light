// Run with: node tests/hidden-song.test.js
// The hidden song (audio-player.js): kept out of the plain All songs views, still playable and still shown inside
// a playlist; injectIntoPlaylists puts it into up to two playlists at random places, never twice in one.
const assert = require('assert');
const { launch, check, finish } = require('./audio-harness');

const DIR = '/storage/emulated/0/Moonlight/Songs/';
const mk = (name, ref, playlists) => ({ id: DIR + name + '.mp3', path: DIR + name + '.mp3', title: name, durationSec: 100, ref: ref || 'Songs/' + name + '.mp3', inSongs: true, playlists: playlists || [], size: 1000 });
const HIDDEN = mk('Never Gonna Give You Up');
const lib = () => [mk('a', null, ['P1', 'P2']), mk('b', null, ['P1', 'P4']), mk('c', null, ['P1']), Object.assign({}, HIDDEN)];

function start(filesIn, lists) {
  const files = filesIn || [
    { id: 'p1', name: 'P1', source: 'user', songs: [{ ref: 'Songs/a.mp3' }, { ref: 'Songs/b.mp3' }, { ref: 'Songs/c.mp3' }] },
    { id: 'p2', name: 'P2', source: 'user', songs: [{ ref: 'Songs/a.mp3' }] },
    { id: 'p3', name: 'P3', source: 'folder', songs: [] },
    { id: 'p4', name: 'P4', source: 'user', songs: [{ ref: 'Songs/b.mp3' }] },
  ];
  const t = launch({ bluetooth: false });
  global.AndroidBridge = {
    scanAudioStartup() {}, scanAudio() {}, isBluetoothAudioConnected: () => false, nativeAudioLoad() {}, nativeAudioPlay() {},
    listPlaylists: () => JSON.stringify(files.map((f) => Object.assign({}, f, { songs: (f.songs || []).map((s) => Object.assign({ available: true }, s)) }))),
    savePlaylist: (json) => { const m = JSON.parse(json); const i = files.findIndex((f) => f.id === m.id); if (i >= 0) files[i] = m; else files.push(m); return true; },
  };
  t.nativeReady(); t.scanFinished(lib());
  if (lists) lists.forEach((n) => t.app.features.customPlaylists.create(n, []));
  t.files = files; t.mods = t.app._modules;
  return t;
}
const seeded = (seed) => { let s = seed; Math.random = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; };
const realRandom = Math.random;
const posIn = (t, name) => t.files.find((f) => f.name === name).songs.findIndex((s) => s.ref === HIDDEN.ref);

check('isHidden: only the fixed name in the Songs folder, any case and extension', () => {
  const t = start();
  const lib2 = t.state.tracks[0];
  assert.strictEqual(t.mods.MediaLibrary.isHidden(HIDDEN), true);
  assert.strictEqual(t.mods.MediaLibrary.isHidden({ path: DIR + 'NEVER GONNA GIVE YOU UP.M4A' }), true);
  assert.strictEqual(t.mods.MediaLibrary.isHidden({ path: '/storage/emulated/0/Novel/Audio/Lo-fi/Never Gonna Give You Up.mp3' }), false);   // another folder
  assert.strictEqual(t.mods.MediaLibrary.isHidden({ path: DIR + 'Never Gonna Give You Up (live).mp3' }), false);
  assert.strictEqual(t.mods.MediaLibrary.isHidden(lib2), false);
  assert.strictEqual(t.mods.MediaLibrary.isHidden(null), false);
});

check('left out of every plain All songs view: list, queue, search, picker list, count', () => {
  const t = start();
  assert.deepStrictEqual(t.app.getTracks().map((x) => x.title), ['a', 'b', 'c']);
  assert.strictEqual(t.app.getPlaylistTracks('all').length, 3);
  assert.deepStrictEqual(t.app.searchTracks('never gonna'), []);
  assert.deepStrictEqual(t.app.searchTracks('a').map((x) => x.title), ['a']);
  t.mods.AudioUI.selectPlaylist('all');
  assert.ok(t.state.queue.indexOf(HIDDEN.id) === -1 && t.state.queue.length === 3);
  assert.strictEqual(t.state.tracks.length, 4);                                     // it is on the phone and indexed
  assert.ok(t.app.getHiddenTrack() && t.app.getHiddenTrack().id === HIDDEN.id);
  assert.ok(t.mods.MediaLibrary.getTrack(HIDDEN.id));
});

check('no hidden song on the phone: everything is as before', () => {
  const t = launch({ bluetooth: false });
  global.AndroidBridge = { scanAudioStartup() {}, scanAudio() {}, isBluetoothAudioConnected: () => false };
  t.nativeReady(); t.scanFinished(lib().slice(0, 3)); t.mods = t.app._modules;
  assert.strictEqual(t.app.getHiddenTrack(), null);
  assert.strictEqual(t.app.getTracks(), t.state.tracks);                            // the very same list, no copy
  assert.deepStrictEqual(t.app.injectIntoPlaylists('nothing', 2), []);
});

check('inside a playlist it shows like any song, and plays there', () => {
  const t = start();
  const keys = t.app.injectIntoPlaylists(HIDDEN.id, 2);
  assert.strictEqual(keys.length, 2);
  const name = keys[0].replace('name:', '');
  assert.ok(t.app.getPlaylistTracks(name).some((x) => x.id === HIDDEN.id));
  assert.deepStrictEqual(t.app.getTracks().map((x) => x.title), ['a', 'b', 'c']);   // still not in All songs
  assert.strictEqual(t.app.playHiddenTrack(), true);
  assert.strictEqual(t.state.activePlaylist, name);                                  // played inside a playlist that holds it
  assert.strictEqual(t.state.queue.indexOf(HIDDEN.id) !== -1, true);
});

check('plays on its own when no playlist holds it', () => {
  const t = start([]);
  assert.strictEqual(t.app.playHiddenTrack(), true);
  assert.deepStrictEqual(t.state.queue, [HIDDEN.id]);
});

check('up to two playlists per call, different ones, the file is only referenced', () => {
  seeded(7);
  const t = start();
  const keys = t.app.injectIntoPlaylists(HIDDEN.id, 2);
  assert.strictEqual(keys.length, 2);
  assert.strictEqual(new Set(keys).size, 2);
  assert.strictEqual(t.files.filter((f) => f.songs.some((s) => s.ref === HIDDEN.ref)).length, 2);
  assert.strictEqual(t.state.tracks.length, 4);                                     // no song was copied or removed
  const more = start(); assert.strictEqual(more.app.injectIntoPlaylists(HIDDEN.id, 9).length, 2);   // never more than two
  assert.strictEqual(more.app.injectIntoPlaylists(HIDDEN.id, 0).length, 0);
  Math.random = realRandom;
});

check('never twice into the same playlist: a playlist that holds it is skipped, and when all do nothing happens', () => {
  seeded(11);
  const t = start();
  const first = t.app.injectIntoPlaylists(HIDDEN.id, 2);
  const second = t.app.injectIntoPlaylists(HIDDEN.id, 2);
  assert.strictEqual(second.length, 2);
  assert.strictEqual(new Set(first.concat(second)).size, 4);                         // four different playlists
  assert.deepStrictEqual(t.app.injectIntoPlaylists(HIDDEN.id, 2), []);               // all four hold it now
  t.files.forEach((f) => assert.strictEqual(f.songs.filter((s) => s.ref === HIDDEN.ref).length, 1));
  Math.random = realRandom;
});

check('one playlist only: one appearance; none at all: nothing', () => {
  seeded(3);
  const one = start([{ id: 'only', name: 'Only', source: 'user', songs: [{ ref: 'Songs/a.mp3' }] }]);
  assert.strictEqual(one.app.injectIntoPlaylists(HIDDEN.id, 2).length, 1);
  const none = start([]);
  assert.deepStrictEqual(none.app.injectIntoPlaylists(HIDDEN.id, 2), []);
  Math.random = realRandom;
});

check('the place in the playlist is spread out: first, middle and last all happen, not one fixed spot', () => {
  seeded(42);
  const seen = new Set();
  for (let i = 0; i < 120; i++) {
    const t = start([{ id: 'p', name: 'P', source: 'user', songs: [{ ref: 'Songs/a.mp3' }, { ref: 'Songs/b.mp3' }, { ref: 'Songs/c.mp3' }, { ref: 'Songs/x.mp3' }] }]);
    t.app.injectIntoPlaylists(HIDDEN.id, 1);
    seen.add(posIn(t, 'P'));
  }
  assert.deepStrictEqual(Array.from(seen).sort(), [0, 1, 2, 3, 4]);                  // every place is possible
  Math.random = realRandom;
});

check('a hand-picked list gets it too, in a random place, once', () => {
  seeded(5);
  const t = start([], ['Mine']);
  const id = t.app.features.customPlaylists.list()[0].id;
  t.app.addSongToPlaylist('list:' + id, DIR + 'a.mp3'); t.app.addSongToPlaylist('list:' + id, DIR + 'b.mp3');
  const keys = t.app.injectIntoPlaylists(HIDDEN.id, 2);
  assert.deepStrictEqual(keys, ['list:' + id]);
  const ids = t.app.features.customPlaylists.info(id).ids;
  assert.strictEqual(ids.length, 3);
  assert.strictEqual(ids.filter((x) => x === HIDDEN.id).length, 1);
  assert.deepStrictEqual(t.app.injectIntoPlaylists(HIDDEN.id, 2), []);
  Math.random = realRandom;
});

finish();
