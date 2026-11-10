// Run with: node tests/playlist-records.test.js
// Playlist records (create / rename / description / reorder / delete) and playback in the saved order.
// The native side is faked: playlist FILES live in `files` and the bridge reads/writes them like SongLibrary.kt does.
const assert = require('assert');
const { launch, check, finish } = require('./audio-harness');

const mk = (name, ref, playlists) => ({ id: '/storage/emulated/0/Moonlight/Songs/' + name + '.mp3', path: '/storage/emulated/0/Moonlight/Songs/' + name + '.mp3',
  title: name, durationSec: 100, ref: ref, inSongs: true, playlists: playlists, playlist: playlists[0] || null, size: 1000 });
const A = mk('a', 'Songs/a.mp3', ['Mix']), B = mk('b', 'Songs/b.mp3', ['Mix']), C = mk('c', 'Songs/c.mp3', ['Mix']),
  D = mk('d', 'Songs/d.mp3', ['Mix']), E = mk('e', 'Songs/e.mp3', ['Rock']), F = mk('f', 'Songs/f.mp3', []);
const lib = () => [A, B, C, D, E, F].map(t => Object.assign({}, t, { playlists: t.playlists.slice() }));
const refsOf = (list) => list.map(t => t.ref);

function start(extraFiles) {
  const files = [
    { id: 'pl-mix', name: 'Mix', source: 'user', description: '', songs: [{ ref: 'Songs/c.mp3', title: 'c' }, { ref: 'Songs/a.mp3', title: 'a' }, { ref: 'Songs/b.mp3', title: 'b' }] },
    { id: 'rock', name: 'Rock', source: 'folder', description: 'Loud', legacy: { folder: 'Rock' }, songs: [{ ref: 'Songs/e.mp3', title: 'e' }] },
  ].concat(extraFiles || []);
  const covers = {};
  const log = { saves: 0, deleted: [], adds: 0, lists: 0, scans: 0 };
  const t = launch({ bluetooth: false });
  const bridge = {
    scanAudioStartup() {}, scanAudio() { log.scans++; }, isBluetoothAudioConnected: () => false, nativeAudioLoad() {}, nativeAudioPlay() {},
    listPlaylists: () => { log.lists++; return JSON.stringify(files.map(f => Object.assign({}, f, { songs: f.songs.map(s => Object.assign({ available: true }, s)) }))); },
    savePlaylist: (json, overwrite) => {
      const m = JSON.parse(json); const i = files.findIndex(f => f.id === m.id);
      if (i < 0) files.push(m); else if (overwrite) files[i] = m; else return true;
      log.saves++; return true;
    },
    playlistCreate: (name, desc) => {
      if (files.some(f => f.name.toLowerCase() === name.toLowerCase())) return false;
      files.push({ id: 'pl-' + name.toLowerCase(), name: name, source: 'user', description: desc, songs: [] }); return true;
    },
    playlistDelete: (name) => {
      const i = files.findIndex(f => f.name === name && f.source === 'user');
      if (i < 0) return false; log.deleted.push(files[i].id); files.splice(i, 1); return true;
    },
    playlistAddSong: (name, path) => { log.adds++; const f = files.find(x => x.name === name); if (!f) return false; f.songs.push({ ref: 'Songs/' + path.replace(/^.*\//, ''), title: '' }); return true; },
    playlistCoverGet: (n) => covers[n] || '', playlistCoverSave: (n, u) => { covers[n] = u; return true; }, playlistCoverClear: (n) => { delete covers[n]; return true; },
  };
  global.AndroidBridge = bridge;
  t.nativeReady(); t.scanFinished(lib());
  t.files = files; t.covers = covers; t.log = log; t.mods = t.app._modules;
  return t;
}
const orderOf = (t, name) => refsOf(t.app.getPlaylistTracks(name)).map(r => r.replace(/^Songs\/|\.mp3$/g, '')).join('');

check('a playlist plays and lists in the order saved in its file; folder-only songs follow', () => {
  const t = start();
  assert.strictEqual(orderOf(t, 'Mix'), 'cabd');                       // c, a, b are saved; d belongs by folder only
  t.mods.AudioUI.selectPlaylist('Mix');
  assert.deepStrictEqual(t.state.queue.map(id => id.replace(/^.*\/|\.mp3$/g, '')), ['c', 'a', 'b', 'd']);
});

check('moving a song changes only the saved order, one place at a time, and refuses past the ends', () => {
  const t = start();
  const c = A.id.replace('/a.', '/c.');
  assert.strictEqual(t.app.movePlaylistSong('name:Mix', c, -1), false);          // c is first already
  assert.strictEqual(t.app.movePlaylistSong('name:Mix', c, 1), true);
  assert.strictEqual(orderOf(t, 'Mix'), 'acbd');
  // the first move also writes the folder-only song d into the record (after b), so the order is fixed from now on
  assert.deepStrictEqual(t.files[0].songs.map(s => s.ref), ['Songs/a.mp3', 'Songs/c.mp3', 'Songs/b.mp3', 'Songs/d.mp3']);
  assert.strictEqual(t.app.movePlaylistSong('name:Mix', c, -1), true);
  assert.strictEqual(orderOf(t, 'Mix'), 'cabd');
  // d moves up one place, behind a
  const d = A.id.replace('/a.', '/d.');
  assert.strictEqual(t.app.movePlaylistSong('name:Mix', d, -1), true);
  assert.strictEqual(orderOf(t, 'Mix'), 'cadb');
  assert.deepStrictEqual(t.files[0].songs.map(s => s.ref), ['Songs/c.mp3', 'Songs/a.mp3', 'Songs/d.mp3', 'Songs/b.mp3']);
  assert.strictEqual(t.state.tracks.length, 6);                                // no song was touched
});

check('shuffle never rewrites the saved order', () => {
  const t = start();
  t.mods.AudioUI.selectPlaylist('Mix');
  const before = t.log.saves;
  t.app.startNewShuffle(); t.app.startNewShuffle();
  assert.strictEqual(t.log.saves, before);
  assert.strictEqual(orderOf(t, 'Mix'), 'cabd');
});

check('rename + description: saved in the file, tracks and cover follow, a taken name never overwrites', () => {
  const t = start();
  t.covers['Mix'] = 'data:image/jpeg;base64,AAAA';
  t.mods.AudioUI.selectPlaylist('Mix');
  const r = t.app.editPlaylist('name:Mix', { name: 'Road trip', description: 'For the car' });
  assert.deepStrictEqual([r.ok, r.key], [true, 'name:Road trip']);
  assert.strictEqual(t.files[0].name, 'Road trip');
  assert.strictEqual(t.files[0].description, 'For the car');
  assert.strictEqual(t.files[0].id, 'pl-mix');                                   // same file, not a new one
  assert.strictEqual(t.covers['Road trip'], 'data:image/jpeg;base64,AAAA');
  assert.strictEqual('Mix' in t.covers, false);
  assert.strictEqual(t.state.activePlaylist, 'Road trip');
  assert.strictEqual(orderOf(t, 'Road trip'), 'cabd');
  const clash = t.app.editPlaylist('name:Road trip', { name: 'ROCK' });          // another playlist, other case
  assert.deepStrictEqual([clash.ok, clash.error], [false, 'taken']);
  assert.strictEqual(t.files[0].name, 'Road trip');
  const same = t.app.editPlaylist('name:Road trip', { name: 'road trip', description: 'x' });   // its own name in other case is fine
  assert.strictEqual(same.ok, true);
  assert.strictEqual(t.app.getPlaylistInfo('name:road trip').description, 'x');
});

check('privacy is saved in the file with the rest; a bad value changes nothing', () => {
  const t = start();
  assert.strictEqual(t.app.getPlaylistInfo('name:Mix').privacy, 'private');          // files default to private
  assert.strictEqual(t.app.editPlaylist('name:Mix', { privacy: 'public' }).ok, true);
  assert.strictEqual(t.files[0].privacy, 'public');
  assert.strictEqual(t.app.getPlaylistInfo('name:Mix').privacy, 'public');
  t.app.editPlaylist('name:Mix', { privacy: 'everyone', description: 'x' });
  assert.strictEqual(t.files[0].privacy, 'public');
});

check('a playlist that follows a folder keeps its name but can get a description', () => {
  const t = start();
  const info = t.app.getPlaylistInfo('name:Rock');
  assert.deepStrictEqual([info.canEdit, info.canRename, info.canDelete], [true, false, false]);
  assert.deepStrictEqual([t.app.editPlaylist('name:Rock', { name: 'Metal' }).error], ['locked']);
  assert.strictEqual(t.app.editPlaylist('name:Rock', { description: 'Very loud' }).ok, true);
  assert.strictEqual(t.files[1].description, 'Very loud');
  assert.strictEqual(t.files[1].legacy.folder, 'Rock');                          // the folder link is kept
  assert.deepStrictEqual([t.app.deletePlaylist('name:Rock').ok, t.app.deletePlaylist('name:Rock').error], [false, 'locked']);
  assert.strictEqual(t.files.length, 2);
});

check('create: an empty playlist file appears at once; a taken name is refused; the first song can go in', () => {
  const t = start();
  const r = t.app.createPlaylist('  Chill ', 'Slow songs');
  assert.deepStrictEqual([r.ok, r.key, r.name], [true, 'name:Chill', 'Chill']);
  assert.deepStrictEqual(t.files.find(f => f.name === 'Chill').songs, []);
  assert.ok(t.app.getPlaylistTargets().some(x => x.key === 'name:Chill'));
  assert.deepStrictEqual([t.app.createPlaylist('chill', '').ok, t.app.createPlaylist('chill', '').error], [false, 'taken']);
  assert.deepStrictEqual([t.app.createPlaylist('mix', '').error, t.app.createPlaylist('   ', '').error], ['taken', 'name']);
  assert.strictEqual(t.files.length, 3);
  const key = t.app.createPlaylistWith('Gym', A.id);
  assert.strictEqual(key, 'name:Gym');
  assert.deepStrictEqual(t.files.find(f => f.name === 'Gym').songs.map(s => s.ref), ['Songs/a.mp3']);
  assert.strictEqual(t.app.createPlaylistWith('Gym', A.id), null);               // never overwrites
});

check('delete: only the record goes (the file is moved aside natively); songs stay; the list falls back to All songs', () => {
  const t = start();
  t.mods.AudioUI.selectPlaylist('Mix');
  const r = t.app.deletePlaylist('name:Mix');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(t.log.deleted, ['pl-mix']);
  assert.strictEqual(t.state.tracks.length, 6);
  assert.strictEqual(t.state.activePlaylist, 'all');
  assert.strictEqual(t.app.getPlaylistInfo('name:Mix'), null);
  assert.strictEqual(t.state.tracks.some(x => (x.playlists || []).indexOf('Mix') !== -1), false);
});

check('hand-picked lists: description, rename, reorder and delete work through the same calls', () => {
  const t = start();
  const key = (() => { delete global.AndroidBridge.playlistCreate; return t.app.createPlaylist('Mine', 'Hand picked').key; })();
  assert.strictEqual(key.indexOf('list:'), 0);
  t.app.addSongToPlaylist(key, A.id); t.app.addSongToPlaylist(key, B.id);
  assert.deepStrictEqual(t.app.getPlaylistOrder(key).map(s => s.title), ['a', 'b']);
  assert.strictEqual(t.app.movePlaylistSong(key, A.id, 1), true);
  assert.deepStrictEqual(t.app.getPlaylistOrder(key).map(s => s.title), ['b', 'a']);
  assert.strictEqual(t.app.getPlaylistInfo(key).description, 'Hand picked');
  assert.strictEqual(t.app.getPlaylistInfo(key).maxDescription, 120);
  assert.strictEqual(t.app.editPlaylist(key, { name: 'Mine 2' }).ok, true);
  assert.strictEqual(t.app.editPlaylist(key, { name: 'rock' }).error, 'taken');
  assert.strictEqual(t.app.deletePlaylist(key).ok, true);
  assert.strictEqual(t.app.getPlaylistInfo(key), null);
});

check('the header asks cheaply: editable or not, and the description', () => {
  const t = start();
  assert.deepStrictEqual(t.app.getPlaylistSummary('name:Rock'), { canEdit: true, description: 'Loud' });
  assert.deepStrictEqual(t.app.getPlaylistSummary(''), { canEdit: false, description: '' });
  assert.deepStrictEqual(t.app.getPlaylistSummary('name:Nope'), { canEdit: false, description: '' });
});

check('adding songs for the picker: appended in the order tapped, never twice, redrawn only on refresh', () => {
  const t = start();
  t.app.createPlaylist('Fresh', '');
  const calls0 = t.log.adds;
  assert.strictEqual(t.app.addSongToPlaylist('name:Fresh', F.id, true), true);
  assert.strictEqual(t.app.addSongToPlaylist('name:Fresh', E.id, true), true);
  assert.strictEqual(t.app.addSongToPlaylist('name:Fresh', F.id, true), true);       // again: a no-op, not a second entry
  assert.strictEqual(t.log.adds - calls0, 2);
  assert.deepStrictEqual(t.files.find(f => f.name === 'Fresh').songs.map(x => x.ref), ['Songs/f.mp3', 'Songs/e.mp3']);
  assert.strictEqual(orderOf(t, 'Fresh'), 'fe');                                       // visible at once, in the order added
  assert.strictEqual(t.app.getPlaylistInfo('name:Fresh').count, 2);
  assert.strictEqual(typeof t.app.refreshPlaylists, 'function');
  t.app.refreshPlaylists();
  assert.strictEqual(orderOf(t, 'Fresh'), 'fe');
  assert.strictEqual(t.app.addSongToPlaylist('name:Mix', A.id, true), true);          // a folder/file member is already in
  assert.strictEqual(t.log.adds - calls0, 2);
});

check('the phone is asked for the playlist files only when a playlist changed, not for every redraw or song edit', () => {
  const t = start();
  t.app.getPlaylists(); t.app.getPlaylistTracks('Mix');
  const base = t.log.lists;
  for (let i = 0; i < 20; i++) { t.app.getPlaylists(); t.app.getPlaylistTracks('Mix'); t.app.getPlaylistSummary('name:Mix'); }
  t.mods.MediaLibrary.infoRev++;                                   // e.g. a song's title was edited
  t.app.getPlaylists(); t.app.getPlaylistTracks('Mix');
  assert.strictEqual(t.log.lists, base);                           // no new read
  t.app.editPlaylist('name:Mix', { description: 'x' });            // a playlist changed: one new read, then cached again
  t.app.getPlaylists(); t.app.getPlaylistTracks('Mix'); t.app.getPlaylistSummary('name:Mix');
  assert.strictEqual(t.log.lists, base + 1);
});

check('creating a playlist runs "Scan the sky" by itself; a refused name does not', () => {
  const t = start();
  const before = t.log.scans;
  assert.strictEqual(t.app.createPlaylist('Fresh', '').ok, true);
  assert.strictEqual(t.log.scans, before + 1);
  assert.strictEqual(t.app.createPlaylist('fresh', '').ok, false);
  assert.strictEqual(t.log.scans, before + 1);
});

check('a name used by a playlist file with no songs yet is taken too', () => {
  const t = start([{ id: 'quiet', name: 'Quiet', source: 'folder', description: '', legacy: { folder: 'Quiet' }, songs: [] }]);
  assert.deepStrictEqual([t.app.createPlaylist('quiet', '').ok, t.app.createPlaylist('quiet', '').error], [false, 'taken']);
  assert.strictEqual(t.app.editPlaylist('name:Mix', { name: 'QUIET' }).error, 'taken');
  assert.strictEqual(t.files.filter(f => f.name.toLowerCase() === 'quiet').length, 1);
});

check('hand-picked list: a move swaps with the neighbour that is shown, not with a song that is gone', () => {
  const t = start();
  delete global.AndroidBridge.playlistCreate;
  const key = t.app.createPlaylist('Pick', '').key;
  t.app.addSongToPlaylist(key, A.id); t.app.addSongToPlaylist(key, B.id);
  t.state.features.customPlaylists.lists[0].ids.splice(1, 0, 'gone-song');     // a song deleted from the phone sits between
  assert.strictEqual(t.app.movePlaylistSong(key, A.id, 1), true);
  assert.deepStrictEqual(t.app.getPlaylistOrder(key).map(x => x.title), ['b', 'a']);
  assert.strictEqual(t.app.movePlaylistSong(key, A.id, 1), false);               // last one cannot go down
});

finish();
