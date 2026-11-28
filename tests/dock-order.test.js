// Run with: node tests/dock-order.test.js
// Change dock order: the pop-up (drag to reorder, Done saves and applies, cancel changes nothing),
// the saved setting, the page structure and the wiring.
const assert = require('assert');
const same = (a, b) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b));   // arrays made inside vm are not reference-equal
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ASSETS = path.join(__dirname, '../app/src/main/assets');
const read = (f) => fs.readFileSync(path.join(ASSETS, f), 'utf8');
const HTML = read('index.html');
const SRC = read('dock-order.js');

let n = 0;
function check(name, fn) { fn(); n++; console.log('ok - ' + name); }

/* ---- a small fake page ---- */
function node(tag) {
  const x = {
    tag, children: [], attrs: {}, listeners: {}, parent: null, className: '', style: {}, _text: '', scrollTop: 0,
    classList: {
      add(c) { const s = new Set(x.className.split(/\s+/).filter(Boolean)); s.add(c); x.className = [...s].join(' '); },
      remove(c) { x.className = x.className.split(/\s+/).filter((k) => k && k !== c).join(' '); },
      contains(c) { return x.className.split(/\s+/).includes(c); },
    },
    appendChild(c) { if (c.parent) c.parent.removeChild(c); c.parent = x; x.children.push(c); return c; },
    removeChild(c) { const i = x.children.indexOf(c); if (i >= 0) x.children.splice(i, 1); c.parent = null; return c; },
    insertBefore(c, ref) { if (c.parent) c.parent.removeChild(c); c.parent = x; const i = ref ? x.children.indexOf(ref) : -1; if (i < 0) x.children.push(c); else x.children.splice(i, 0, c); return c; },
    setAttribute(k, v) { x.attrs[k] = String(v); },
    getAttribute(k) { return k in x.attrs ? x.attrs[k] : null; },
    addEventListener(t, f) { (x.listeners[t] = x.listeners[t] || []).push(f); },
    removeEventListener(t, f) { x.listeners[t] = (x.listeners[t] || []).filter((k) => k !== f); },
    getBoundingClientRect() { return { top: 0, bottom: 280 }; },
    querySelector(sel) { return sel === 'span' ? x.span : sel === 'use' ? x.use : null; },
  };
  Object.defineProperty(x, 'textContent', { get() { return x._text; }, set(v) { x._text = v; if (v === '') x.children.forEach((c) => { c.parent = null; }), x.children.length = 0; } });
  return x;
}
function navButton(name, label, icon) {
  const b = node('button');
  b.setAttribute('data-sp-view', name);
  b.span = node('span'); b.span._text = label;
  b.use = node('use'); b.use.setAttribute('href', icon);
  return b;
}

function makePage(savedOrder) {
  const dock = [['library', 'Home', '#sp-home'], ['album', 'Songs', '#i-moon-music'], ['search', 'Search', '#i-search'], ['track', 'Now playing', '#i-headphones'], ['download', 'Download', '#i-download']];
  const buttons = dock.map((d) => navButton(d[0], d[1], d[2]));
  const nav = node('nav'); nav.querySelectorAll = () => buttons;
  const els = { 'sp-nav': nav, 'dock-order-layer': node('div'), 'dock-order-list': node('div'), 'dock-order-btn': node('button'), 'dock-order-close': node('button'), 'dock-order-done': node('button'), 'dock-order-reset': node('button') };
  els['dock-order-layer'].classList.add('hidden');
  const docListeners = {};
  const doc = {
    getElementById: (id) => els[id] || null,
    createElement: (t) => node(t),
    createElementNS: (ns, t) => node(t),
    addEventListener(t, f) { (docListeners[t] = docListeners[t] || []).push(f); },
    removeEventListener(t, f) { docListeners[t] = (docListeners[t] || []).filter((k) => k !== f); },
  };
  const calls = { saved: [], applied: [], toasts: [] };
  const win = {
    document: doc, setTimeout: () => 0,
    NovelAudio: { getSetting: (k) => (k === 'dockOrder' ? savedOrder : undefined), setSetting: (k, v) => { calls.saved.push([k, v]); return true; } },
    SpotifyUI: { setDockOrder: (o) => { calls.applied.push(o.slice()); return o; }, getDockOrder: () => ['library', 'album', 'search', 'track', 'download'], getDefaultDockOrder: () => ['library', 'album', 'search', 'track', 'download'] },
    SongMenu: { toast: (m) => calls.toasts.push(m) },
  };
  win.window = win;
  vm.runInNewContext(SRC, win);
  return { win, els, calls, docListeners };
}
const names = (list) => list.children.map((r) => r.getAttribute('data-name'));
const down = (row, y) => row.children[2].listeners.pointerdown[0]({ clientY: y, pointerId: 1, currentTarget: row.children[2], preventDefault() {} });

check('the saved order is applied at start-up; an empty one is not', () => {
  const a = makePage('search,library,album,track,download');
  same(a.calls.applied, [['search', 'library', 'album', 'track', 'download']]);
  const b = makePage('');
  same(b.calls.applied, []);
});

check('the pop-up lists every dock item by name, in the dock order', () => {
  const p = makePage('');
  p.win.DockOrder.open();
  assert.ok(!p.els['dock-order-layer'].classList.contains('hidden'));
  same(names(p.els['dock-order-list']), ['library', 'album', 'search', 'track', 'download']);
  assert.strictEqual(p.els['dock-order-list'].children[3].children[1]._text, 'Now playing');
});

check('dragging a row down moves it in the list; Done saves and applies the new order', () => {
  const p = makePage('');
  p.win.DockOrder.open();
  const list = p.els['dock-order-list'];
  const row = list.children[0];
  down(row, 10);
  p.docListeners.pointermove[0]({ clientY: 10 + 56 * 2 + 5 });      // two rows and a bit down
  p.docListeners.pointerup[0]();
  same(names(list), ['album', 'search', 'library', 'track', 'download']);
  p.els['dock-order-done'].listeners.click[0]();
  same(p.calls.saved, [['dockOrder', 'album,search,library,track,download']]);
  same(p.calls.applied.pop(), ['album', 'search', 'library', 'track', 'download']);
  assert.ok(p.els['dock-order-layer'].classList.contains('hidden'));
  same(p.calls.toasts, ['Dock order updated']);
});

check('dragging up, and past the ends, keeps the row inside the list', () => {
  const p = makePage('');
  p.win.DockOrder.open();
  const list = p.els['dock-order-list'];
  down(list.children[4], 300);
  p.docListeners.pointermove[0]({ clientY: -500 });
  p.docListeners.pointerup[0]();
  same(names(list), ['download', 'library', 'album', 'search', 'track']);
});

check('cancel (the X, the dark area, Back) saves nothing', () => {
  const p = makePage('');
  p.win.DockOrder.open();
  down(p.els['dock-order-list'].children[0], 0);
  p.docListeners.pointermove[0]({ clientY: 120 });
  p.docListeners.pointerup[0]();
  p.els['dock-order-close'].listeners.click[0]();
  same(p.calls.saved, []);
  assert.ok(!p.win.DockOrder.isOpen());
  p.win.DockOrder.open();
  p.els['dock-order-layer'].listeners.click[0]({ target: p.els['dock-order-layer'] });
  assert.ok(!p.win.DockOrder.isOpen());
  p.win.DockOrder.open();
  p.win.DockOrder.close();
  same(p.calls.saved, []);
});

check('putting the default order back saves an empty value; Reset restores the default in the pop-up', () => {
  const p = makePage('');
  p.win.DockOrder.open();
  const list = p.els['dock-order-list'];
  down(list.children[0], 0);
  p.docListeners.pointermove[0]({ clientY: 60 });
  p.docListeners.pointerup[0]();
  p.els['dock-order-reset'].listeners.click[0]();
  same(names(list), ['library', 'album', 'search', 'track', 'download']);
  p.els['dock-order-done'].listeners.click[0]();
  same(p.calls.saved, [['dockOrder', '']]);
});

check('page structure: setting row, pop-up, script order, back button, saved setting', () => {
  assert.ok(HTML.includes('id="dock-order-btn"') && HTML.includes('id="dock-order-layer"'));
  assert.ok(HTML.includes('id="dock-order-layer" class="hidden dyn-colours"'), 'uses the dynamic colours');
  const order = [...HTML.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(order.indexOf('dock-order.js') > order.indexOf('spotify-ui.js') && order.indexOf('dock-order.js') > order.indexOf('settings-menu.js'));
  assert.ok(/dockOrder: ''/.test(read('audio-player.js')));
  assert.ok(/DockOrder\.isOpen/.test(read('player-app.js')));
  assert.ok(/setDockOrder/.test(read('spotify-ui.js')));
});

console.log('\n' + n + ' checks passed');
