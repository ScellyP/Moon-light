// Run with: node tests/playing-order.test.js
// Shuffle changes only the order songs PLAY in. The song list keeps the playlist's own order, and the
// "Playing order" drop-down shows the order they really play in.
const assert = require('assert');
const { launch, check, finish } = require('./audio-harness');

const IDS = Array.from({ length: 12 }, (_, i) => '/Novel/Audio/s' + String(i).padStart(2, '0') + '.mp3');
const TRACKS = IDS.map((p, i) => ({ id: p, path: p, title: 'S' + i, durationSec: 100, playlist: null }));
const boot = (saved) => { const t = launch({ saved, bluetooth: false }); t.nativeReady(); t.scanFinished(TRACKS); return t; };
const queue = (t) => t.app._modules.PlaybackQueue;
const ui = (t) => t.app._modules.AudioUI;
const sameSet = (a, b) => assert.deepStrictEqual(a.slice().sort(), b.slice().sort());

check('shuffle on: the list keeps the playlist order, the playing order is shuffled', () => {
  let differed = false;
  for (let i = 0; i < 20 && !differed; i++) {
    const t = boot({ shuffle: true });
    assert.deepStrictEqual(queue(t).displayOrder(), IDS, 'the list must stay in playlist order');
    sameSet(queue(t).playingOrder(), IDS);                       // same songs...
    if (queue(t).playingOrder().join() !== IDS.join()) differed = true;   // ...in a different order
  }
  assert.ok(differed, 'the playing order never differed from the playlist order');
});

check('shuffle off: the list and the playing order are the same', () => {
  const t = boot({ shuffle: false });
  assert.deepStrictEqual(queue(t).displayOrder(), IDS);
  assert.deepStrictEqual(queue(t).playingOrder(), IDS);
});

check('turning shuffle on and off never reorders the list', () => {
  const t = boot({ shuffle: false });
  queue(t).setShuffle(true);
  assert.deepStrictEqual(queue(t).displayOrder(), IDS);
  queue(t).setShuffle(false);
  assert.deepStrictEqual(queue(t).displayOrder(), IDS);
  assert.deepStrictEqual(t.state.queue, IDS);
});

check('the shuffle button (a new shuffle) and picking a song leave the list order alone', () => {
  const t = boot({ shuffle: false });
  assert.strictEqual(queue(t).startNewShuffle(), true);
  assert.deepStrictEqual(queue(t).displayOrder(), IDS);
  const before = queue(t).playingOrder();
  queue(t).jumpTo(IDS[9]);                                      // pick a song that is still ahead
  assert.deepStrictEqual(queue(t).displayOrder(), IDS);
  sameSet(queue(t).playingOrder(), before);
  assert.strictEqual(queue(t).current(), IDS[9]);
});

check('"Add to queue" with shuffle off still shows where the song will play', () => {
  const t = boot({ shuffle: false });
  queue(t).jumpTo(IDS[0]);
  assert.strictEqual(queue(t).addNext(IDS[7]), true);
  assert.strictEqual(queue(t).displayOrder()[1], IDS[7]);       // shuffle off: the list is the playing order
  assert.strictEqual(queue(t).playingOrder()[1], IDS[7]);
});

check('"Add to queue" with shuffle on: plays next, the list order is unchanged', () => {
  const t = boot({ shuffle: true });
  const cur = queue(t).current();
  const other = IDS.find((id) => id !== cur);
  queue(t).addNext(other);
  assert.strictEqual(queue(t).playingOrder()[t.state.queueIndex + 1], other);
  assert.deepStrictEqual(queue(t).displayOrder().slice(0, IDS.length), IDS);
});

check('the Playing order drop-down draws without errors, closed and open', () => {
  const t = boot({ shuffle: true });
  const u = ui(t);
  u._renderOrder();
  u._orderOpen = true;
  u._orderKey = '';
  u._renderOrder(true);
  assert.strictEqual(u._orderIds.length, IDS.length);
  sameSet(u._orderIds, IDS);
  assert.ok(u._orderDrawn >= IDS.length - 0 || u._orderDrawn === u._orderIds.length);
});

finish();
