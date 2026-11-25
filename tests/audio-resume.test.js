// Run with: node tests/audio-resume.test.js
// Reopening the app while a song is already playing (or paused) in the background player: the app must
// show that song and carry on with it, not start the remembered / first song over it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { launch, check, finish, TRACKS } = require('./audio-harness');

const active = (i, extra) => Object.assign({ active: true, path: TRACKS[i].path, playing: true, positionSec: 42, durationSec: 100 }, extra || {});
const loads = (t) => t.calls.filter((c) => c.startsWith('load') || c === 'play');

check('Bluetooth start-up, library ready, then the running song is reported and the player announced: nothing is started', () => {
  const t = launch({ saved: { lastTrackId: TRACKS[0].id }, bluetooth: true });
  t.scanFinished();
  t.app._nativeOnActive(active(2));        // what MainActivity now reports first
  t.nativeReady();                         // ...then "native player ready"
  assert.deepStrictEqual(loads(t), []);
  assert.strictEqual(t.state.currentTrackId, TRACKS[2].id);
  assert.strictEqual(t.state.playing, true);
  assert.strictEqual(t.state.positionSec, 42);
});

check('the running song is reported before the library scan finished: still nothing is started', () => {
  const t = launch({ saved: { lastTrackId: TRACKS[0].id }, bluetooth: true });
  t.app._nativeOnActive(active(1));
  t.nativeReady();
  t.scanFinished();
  assert.deepStrictEqual(loads(t), []);
  assert.strictEqual(t.state.currentTrackId, TRACKS[1].id);
});

check('a song that was paused in the background is shown as paused and is not started either', () => {
  const t = launch({ saved: { lastTrackId: TRACKS[0].id }, bluetooth: true });
  t.scanFinished();
  t.app._nativeOnActive(active(2, { playing: false, positionSec: 10 }));
  t.nativeReady();
  assert.deepStrictEqual(loads(t), []);
  assert.strictEqual(t.state.currentTrackId, TRACKS[2].id);
  assert.strictEqual(t.state.playing, false);
});

check('with nothing playing in the background, the Bluetooth start-up still plays the remembered song', () => {
  const t = launch({ saved: { lastTrackId: TRACKS[1].id }, bluetooth: true });
  t.nativeReady();
  t.scanFinished();
  assert.ok(loads(t).length > 0, 'the remembered song starts: ' + JSON.stringify(t.calls));
  assert.strictEqual(t.state.currentTrackId, TRACKS[1].id);
});

const NE = (t) => t.app._modules.NativeAudioEngine;
const playing = (t, i) => { t.scanFinished(); t.nativeReady(); t.app._modules.AudioEngine.play(TRACKS[i].id); NE(t)._lastLoadAt = 0; NE(t)._xfGraceUntil = 0; };

check('the page follows the player: the player is on another song for two reports, so that song is shown', () => {
  const t = launch({ saved: null, bluetooth: false });
  playing(t, 0);
  assert.strictEqual(t.state.currentTrackId, TRACKS[0].id);
  NE(t).onProgress(30, 100, TRACKS[1].path);
  assert.strictEqual(t.state.currentTrackId, TRACKS[0].id, 'one report is not enough');
  NE(t).onProgress(30.5, 100, TRACKS[1].path);
  assert.strictEqual(t.state.currentTrackId, TRACKS[1].id, 'the page now shows the song that is really playing');
  assert.strictEqual(t.state.playing, true);
  assert.strictEqual(NE(t)._loadedTrackId, TRACKS[1].id);
});

check('right after the page loaded a song, the old song in a report is ignored', () => {
  const t = launch({ saved: null, bluetooth: false });
  playing(t, 0);
  t.app._modules.AudioEngine.play(TRACKS[2].id);       // the page asks for another song: the player still says the old one
  NE(t).onProgress(10, 100, TRACKS[0].path);
  NE(t).onProgress(10.5, 100, TRACKS[0].path);
  NE(t).onProgress(11, 100, TRACKS[0].path);
  assert.strictEqual(t.state.currentTrackId, TRACKS[2].id);
});

check('a report that matches the shown song changes nothing', () => {
  const t = launch({ saved: null, bluetooth: false });
  playing(t, 1);
  for (let i = 0; i < 4; i++) NE(t).onProgress(5 + i, 100, TRACKS[1].path);
  assert.strictEqual(t.state.currentTrackId, TRACKS[1].id);
});

check('coming back to the app with the same song playing keeps the queue (no reshuffle of what plays next)', () => {
  const t = launch({ saved: { shuffle: true }, bluetooth: false });
  playing(t, 1);
  const q = t.state.queue.slice(); const idx = t.state.queueIndex;
  t.app._nativeOnActive(active(1, { positionSec: 77 }));
  assert.deepStrictEqual(t.state.queue, q);
  assert.strictEqual(t.state.queueIndex, idx);
  assert.strictEqual(t.state.positionSec, 77);
});

check('returning to the app right after the page changed song does not put the old song back', () => {
  const t = launch({ saved: null, bluetooth: false });
  t.scanFinished(); t.nativeReady();
  t.app._modules.AudioEngine.play(TRACKS[0].id);
  t.app._modules.AudioEngine.play(TRACKS[2].id);        // moved on just now
  t.app._nativeOnActive(active(0));                    // the player still reports the previous song for a moment
  assert.strictEqual(t.state.currentTrackId, TRACKS[2].id);
});

check('MainActivity reports the running song before it announces the native player', () => {
  const kt = fs.readFileSync(path.join(__dirname, '../app/src/main/java/com/scell/moonlight/MainActivity.kt'), 'utf8');
  const a = kt.indexOf('syncNativePlaybackState()\n                callPage("onNativeAudioReady")');
  assert.ok(a > 0, 'syncNativePlaybackState() must come right before callPage("onNativeAudioReady")');
  assert.ok(/callPage\("onNativeAudioProgress", "\$posSec, \$durSec, \$playingPath"\)/.test(kt), 'the progress report carries the song the player really has');
});

finish();
