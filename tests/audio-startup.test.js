// Run with: node tests/audio-startup.test.js
// Boots audio-player.js with stubbed browser globals and a fake Android bridge, then checks what
// happens at launch: the last song is brought back (not started, from the beginning), and music
// starts by itself only when a Bluetooth audio device is connected.
const assert = require('assert');

const { launch, check, finish, noop, TRACKS } = require('./audio-harness');

check('the last song comes back as the current song, not started, from the start', () => {
  const t = launch({ saved: { lastTrackId: TRACKS[1].id }, bluetooth: false });
  t.nativeReady(); t.scanFinished();
  assert.strictEqual(t.state.currentTrackId, TRACKS[1].id);
  assert.strictEqual(t.state.positionSec, 0);
  assert.strictEqual(t.state.durationSec, 101);
  assert.strictEqual(t.state.playing, false);
  assert.deepStrictEqual(t.calls, []);                    // nothing was loaded or played
});

check('pressing play starts the remembered song from the beginning', () => {
  const t = launch({ saved: { lastTrackId: TRACKS[2].id }, bluetooth: false });
  t.nativeReady(); t.scanFinished();
  t.app._modules.AudioEngine.play();
  assert.deepStrictEqual(t.calls, ['load ' + TRACKS[2].id, 'play']);
  assert.strictEqual(t.state.positionSec, 0);
  assert.strictEqual(t.state.handoffPositionSec, null);
});

check('nothing remembered, or the song is gone from the library: no current song', () => {
  const fresh = launch({ saved: null, bluetooth: false });
  fresh.nativeReady(); fresh.scanFinished();
  assert.strictEqual(fresh.state.currentTrackId, null);
  const gone = launch({ saved: { lastTrackId: '/Novel/Audio/deleted.mp3' }, bluetooth: false });
  gone.nativeReady(); gone.scanFinished();
  assert.strictEqual(gone.state.currentTrackId, null);
  assert.strictEqual(gone.state.lastTrackId, '/Novel/Audio/deleted.mp3');   // kept until something else plays
});

check('a remembered song outside the selected playlist falls back to all songs', () => {
  const t = launch({ saved: { lastTrackId: TRACKS[0].id, activePlaylist: 'Nope' }, bluetooth: false });
  t.nativeReady(); t.scanFinished();
  assert.strictEqual(t.state.currentTrackId, TRACKS[0].id);
  assert.strictEqual(t.state.activePlaylist, 'all');
});

check('the song is saved whenever a track starts, and survives a launch that plays nothing', () => {
  const t = launch({ saved: null, bluetooth: false });
  t.nativeReady(); t.scanFinished();
  t.app._modules.AudioEngine.play(TRACKS[1].id);
  assert.strictEqual(JSON.parse(t.store.novelReader_audioPrefs).lastTrackId, TRACKS[1].id);
  const next = launch({ saved: JSON.parse(t.store.novelReader_audioPrefs), bluetooth: false });
  next.nativeReady(); next.scanFinished();
  next.app._modules.AudioEngine.setVolume(0.5);           // any save, nothing playing
  assert.strictEqual(JSON.parse(next.store.novelReader_audioPrefs).lastTrackId, TRACKS[1].id);
});

check('with Bluetooth connected, the remembered song starts by itself', () => {
  const t = launch({ saved: { lastTrackId: TRACKS[1].id }, bluetooth: true });
  t.scanFinished(); assert.deepStrictEqual(t.calls, []);  // still waiting for the native player
  t.nativeReady();
  assert.deepStrictEqual(t.calls, ['load ' + TRACKS[1].id, 'play']);
  assert.strictEqual(t.state.positionSec, 0);
});

check('with Bluetooth connected and nothing remembered, the first song starts', () => {
  const t = launch({ saved: null, bluetooth: true });
  t.nativeReady(); t.scanFinished();
  assert.deepStrictEqual(t.calls, ['load ' + TRACKS[0].id, 'play']);
});

check('without Bluetooth nothing starts by itself', () => {
  const t = launch({ saved: { lastTrackId: TRACKS[1].id }, bluetooth: false });
  t.nativeReady(); t.scanFinished();
  assert.deepStrictEqual(t.calls, []);
});

check('it happens once per launch: a later rescan or repeat ready signal does not restart it', () => {
  const t = launch({ saved: { lastTrackId: TRACKS[1].id }, bluetooth: true });
  t.nativeReady(); t.scanFinished();
  assert.strictEqual(t.calls.length, 2);
  t.state.playing = false; t.calls.length = 0;
  t.scanFinished(); t.nativeReady();
  assert.deepStrictEqual(t.calls, []);
});

check('an empty library, or a song the user already started, is left alone', () => {
  const empty = launch({ saved: null, bluetooth: true });
  empty.nativeReady(); empty.scanFinished([]);
  empty.scanFinished();                                   // music added and rescanned later
  assert.deepStrictEqual(empty.calls, []);
  // The user already started a song in the page before the native player was ready: the engine
  // switch carries that song over, and the start-up music must not start a second one.
  const busy = launch({ saved: { lastTrackId: TRACKS[1].id }, bluetooth: true });
  busy.scanFinished();
  busy.app._modules.AudioEngine.play(TRACKS[2].id);
  busy.nativeReady();
  assert.deepStrictEqual(busy.calls, ['load ' + TRACKS[2].id, 'play']);
});

check('a bridge without the Bluetooth call (older app build) just does not autoplay', () => {
  const t = launch({ saved: { lastTrackId: TRACKS[1].id }, bluetooth: true });
  window.AndroidBridge = { scanAudioStartup: noop, nativeAudioLoad: p => t.calls.push('load ' + p), nativeAudioPlay: () => t.calls.push('play') };
  t.nativeReady(); t.scanFinished();
  assert.deepStrictEqual(t.calls, []);
  assert.strictEqual(t.state.currentTrackId, TRACKS[1].id);   // the song still comes back
});

check('active background playback is preserved on reopen instead of starting a new song', () => {
  const t = launch({ saved: { lastTrackId: TRACKS[0].id }, bluetooth: true });
  window.onNativeAudioActive({ active: true, path: TRACKS[2].path, playing: true, positionSec: 42.5, durationSec: 102 });
  t.nativeReady(); t.scanFinished();
  assert.strictEqual(t.state.currentTrackId, TRACKS[2].id);
  assert.strictEqual(t.state.playing, true);
  assert.strictEqual(t.state.positionSec, 42.5);
  assert.strictEqual(t.state.durationSec, 102);
  assert.deepStrictEqual(t.calls, []); // does not start or load a new song
});

check('active background playback reported after scan syncs immediately', () => {
  const t = launch({ saved: { lastTrackId: TRACKS[0].id }, bluetooth: false });
  t.nativeReady(); t.scanFinished();
  window.onNativeAudioActive({ active: true, path: TRACKS[1].path, playing: true, positionSec: 15, durationSec: 101 });
  assert.strictEqual(t.state.currentTrackId, TRACKS[1].id);
  assert.strictEqual(t.state.playing, true);
  assert.strictEqual(t.state.positionSec, 15);
});

check('autoplay blacklist prevents blacklisted playlist from starting on Bluetooth connect', () => {
  const sleepTracks = [
    { id: '/Novel/Audio/s1.mp3', path: '/Novel/Audio/s1.mp3', title: 'Sleep 1', durationSec: 100, playlist: 'Sleep', playlists: ['Sleep'] },
  ];
  const t = launch({ saved: { lastTrackId: sleepTracks[0].id, activePlaylist: 'Sleep' }, bluetooth: true });
  t.app.toggleAutoplayBlacklist('Sleep');
  assert.strictEqual(t.app.isPlaylistAutoplayBlacklisted('Sleep'), true);
  t.nativeReady(); t.scanFinished(sleepTracks);
  assert.deepStrictEqual(t.calls, []); // blocked by blacklist!
});

finish();
