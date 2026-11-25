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

check('dragging songs in the Playing order changes the order they play in, the current song keeps playing', () => {
  const t = boot({ shuffle: true });
  const q = queue(t);
  const cur = q.current();
  const order = q.playingOrder();
  const moved = order.slice();
  const x = moved.splice(moved.length - 1, 1)[0];       // last song moves to the front
  moved.unshift(x);
  assert.strictEqual(q.setQueueOrder(moved), true);
  assert.deepStrictEqual(q.playingOrder(), moved);
  assert.strictEqual(q.current(), cur, 'the song playing now is still the current one');
  assert.strictEqual(t.state.queue[t.state.queueIndex], cur);
  assert.deepStrictEqual(q.displayOrder(), IDS, 'the list keeps the playlist order');
});

check('a song dragged up to play next is the one that plays next', () => {
  const t = boot({ shuffle: true });
  const q = queue(t);
  const order = q.playingOrder();
  const i = t.state.queueIndex;
  const far = order[order.length - 1];
  const moved = order.slice(0, order.length - 1);
  moved.splice(i + 1, 0, far);
  assert.strictEqual(q.setQueueOrder(moved), true);
  assert.strictEqual(t.state.queue[t.state.queueIndex + 1], far);
});

check('an order with other songs, missing songs or a wrong length is refused and nothing changes', () => {
  const t = boot({ shuffle: true });
  const q = queue(t);
  const before = q.playingOrder();
  assert.strictEqual(q.setQueueOrder(before.slice(1)), false);
  assert.strictEqual(q.setQueueOrder(before.slice(1).concat(['/Novel/Audio/other.mp3'])), false);
  assert.strictEqual(q.setQueueOrder(null), false);
  assert.deepStrictEqual(q.playingOrder(), before);
});

check('the Playing order is a screen opened from the Now playing "..." menu, not a drop-down in the Songs view', () => {
  const fs = require('fs'); const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/index.html'), 'utf8');
  const sheet = html.slice(html.indexOf('id="sp-sheet"'), html.indexOf('id="sp-sheet"') + 6000);
  assert.ok(/class="sp-song-only" data-sp-act="playorder">[\s\S]*?Current playback order/.test(sheet), 'a "Current playback order" option in the Now playing menu');
  assert.ok(!html.includes('audio-order-toggle'), 'the drop-down header is gone');
  const songs = html.slice(html.indexOf('id="sp-view-album"'), html.indexOf('id="sp-view-track"'));
  assert.ok(!songs.includes('audio-order'), 'nothing of it is left in the Songs view');
  assert.ok(/id="audio-order" class="dyn-colours hidden"/.test(html) && html.includes('id="audio-order-back"'), 'the screen with a back arrow');
});

check('opening and closing the screen from the menu and with Back', () => {
  const t = boot({ shuffle: true });
  const na = t.app;
  assert.strictEqual(na.isPlayingOrderOpen(), false);
  assert.strictEqual(na.openPlayingOrder(), true);
  assert.strictEqual(na.isPlayingOrderOpen(), true);
  assert.strictEqual(ui(t)._orderIds.length, IDS.length);
  na.closePlayingOrder();
  assert.strictEqual(na.isPlayingOrderOpen(), false);
  const js = require('fs').readFileSync(require('path').join(__dirname, '../app/src/main/assets/player-app.js'), 'utf8');
  assert.ok(js.indexOf('isPlayingOrderOpen') < js.indexOf('PlaylistEditor.isOpen()'), 'Back closes it first');
});

finish();
