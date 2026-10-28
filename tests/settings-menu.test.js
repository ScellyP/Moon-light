// Run with: node tests/settings-menu.test.js
// The Settings drawer: the gesture maths, the gesture itself (run on a small fake page), the page
// structure (update controls at the bottom, playback tuning moved in), and the stored switches.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ASSETS = path.join(__dirname, '../app/src/main/assets');
const SRC = fs.readFileSync(path.join(ASSETS, 'settings-menu.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ASSETS, 'index.html'), 'utf8');
const menu = require(path.join(ASSETS, 'settings-menu.js'));

let n = 0;
function check(name, fn) { try { fn(); } catch (e) { console.log('FAIL -', name); throw e; } n++; console.log('ok -', name); }

/* ------------------------------------------------------------------ pure maths */
check('velocity uses only the last ~100 ms, not the whole drag', () => {
  // slow for a long time, then a fast flick at the end
  const samples = [{ x: 0, t: 0 }, { x: 20, t: 400 }, { x: 40, t: 800 }, { x: 100, t: 850 }, { x: 160, t: 900 }];
  assert.ok(menu.velocityOf(samples, 100) > 1, 'the final flick should count: ' + menu.velocityOf(samples, 100));
  assert.strictEqual(menu.velocityOf([{ x: 5, t: 1 }], 100), 0);
  assert.ok(menu.velocityOf([{ x: 100, t: 0 }, { x: 40, t: 60 }], 100) < 0, 'leftwards is negative');
});

check('the gesture only locks once it clearly goes sideways', () => {
  assert.strictEqual(menu.lockAxis(4, 3), null);
  assert.strictEqual(menu.lockAxis(14, 3), 'x');
  assert.strictEqual(menu.lockAxis(3, 16), 'y');
  assert.strictEqual(menu.lockAxis(14, 12), 'y', 'a diagonal is not a sideways swipe');
});

check('a flick decides by its direction, a slow release by the nearer side', () => {
  assert.strictEqual(menu.shouldOpen(0.1, 0.6), true);
  assert.strictEqual(menu.shouldOpen(0.9, -0.6), false);
  assert.strictEqual(menu.shouldOpen(0.6, 0.05), true);
  assert.strictEqual(menu.shouldOpen(0.4, -0.05), false);
});

check('the settle animation stays between 140 and 380 ms', () => {
  assert.strictEqual(menu.settleMs(5, 3), 140);
  assert.strictEqual(menu.settleMs(300, 0.1), 333);   // slow release: steady pace
  assert.strictEqual(menu.settleMs(10000, 0.1), 380);
  assert.ok(menu.settleMs(200, 2) < menu.settleMs(200, 0.4), 'a faster flick settles quicker');
});

/* ------------------------------------------------------------------ the gesture on a fake page */
function makePage(extra) {
  const W = 320;
  const timers = []; let timerId = 0, now = 0;
  const frames = [];
  function el(id) {
    const e = {
      id, style: {}, attrs: {}, listeners: {}, classes: new Set(), parentElement: null,
      offsetWidth: W, scrollWidth: 100, clientWidth: 100, focused: false,
      classList: {
        add: c => e.classes.add(c), remove: c => e.classes.delete(c), contains: c => e.classes.has(c),
        toggle: (c, f) => (f ? e.classes.add(c) : e.classes.delete(c)),
      },
      setAttribute: (k, v) => { e.attrs[k] = String(v); }, removeAttribute: k => { delete e.attrs[k]; },
      getAttribute: k => (k in e.attrs ? e.attrs[k] : null),
      addEventListener: (t, fn) => { (e.listeners[t] = e.listeners[t] || []).push(fn); },
      matches: () => false, focus: () => { e.focused = true; },
      getBoundingClientRect: () => {
        const m = /translate3d\((-?[\d.]+)%/.exec(e.style.transform || '');
        return { left: m ? (parseFloat(m[1]) / 100) * W : -W };
      },
    };
    return e;
  }
  const ids = ['settings-layer', 'settings-drawer', 'settings-scrim', 'settings-btn', 'settings-close', 'audio-panel',
    'sp-view-library', 'set-bt', 'set-sky', 'set-tint'];
  const els = {}; ids.forEach(i => { els[i] = el(i); });
  els['audio-panel'].attrs['data-view'] = 'library';
  els['settings-drawer'].attrs.inert = '';
  els['set-bt'].checked = els['set-sky'].checked = els['set-tint'].checked = true;
  const docListeners = {};
  const body = el('body');
  const stored = { btAutoStart: true, animatedSky: true, coverTint: true };
  const calls = [];
  const sandbox = {
    document: {
      getElementById: id => els[id] || null, body,
      addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
    },
    getComputedStyle: target => ({ overflowX: target.scrollsSideways ? 'auto' : 'visible' }),
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; },
    cancelAnimationFrame: () => {},
    setTimeout: (fn, ms) => { timers.push({ id: ++timerId, at: now + ms, fn }); return timerId; },
    clearTimeout: id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    NovelAudio: {
      getSetting: k => stored[k],
      setSetting: (k, v) => { calls.push(['set', k, v]); stored[k] = v; return true; },
    },
    SpotifyUI: { refreshTint: () => calls.push(['refreshTint']) },
  };
  sandbox.window = sandbox;
  Object.assign(sandbox, extra || {});
  vm.runInNewContext(SRC, sandbox);

  let clock = 1000;
  const page = {
    els, body, sandbox, calls, stored, W,
    frame() { const f = frames.splice(0); f.forEach(fn => fn()); },
    wait(ms) { now += ms; timers.filter(t => t.at <= now).sort((a, b) => a.at - b.at).forEach(t => { timers.splice(timers.indexOf(t), 1); t.fn(); }); },
    settle() { page.frame(); page.wait(500); page.frame(); },
    fire(type, target, x, y, dt) {
      clock += dt === undefined ? 16 : dt;
      const ev = { type, target, pointerId: 1, pointerType: 'touch', button: 0, clientX: x, clientY: y, timeStamp: clock };
      // pointerdown reaches the listener on the element it is attached to (a child bubbles up to Home)
      const inMenu = target.id === 'settings-drawer' || target.id === 'settings-scrim';
      const owner = target.listeners && target.listeners.pointerdown ? target : inMenu ? els['settings-layer'] : els['sp-view-library'];
      const list = (type === 'pointerdown') ? (owner.listeners.pointerdown || []) : (docListeners[type] || []);
      list.forEach(fn => fn(ev));
    },
    // A finger path: down at (x0,y), then moves to each x, `dt` ms apart, then up.
    swipe(target, x0, xs, { y = 300, dy = 0, dt = 16, release = true } = {}) {
      page.fire('pointerdown', target, x0, y, 0);
      xs.forEach((x, i) => { page.fire('pointermove', target, x, y + dy * (i + 1) / xs.length, dt); });
      page.frame();
      if (release) { page.fire('pointerup', target, xs[xs.length - 1], y + dy, dt); page.settle(); }
    },
    isOpen: () => els['settings-layer'].classes.has('is-open'),
  };
  return page;
}
const range = (from, to, steps) => Array.from({ length: steps }, (_, i) => from + ((to - from) * (i + 1)) / steps);

check('the drawer starts closed: hidden, inert, nothing dark', () => {
  const p = makePage();
  assert.strictEqual(p.isOpen(), false);
  assert.ok('inert' in p.els['settings-drawer'].attrs);
  assert.ok(/translate3d\(-100/.test(p.els['settings-drawer'].style.transform));
  assert.strictEqual(parseFloat(p.els['settings-scrim'].style.opacity), 0);
});

check('a slow drag past half-way opens it, and it follows the finger', () => {
  const p = makePage();
  p.fire('pointerdown', p.els['sp-view-library'], 20, 300, 0);
  p.fire('pointermove', p.els['sp-view-library'], 80, 302, 40); p.fire('pointermove', p.els['sp-view-library'], 140, 303, 40); p.frame();
  const mid = p.els['settings-drawer'].getBoundingClientRect().left;
  assert.ok(mid > -p.W && mid < 0, 'the drawer is part-way out: ' + mid);
  assert.ok(parseFloat(p.els['settings-scrim'].style.opacity) > 0, 'the scrim darkens as it opens');
  p.fire('pointermove', p.els['sp-view-library'], 220, 303, 40); p.frame();
  p.fire('pointerup', p.els['sp-view-library'], 220, 303, 300); p.settle();
  assert.strictEqual(p.isOpen(), true);
  assert.ok(!('inert' in p.els['settings-drawer'].attrs));
  assert.ok(/translate3d\(0\.000%/.test(p.els['settings-drawer'].style.transform));
  assert.ok(p.body.classes.has('settings-open'));
  assert.strictEqual(p.els['settings-close'].focused, true);
});

check('a slow drag that stops short springs back closed', () => {
  const p = makePage();
  p.swipe(p.els['sp-view-library'], 20, range(20, 110, 6), { dt: 60 });
  assert.strictEqual(p.isOpen(), false);
  assert.ok('inert' in p.els['settings-drawer'].attrs);
});

check('a short quick flick opens it', () => {
  const p = makePage();
  p.swipe(p.els['sp-view-library'], 100, range(100, 160, 4), { dt: 12 });   // 60 px in ~48 ms
  assert.strictEqual(p.isOpen(), true);
});

check('scrolling the page up or down never opens it', () => {
  const p = makePage();
  p.swipe(p.els['sp-view-library'], 100, range(100, 112, 6), { dy: -220, dt: 16 });
  assert.strictEqual(p.isOpen(), false);
});

check('a swipe to the left on Home leaves it to the tab swiping', () => {
  const p = makePage();
  p.swipe(p.els['sp-view-library'], 250, range(250, 60, 6), { dt: 16 });
  assert.strictEqual(p.isOpen(), false);
});

check('a drag that starts on a sideways-scrolling shelf or a slider is not taken', () => {
  const p = makePage();
  const shelf = { parentElement: null, scrollWidth: 600, clientWidth: 300, scrollsSideways: true, matches: () => false };
  p.swipe(shelf, 20, range(20, 260, 8), { dt: 16 });
  assert.strictEqual(p.isOpen(), false);
  const slider = { parentElement: null, scrollWidth: 100, clientWidth: 100, matches: s => /input/.test(s) };
  p.swipe(slider, 20, range(20, 260, 8), { dt: 16 });
  assert.strictEqual(p.isOpen(), false);
});

check('it only opens from Home', () => {
  const p = makePage();
  p.els['audio-panel'].attrs['data-view'] = 'album';
  p.swipe(p.els['sp-view-library'], 20, range(20, 260, 8), { dt: 16 });
  assert.strictEqual(p.isOpen(), false);
});

check('moves are written once per animation frame, not per pointer event', () => {
  const p = makePage();
  p.fire('pointerdown', p.els['sp-view-library'], 20, 300, 0);
  p.fire('pointermove', p.els['sp-view-library'], 60, 300);   // locks
  p.frame();
  const before = p.els['settings-drawer'].style.transform;
  for (let x = 70; x <= 130; x += 10) p.fire('pointermove', p.els['sp-view-library'], x, 300);
  assert.strictEqual(p.els['settings-drawer'].style.transform, before, 'nothing is written between frames');
  p.frame();
  assert.notStrictEqual(p.els['settings-drawer'].style.transform, before);
});

function opened() {
  const p = makePage();
  p.swipe(p.els['sp-view-library'], 20, range(20, 260, 8), { dt: 16 });
  assert.strictEqual(p.isOpen(), true);
  return p;
}

check('swiping left closes it, a flick or a long drag', () => {
  const p = opened();
  p.swipe(p.els['settings-drawer'], 250, range(250, 190, 4), { dt: 12 });   // short, quick
  assert.strictEqual(p.isOpen(), false);
  const q = opened();
  q.swipe(q.els['settings-drawer'], 250, range(250, 40, 8), { dt: 60 });    // long, slow
  assert.strictEqual(q.isOpen(), false);
});

check('swiping right on an open drawer does nothing, and a slow short pull left springs back', () => {
  const p = opened();
  p.swipe(p.els['settings-drawer'], 100, range(100, 200, 5), { dt: 20 });
  assert.strictEqual(p.isOpen(), true);
  p.swipe(p.els['settings-drawer'], 250, range(250, 200, 5), { dt: 80 });
  assert.strictEqual(p.isOpen(), true);
});

check('tapping the dark area closes it; tapping inside the drawer does not', () => {
  const p = opened();
  p.fire('pointerdown', p.els['settings-drawer'], 100, 300, 0); p.fire('pointerup', p.els['settings-drawer'], 100, 300, 40); p.settle();
  assert.strictEqual(p.isOpen(), true);
  p.fire('pointerdown', p.els['settings-scrim'], 310, 300, 0); p.fire('pointerup', p.els['settings-scrim'], 310, 300, 40); p.settle();
  assert.strictEqual(p.isOpen(), false);
});

check('the menu button and the X open and close it; Back closes it', () => {
  const p = makePage();
  p.els['settings-btn'].listeners.click[0](); p.settle();
  assert.strictEqual(p.isOpen(), true);
  assert.strictEqual(p.sandbox.SettingsMenu.isOpen(), true);
  p.els['settings-close'].listeners.click[0](); p.settle();
  assert.strictEqual(p.isOpen(), false);
  p.sandbox.SettingsMenu.open(); p.settle();
  p.sandbox.SettingsMenu.close(); p.settle();
  assert.strictEqual(p.sandbox.SettingsMenu.isOpen(), false);
});

check('grabbing the drawer while it settles picks it up where it is', () => {
  const p = makePage();
  p.swipe(p.els['sp-view-library'], 100, range(100, 160, 4), { dt: 12, release: false });
  p.fire('pointerup', p.els['sp-view-library'], 160, 300, 12);       // flick: settling open
  p.frame();                                                          // animation under way, timers not done
  p.fire('pointerdown', p.els['settings-drawer'], 150, 300, 0);
  p.fire('pointermove', p.els['settings-drawer'], 90, 300, 16);        // drag back left
  p.fire('pointermove', p.els['settings-drawer'], 20, 300, 16); p.frame();
  p.fire('pointerup', p.els['settings-drawer'], 20, 300, 200); p.settle();
  assert.strictEqual(p.isOpen(), false);
});

check('the switches read the stored value, store changes, and apply them', () => {
  const p = makePage();
  p.els['set-sky'].checked = false; p.els['set-sky'].listeners.change[0]();
  assert.ok(p.calls.some(c => c[0] === 'set' && c[1] === 'animatedSky' && c[2] === false));
  assert.ok(p.body.classes.has('no-sky-motion'));
  p.els['set-sky'].checked = true; p.els['set-sky'].listeners.change[0]();
  assert.ok(!p.body.classes.has('no-sky-motion'));
  p.els['set-bt'].checked = false; p.els['set-bt'].listeners.change[0]();
  assert.strictEqual(p.stored.btAutoStart, false);
  p.els['set-tint'].checked = false; p.els['set-tint'].listeners.change[0]();
  assert.ok(p.calls.some(c => c[0] === 'refreshTint'));
  // a saved "off" shows as off at start-up and is applied
  const q = makePage({ NovelAudio: { getSetting: k => (k === 'animatedSky' ? false : true), setSetting: () => true } });
  assert.strictEqual(q.els['set-sky'].checked, false);
  assert.ok(q.body.classes.has('no-sky-motion'));
});

/* ------------------------------------------------------------------ page structure */
const idList = [...HTML.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
const body = HTML.slice(HTML.indexOf('<body'));
const drawerHtml = body.slice(body.indexOf('id="settings-layer"'), body.indexOf('id="dialog-layer"'));

check('every id in the page is still unique (the moved controls were moved, not copied)', () => {
  const seen = new Set(), dup = [];
  idList.forEach(i => { if (seen.has(i)) dup.push(i); seen.add(i); });
  assert.deepStrictEqual(dup, []);
});

check('Crossfade and Normalise live in the Settings menu, not on Now playing', () => {
  ['audio-xf', 'audio-xf-row', 'audio-rg-mode', 'audio-rg-row', 'audio-xf-value', 'audio-rg-value'].forEach(id => {
    assert.ok(drawerHtml.includes('id="' + id + '"'), id + ' should be in the drawer');
  });
  const nowPlaying = body.slice(body.indexOf('id="sp-settings"'), body.indexOf('id="sp-mini"'));
  assert.ok(!/audio-xf|audio-rg/.test(nowPlaying), 'no copies left on the Now playing screen');
  assert.ok(nowPlaying.includes('id="audio-volume"'), 'Volume stays on Now playing');
});

check('the update controls are at the bottom of the menu and gone from Home', () => {
  const foot = drawerHtml.slice(drawerHtml.indexOf('class="sd-foot"'));
  ['update-bar', 'update-text', 'update-progress', 'update-action', 'update-auto', 'app-version', 'update-check'].forEach(id => {
    assert.ok(foot.includes('id="' + id + '"'), id + ' should be in the footer');
  });
  assert.ok(drawerHtml.indexOf('class="sd-body"') < drawerHtml.indexOf('class="sd-foot"'), 'footer after the settings');
  const home = body.slice(body.indexOf('id="sp-view-library"'), body.indexOf('id="sp-view-album"') > 0 ? body.indexOf('id="sp-view-album"') : undefined);
  assert.ok(!/update-bar|app-version|update-auto/.test(home), 'nothing update-related left on Home');
});

check('the Home top bar has the settings button, and the drawer is closed and inert in the markup', () => {
  assert.ok(/id="settings-btn"/.test(body));
  assert.ok(/<aside id="settings-drawer"[^>]*\binert\b/.test(body));
  assert.ok(/#settings-layer \{[^}]*visibility: hidden/.test(HTML));
});

check('the swipe area keeps vertical scrolling to the browser (touch-action)', () => {
  assert.ok(/#sp-view-library \{ touch-action: pan-y; \}/.test(HTML));
  assert.ok(/\.sp-shelf-row \{ touch-action: pan-x pan-y; \}/.test(HTML));
});

check('the script is loaded after player-app.js and before the updater', () => {
  const order = [...HTML.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  assert.ok(order.indexOf('settings-menu.js') > order.indexOf('player-app.js'));
  assert.ok(order.indexOf('settings-menu.js') < order.indexOf('app-update.js'));
});

check('the update dot belongs to the settings button, and Back closes the menu first', () => {
  assert.ok(/body\.has-update #settings-btn::after/.test(HTML));
  const app = fs.readFileSync(path.join(ASSETS, 'player-app.js'), 'utf8');
  assert.ok(/SettingsMenu\.isOpen\(\)\) \{ window\.SettingsMenu\.close\(\); return true; \}/.test(app));
  const upd = fs.readFileSync(path.join(ASSETS, 'app-update.js'), 'utf8');
  assert.ok(/getElementById\('update-check'\)/.test(upd));
});

/* ------------------------------------------------------------------ stored switches (audio-player.js) */
const { launch } = require('./audio-harness');
const TRACKS = ['/Novel/Audio/a.mp3', '/Novel/Audio/b.mp3'].map((p, i) => ({ id: p, path: p, title: 'S' + i, durationSec: 100, playlist: null }));

check('settings default to on, only accept known names and the right type, and are saved', () => {
  const t = launch({ saved: null, bluetooth: false });
  const api = t.app;
  assert.strictEqual(api.getSetting('btAutoStart'), true);
  assert.strictEqual(api.getSetting('animatedSky'), true);
  assert.strictEqual(api.getSetting('coverTint'), true);
  assert.strictEqual(api.getSetting('nope'), undefined);
  assert.strictEqual(api.setSetting('nope', true), false);
  assert.strictEqual(api.setSetting('coverTint', 'yes'), false);
  assert.strictEqual(api.setSetting('coverTint', false), true);
  assert.strictEqual(t.savedPrefs().features.appSettings.coverTint, false);
  const again = launch({ saved: t.savedPrefs(), bluetooth: false });
  assert.strictEqual(again.app.getSetting('coverTint'), false);
  assert.strictEqual(again.app.getSetting('animatedSky'), true);
});

check('"Play when Bluetooth connects" really gates the auto-start', () => {
  const on = launch({ saved: null, bluetooth: true });
  on.nativeReady(); on.scanFinished(TRACKS);
  assert.strictEqual(on.state.playing, true, 'on: it starts by itself');
  const off = launch({ saved: { features: { appSettings: { btAutoStart: false } } }, bluetooth: true });
  off.nativeReady(); off.scanFinished(TRACKS);
  assert.strictEqual(off.state.playing, false, 'off: it waits for you');
});

check('the settings group is small enough for settings.txt (features blob limit 8192)', () => {
  const t = launch({ saved: null, bluetooth: false });
  t.app.setSetting('coverTint', false);   // forces a save
  assert.ok(JSON.stringify(t.savedPrefs().features.appSettings).length < 200);
});

console.log(n + ' checks passed');
