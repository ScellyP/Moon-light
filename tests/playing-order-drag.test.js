// Run with: node tests/playing-order-drag.test.js
// Dragging a row in the "Playing order" menu: the row follows the finger in whole rows, and on drop the queue
// takes the new order, the numbers are redrawn, and the song playing now keeps playing.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/audio-player.js'), 'utf8');
const noop = () => {};

// A tiny real DOM for the pieces the menu touches.
class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.style = { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } }; this.className = ''; this.textContent = ''; this.parentNode = null; this.scrollTop = 0; this.clientHeight = 432; this.scrollHeight = 5000; this.dataset = {}; }
  get classList() {
    const self = this;
    const set = () => new Set(self.className.split(/\s+/).filter(Boolean));
    const put = (s) => { self.className = Array.from(s).join(' '); };
    return {
      add(c) { const s = set(); s.add(c); put(s); }, remove(c) { const s = set(); s.delete(c); put(s); },
      toggle(c, on) { const s = set(); (on === undefined ? !s.has(c) : on) ? s.add(c) : s.delete(c); put(s); return s.has(c); },
      contains(c) { return set().has(c); },
    };
  }
  get childElementCount() { return this.children.length; }
  set innerHTML(v) { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; }
  get innerHTML() { return ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(c) { if (c.parentNode) c.parentNode.children = c.parentNode.children.filter((x) => x !== c); c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    if (c.parentNode) c.parentNode.children = c.parentNode.children.filter((x) => x !== c);
    c.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
  querySelector(sel) {
    const cls = sel.split('.').filter(Boolean);
    const walk = (n) => { for (const c of n.children) { if (cls.every((k) => c.classList.contains(k))) return c; const r = walk(c); if (r) return r; } return null; };
    return walk(this);
  }
  addEventListener() {}
  getBoundingClientRect() { return { top: 0, bottom: 432 }; }
  scrollIntoView() {}
}
const nodes = {};
function fake(id) {
  const base = function () {};
  return new Proxy(base, {
    get: (t, k) => (k === 'style' || k === 'classList' || k === 'dataset') ? fake(k) :
      (k === 'querySelector' || k === 'getElementById') ? () => null : (k === 'querySelectorAll') ? () => [] :
      (k === Symbol.toPrimitive ? () => '' : noop),
    set: () => true,
  });
}
['audio-order', 'audio-order-toggle', 'audio-order-sub', 'audio-order-list'].forEach((id) => { nodes[id] = new Node('div'); });

const IDS = Array.from({ length: 12 }, (_, i) => '/Novel/Audio/s' + String(i).padStart(2, '0') + '.mp3');
const TRACKS = IDS.map((p, i) => ({ id: p, path: p, title: 'S' + i, durationSec: 100, playlist: null }));
const store = {};
global.window = global;
global.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
global.document = {
  getElementById: (id) => nodes[id] || (nodes[id] = fake(id)),
  querySelector: () => null, querySelectorAll: () => [],
  createElement: (tag) => new Node(tag), createElementNS: (ns, tag) => new Node(tag),
  addEventListener: noop, removeEventListener: noop, body: fake('body'), readyState: 'complete',
};
global.Audio = function () { return fake('audio'); };
global.navigator = {};
global.requestAnimationFrame = noop;
global.AndroidBridge = new Proxy({ isBluetoothAudioConnected: () => false }, { get: (t, k) => (k in t ? t[k] : noop) });
new Function(SRC).call(global);
const app = window.NovelAudio;
app.init();
app._switchToNative();
app.onAudioListed(TRACKS);

const state = app._state;
const ui = app._modules.AudioUI;
const q = app._modules.PlaybackQueue;
const list = nodes['audio-order-list'];
let n = 0;
function check(name, fn) { fn(); n++; console.log('ok -', name); }
const rowIds = () => list.children.map((r) => r.getAttribute('data-order-id'));
const nums = () => list.children.map((r) => r.querySelector('.po-num').textContent);

state.shuffle = false; q.setShuffle(true);      // a shuffled queue
ui._orderOpen = true; ui._orderKey = ''; ui._renderOrder(true);

check('open: every song has a numbered row with a drag handle, in the playing order', () => {
  assert.deepStrictEqual(rowIds(), q.playingOrder());
  assert.deepStrictEqual(nums(), IDS.map((_, i) => String(i + 1)));
  assert.ok(list.children.every((r) => r.querySelector('.pe-grip')));
});

check('dragging a row two places down moves it there; the queue and the numbers follow', () => {
  const before = q.playingOrder();
  const cur = q.current();
  const row = list.children[2];
  ui._startOrderDrag(row, { clientY: 300, pointerId: 1, preventDefault: noop }, row.querySelector('.pe-grip'));
  ui._orderDrag.lastY = 300 + 2 * 72 + 10;               // a little over two rows down
  ui._followOrder();
  assert.strictEqual(list.children.indexOf(row), 4, 'the row sits at position 4 while dragging');
  assert.ok(/translateY\(10px\)/.test(row.style.transform), 'the rest of the way is a transform: ' + row.style.transform);
  ui._endOrderDrag();
  const want = before.slice(); const x = want.splice(2, 1)[0]; want.splice(4, 0, x);
  assert.deepStrictEqual(q.playingOrder(), want);
  assert.deepStrictEqual(rowIds(), want);
  assert.deepStrictEqual(nums(), IDS.map((_, i) => String(i + 1)));
  assert.strictEqual(q.current(), cur, 'the song playing now keeps playing');
  assert.strictEqual(row.style.transform, '');
  assert.ok(!row.classList.contains('dragging'));
  assert.deepStrictEqual(q.displayOrder(), IDS, 'the playlist list keeps its own order');
});

check('the "now" mark follows the playing song after a drag', () => {
  const now = list.children.filter((r) => r.classList.contains('now'));
  assert.strictEqual(now.length, 1);
  assert.strictEqual(now[0].getAttribute('data-order-id'), q.current());
});

check('dragging up, and past the ends, stays inside the list', () => {
  const before = q.playingOrder();
  const row = list.children[5];
  ui._startOrderDrag(row, { clientY: 500, pointerId: 1, preventDefault: noop }, row.querySelector('.pe-grip'));
  ui._orderDrag.lastY = 500 - 40 * 72;                     // far above the top
  ui._followOrder();
  assert.strictEqual(list.children.indexOf(row), 0);
  ui._endOrderDrag();
  const want = before.slice(); const x = want.splice(5, 1)[0]; want.unshift(x);
  assert.deepStrictEqual(q.playingOrder(), want);
});

check('a tap on the handle without moving changes nothing', () => {
  const before = q.playingOrder();
  const row = list.children[3];
  ui._startOrderDrag(row, { clientY: 100, pointerId: 1, preventDefault: noop }, row.querySelector('.pe-grip'));
  ui._endOrderDrag();
  assert.deepStrictEqual(q.playingOrder(), before);
});

console.log(n + ' checks passed');
