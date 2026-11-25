// Run with: node tests/ab-repeat.test.js
// A-B repeat: the loop jumps back right at B even when the next progress report would come too late.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const store = {};
const noop = () => {};
const el = () => new Proxy(function () {}, {
  get: (t, k) => (k === 'style' || k === 'classList' || k === 'dataset') ? el() :
    (k === 'querySelector' || k === 'getElementById') ? () => null :
    (k === 'querySelectorAll') ? () => [] : (k === Symbol.toPrimitive ? () => '' : noop),
  set: () => true,
});
global.window = global;
global.localStorage = {
  getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; },
};
global.document = {
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  createElement: el, createElementNS: el, addEventListener: noop, body: el(), readyState: 'loading',
};
global.Audio = function () { return el(); };
global.navigator = {};
global.requestAnimationFrame = noop;

// fake timers: collected, run by hand
let timers = [];
let nextId = 1;
global.setTimeout = (fn, ms) => { const id = nextId++; timers.push({ id, fn, ms }); return id; };
global.clearTimeout = (id) => { timers = timers.filter((t) => t.id !== id); };

const src = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/audio-player.js'), 'utf8');
new Function(src).call(global);

const NA = window.NovelAudio;
const ab = NA.features.abRepeat;
const state = NA._state;
const engine = NA._modules.AudioEngine;
let seeks = [];
engine.seek = (t) => { seeks.push(t); };

let n = 0;
function check(name, fn) { seeks = []; timers = []; ab.clear(); state.playing = true; fn(); n++; console.log('ok -', name); }

check('a report already past B jumps back to A at once', () => {
  ab.get(); state.features.abRepeat.a = 10; state.features.abRepeat.b = 20;
  ab.progress({ positionSec: 20.2, durationSec: 100 });
  assert.deepStrictEqual(seeks, [10]);
  assert.strictEqual(timers.length, 0);
});

check('B inside the next report: a timer jumps back right at B', () => {
  state.features.abRepeat.a = 10; state.features.abRepeat.b = 20;
  state.positionSec = 19.7;
  ab.progress({ positionSec: 19.7, durationSec: 100 });
  assert.deepStrictEqual(seeks, [], 'no jump yet');
  assert.strictEqual(timers.length, 1);
  assert.ok(timers[0].ms > 200 && timers[0].ms < 300, 'about 0.26 s: ' + timers[0].ms);
  timers[0].fn();
  assert.deepStrictEqual(seeks, [10]);
});

check('B still far away: no timer', () => {
  state.features.abRepeat.a = 10; state.features.abRepeat.b = 20;
  ab.progress({ positionSec: 15, durationSec: 100 });
  assert.strictEqual(timers.length, 0);
});

check('a newer report replaces the pending timer (seek or pause moves it)', () => {
  state.features.abRepeat.a = 10; state.features.abRepeat.b = 20;
  state.positionSec = 19.7;
  ab.progress({ positionSec: 19.7, durationSec: 100 });
  assert.strictEqual(timers.length, 1);
  ab.progress({ positionSec: 12, durationSec: 100 });   // the user seeked away
  assert.strictEqual(timers.length, 0);
});

check('paused or cleared before the timer fires: nothing happens', () => {
  state.features.abRepeat.a = 10; state.features.abRepeat.b = 20;
  state.positionSec = 19.7;
  ab.progress({ positionSec: 19.7, durationSec: 100 });
  const fn = timers[0].fn;
  state.playing = false;
  timers = [];            // a timer that has fired is gone
  fn();
  assert.deepStrictEqual(seeks, []);
  state.playing = true;
  state.features.abRepeat.a = 10; state.features.abRepeat.b = 20;
  ab.progress({ positionSec: 19.7, durationSec: 100 });
  ab.clear();
  assert.strictEqual(timers.length, 0, 'clear() cancels the timer');
});

check('not playing: no timer is set', () => {
  state.playing = false;
  state.features.abRepeat.a = 10; state.features.abRepeat.b = 20;
  ab.progress({ positionSec: 19.7, durationSec: 100 });
  assert.strictEqual(timers.length, 0);
});

console.log(n + ' checks passed');
