// Run with: node tests/shuffle-round.test.js
// Shuffle plays every song once (a "round") before any song repeats, remembers the round across app
// launches, never opens a launch with the remembered song, and starts a new random round on repeat all.
const assert = require('assert');
const { launch, check, finish } = require('./audio-harness');

const IDS = Array.from({ length: 8 }, (_, i) => '/Novel/Audio/s' + i + '.mp3');
const TRACKS = IDS.map((p, i) => ({ id: p, path: p, title: 'S' + i, durationSec: 100, playlist: null }));

function boot(saved, extraStore) {
  const t = launch({ saved, bluetooth: false, extraStore });
  t.nativeReady(); t.scanFinished(TRACKS);
  return t;
}
const engine = t => t.app._modules.AudioEngine;
const queue = t => t.app._modules.PlaybackQueue;

check('a shuffled launch does not bring back the last song as the first one', () => {
  const firsts = new Set();
  for (let i = 0; i < 40; i++) {
    const t = boot({ shuffle: true, lastTrackId: IDS[0] });
    firsts.add(t.state.currentTrackId);
    assert.strictEqual(t.state.playing, false);          // ready, not started
  }
  assert.ok(firsts.size > 1, 'always the same first song: ' + [...firsts]);
});

check('without shuffle the last song still comes back', () => {
  const t = boot({ shuffle: false, lastTrackId: IDS[3] });
  assert.strictEqual(t.state.currentTrackId, IDS[3]);
});

check('every song plays once before any repeats (repeat off stops at the end)', () => {
  const t = boot({ shuffle: true });
  const Q = queue(t);
  engine(t).play(t.state.currentTrackId);
  const seen = [t.state.currentTrackId];
  for (let i = 0; i < 20; i++) {
    const next = Q.advance();
    if (!next) break;
    engine(t).play(next);
    seen.push(next);
  }
  assert.strictEqual(seen.length, IDS.length);
  assert.strictEqual(new Set(seen).size, IDS.length);
});

check('repeat all: each round has every song once, and rounds are not the same order', () => {
  const t = boot({ shuffle: true, repeat: 'all' });
  const Q = queue(t);
  engine(t).play(t.state.currentTrackId);
  const seen = [t.state.currentTrackId];
  for (let i = 0; i < IDS.length * 3 - 1; i++) {
    const peek = Q.peekNext();
    const next = Q.advance();
    assert.strictEqual(next, peek, 'peekNext and advance disagree');
    engine(t).play(next);
    seen.push(next);
  }
  for (let r = 0; r < 3; r++) {
    const round = seen.slice(r * IDS.length, (r + 1) * IDS.length);
    assert.strictEqual(new Set(round).size, IDS.length, 'round ' + r + ' repeated a song: ' + round);
  }
  // a new round never opens with the song that just ended
  assert.notStrictEqual(seen[IDS.length], seen[IDS.length - 1]);
  assert.notStrictEqual(seen[IDS.length * 2], seen[IDS.length * 2 - 1]);
});

check('the round survives closing and reopening the app', () => {
  const t = boot({ shuffle: true });
  const Q = queue(t);
  engine(t).play(t.state.currentTrackId);
  const played = [t.state.currentTrackId];
  for (let i = 0; i < 3; i++) { const n = Q.advance(); engine(t).play(n); played.push(n); }
  const saved = t.savedPrefs();
  const round = JSON.parse(t.store.moonlight_shuffleRound);
  assert.strictEqual(round.played.length, played.length);
  // the round is NOT in the audio prefs (those are mirrored to settings.txt, which is size-limited)
  assert.ok(!('shuffleCycle' in saved.features));
  assert.ok(JSON.stringify(saved.features).length < 8192);
  const t2 = boot(saved, { moonlight_shuffleRound: t.store.moonlight_shuffleRound });
  const again = t2.state.currentTrackId;
  assert.ok(!played.includes(again), 'reopened on a song already played this round');
  // and the rest of the round is the songs not played yet
  engine(t2).play(again);
  const rest = [again];
  for (;;) { const n = queue(t2).advance(); if (!n) break; engine(t2).play(n); rest.push(n); }
  assert.deepStrictEqual([...played, ...rest].sort(), IDS.slice().sort());
});

check('picking a song ahead keeps the songs it skips for later in the round', () => {
  const t = boot({ shuffle: true });
  const Q = queue(t);
  engine(t).play(t.state.currentTrackId);
  const pick = t.state.queue[t.state.queue.length - 1];
  engine(t).play(pick);
  const seen = [t.state.queue[0], pick];
  for (;;) { const n = Q.advance(); if (!n) break; engine(t).play(n); seen.push(n); }
  assert.strictEqual(new Set(seen).size, IDS.length);
});

check('turning shuffle on while a song plays keeps that song first', () => {
  const t = boot({ shuffle: false });
  engine(t).play(IDS[4]);
  queue(t).setShuffle(true);
  assert.strictEqual(t.state.queue[t.state.queueIndex], IDS[4]);
  assert.strictEqual(new Set(t.state.queue).size, IDS.length);
});

check('a big library stays quick: look-ups are indexed and scanning 5000 songs is fast', () => {
  const big = Array.from({ length: 5000 }, (_, i) => ({ id: '/Novel/Audio/big' + i + '.mp3', path: '/Novel/Audio/big' + i + '.mp3', title: 'B' + i, durationSec: 100, playlist: null }));
  const t = launch({ saved: { shuffle: true }, bluetooth: false });
  t.nativeReady();
  const started = Date.now();
  t.scanFinished(big);
  for (let i = 0; i < 200; i++) t.app._modules.AudioUI.render();
  const ms = Date.now() - started;
  assert.ok(ms < 1500, 'scan + 200 renders took ' + ms + ' ms');
  assert.strictEqual(t.app._modules.MediaLibrary.getTrack(big[4321].id).title, 'B4321');
  assert.strictEqual(t.app._modules.MediaLibrary.getTrack('/nope'), null);
});

finish();
