// Run with: node tests/song-memory-hooks.test.js
// The player's side of song memory and Search (NovelAudio.getTracks / toggleLike / playTrack ...), the
// hooks that keep favorites.txt and recents.txt current, and the phone-side pieces they depend on.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { launch, check, finish, TRACKS } = require('./audio-harness');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const T = (id, title, playlist) => ({ id: '/storage/emulated/0/Novel/Audio/' + (playlist ? playlist + '/' : '') + id + '.mp3', path: 'file:///x/' + id, title, artist: 'Art ' + id, album: 'Alb', durationSec: 100, playlist: playlist || null });
const LIB = [T('a', 'Alpha', 'Pop'), T('b', 'Beta', 'Pop'), T('c', 'Gamma', 'Rock'), T('d', 'Delta', null)];

function boot(extra) {
  global.SongMemory = Object.assign({ calls: [], changed() { this.calls.push('changed'); }, restore() { this.calls.push('restore'); } }, extra || {});
  const t = launch({ saved: null, bluetooth: false });
  t.nativeReady(); t.scanFinished(LIB);
  return t;
}

check('the first scan asks song memory to restore the liked and recent songs', () => {
  const t = boot();
  assert.ok(global.SongMemory.calls.includes('restore'));
});

check('every prefs save tells song memory (it works out whether liked/recent songs changed)', () => {
  const t = boot();
  global.SongMemory.calls.length = 0;
  t.app.toggleLike(LIB[0].id);
  assert.ok(global.SongMemory.calls.includes('changed'));
});

check('a failing song memory can never break the player', () => {
  const t = boot({ changed() { throw new Error('boom'); }, restore() { throw new Error('boom'); } });
  assert.strictEqual(t.app.toggleLike(LIB[1].id), true);
  assert.deepStrictEqual(t.app.getLikedIds(), [LIB[1].id]);
});

check('tracks and one track\'s details are readable', () => {
  const t = boot();
  assert.strictEqual(t.app.getTracks().length, 4);
  assert.deepStrictEqual(t.app.getTrackInfo(LIB[2].id), { id: LIB[2].id, title: 'Gamma', artist: 'Art c', album: 'Alb', playlist: 'Rock', durationSec: 100 });
  assert.strictEqual(t.app.getTrackInfo('/nope'), null);
  assert.strictEqual(t.app.getTrackInfo(LIB[3].id).playlist, '', 'a song with no playlist has an empty playlist name');
});

check('liking from Search: toggles, reports the new state, shows in the Liked list, survives a restart', () => {
  const t = boot();
  assert.strictEqual(t.app.isLiked(LIB[0].id), false);
  assert.strictEqual(t.app.toggleLike(LIB[0].id), true);
  assert.strictEqual(t.app.isLiked(LIB[0].id), true);
  assert.strictEqual(t.app.toggleLike(LIB[0].id), false);
  assert.strictEqual(t.app.toggleLike(''), false, 'nothing to like');
  t.app.toggleLike(LIB[1].id);
  const again = launch({ saved: t.savedPrefs(), bluetooth: false });
  again.nativeReady(); again.scanFinished(LIB);
  assert.deepStrictEqual(again.app.getLikedIds(), [LIB[1].id]);
});

check('restoring liked and recent songs from the files: accepted, cleaned, capped at 100, saved', () => {
  const t = boot();
  assert.strictEqual(t.app.setLikedIds([LIB[0].id, 5, LIB[2].id]), true);
  assert.deepStrictEqual(t.app.getLikedIds(), [LIB[0].id, LIB[2].id]);
  const many = Array.from({ length: 150 }, (_, i) => '/s/' + i + '.mp3');
  assert.strictEqual(t.app.setHistoryIds(many), true);
  assert.strictEqual(t.app.getHistoryIds().length, 100);
  assert.strictEqual(t.app.getHistoryIds()[0], '/s/0.mp3');
  assert.strictEqual(t.app.setLikedIds('nope'), false);
  assert.deepStrictEqual(t.savedPrefs().features.likes.ids, [LIB[0].id, LIB[2].id]);
});

check('playing a song from Search starts it in its own playlist, or All songs when it has none', () => {
  const t = boot();
  assert.strictEqual(t.app.playTrack(LIB[2].id), true);
  assert.strictEqual(t.state.currentTrackId, LIB[2].id);
  assert.strictEqual(t.state.activePlaylist, 'Rock');
  assert.strictEqual(t.app.getCurrentTrackId(), LIB[2].id);
  assert.ok(t.state.queue.includes(LIB[2].id) && !t.state.queue.includes(LIB[0].id), 'the queue is that playlist');
  t.app.playTrack(LIB[3].id);
  assert.strictEqual(t.state.activePlaylist, 'all');
  assert.strictEqual(t.app.playTrack('/nope'), false);
});

check('the liked and recent lists are recorded as songs play (for recents.txt)', () => {
  const t = boot();
  t.app.playTrack(LIB[0].id);
  t.app.playTrack(LIB[1].id);
  assert.deepStrictEqual(t.app.getHistoryIds().slice(0, 2), [LIB[1].id, LIB[0].id]);
});

/* ---------------------------------------------------------------- the phone side */
const main = read('app/src/main/java/com/scell/moonlight/MainActivity.kt');
const playback = read('app/src/main/java/com/scell/moonlight/PlaybackService.kt');
const memory = read('app/src/main/assets/song-memory.js');

check('the three text files: same names on the page and on the phone, and nothing else can be read or written', () => {
  assert.ok(/DATA_FILES = setOf\("downloads\.txt", "favorites\.txt", "recents\.txt"\)/.test(main));
  ['downloads.txt', 'favorites.txt', 'recents.txt'].forEach((f) => assert.ok(memory.includes("'" + f + "'"), f));
  assert.ok(/fun readDataFile\(name: String\): String\?[\s\S]*?if \(name !in DATA_FILES\) return null/.test(main));
  assert.ok(/fun writeDataFile\(name: String, text: String\): Boolean[\s\S]*?if \(name !in DATA_FILES\) return false/.test(main));
  assert.ok(/MAX_DATA_BYTES/.test(main));
  assert.ok(/File\(playerRoot, name\)/.test(main), 'always inside the Moonlight folder (name cannot contain a path: it must be in the whitelist)');
});

check('files are written safely: next to the target, then renamed', () => {
  const body = main.slice(main.indexOf('fun writeDataFile'), main.indexOf('fun writeDataFile') + 900);
  assert.ok(/\$name\.tmp/.test(body) && /renameTo\(target\)/.test(body));
});

check('"Don\'t keep this song" can only delete a staged file, and just that song\'s own folder', () => {
  const body = main.slice(main.indexOf('fun discardStagedSong('), main.indexOf('fun discardStagedSong(') + 900);
  assert.ok(/SongDownloader\.isStagedPath\(path\)/.test(body));
  assert.ok(/folder != root/.test(body) && /startsWith\(root\.path \+ File\.separator\)/.test(body));
  assert.ok(/discardStagedSong\(path\)/.test(read('app/src/main/assets/song-download.js')));
});

check('muting the phone no longer makes the app close itself or the playback service stop', () => {
  // The music is paused while the volume is 0 (handleMuteChange); the "nothing playing for 10 minutes"
  // shutdowns must treat that pause as waiting, not idle.
  assert.ok(/PlaybackService\.muteHeldSince = System\.currentTimeMillis\(\)\s*\n\s*controller\.pause\(\)/.test(main), 'set before the pause');
  assert.ok(/PlaybackService\.muteHeldSince = 0L\s*\n\s*controller\?\.play\(\)/.test(main));
  assert.ok(/nativeActive \|\| PlaybackService\.heldByMute\(\)/.test(main), 'the 10 minute app close');
  assert.ok(/\(p == null \|\| !isPlaybackActive\(p\)\) && !heldByMute\(\)/.test(playback), 'the service idle stop');
  assert.ok(/if \(playingNow\) muteHeldSince = 0L/.test(playback));
  assert.ok(/MUTE_HOLD_MS = 3 \* 60 \* 60 \* 1000L/.test(playback), 'but not forever: 3 hours');
});

finish();
