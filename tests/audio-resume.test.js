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

check('MainActivity reports the running song before it announces the native player', () => {
  const kt = fs.readFileSync(path.join(__dirname, '../app/src/main/java/com/scell/moonlight/MainActivity.kt'), 'utf8');
  const a = kt.indexOf('syncNativePlaybackState()\n                callPage("onNativeAudioReady")');
  assert.ok(a > 0, 'syncNativePlaybackState() must come right before callPage("onNativeAudioReady")');
});

finish();
