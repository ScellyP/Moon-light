// Run with: node tests/spotify-tabs.test.js
// The music panel's four tabs: their order (bottom bar and swiping agree), stepping through them
// from a swipe, and that the page has what the swipe and the bottom bar rely on.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot } = require('./spotify-harness');

const assets = path.join(__dirname, '../app/src/main/assets');
const read = (f) => fs.readFileSync(path.join(assets, f), 'utf8');
let n = 0;
function check(name, fn) { fn(); n++; console.log('ok -', name); }

const ORDER = ['library', 'album', 'search', 'track', 'download'];     // Home, Songs, Search, Now playing, Download

check('stepping through the tabs follows the order of the bottom bar', () => {
  const t = boot();
  window.SpotifyUI.setView('library');
  const seen = [t.view()];
  while (window.SpotifyUI.stepView(1)) seen.push(t.view());
  assert.deepStrictEqual(seen, ORDER);
  const back = [t.view()];
  while (window.SpotifyUI.stepView(-1)) back.push(t.view());
  assert.deepStrictEqual(back, ORDER.slice().reverse());
});

check('past either end nothing happens: the tab stays and nothing is reported as changed', () => {
  const t = boot();
  window.SpotifyUI.setView('library');
  assert.strictEqual(window.SpotifyUI.stepView(-1), false);
  assert.strictEqual(t.view(), 'library');
  window.SpotifyUI.setView('download');
  assert.strictEqual(window.SpotifyUI.stepView(1), false);
  assert.strictEqual(t.view(), 'download');
});

check('stepping works from any tab, including a jump made by tapping the bottom bar', () => {
  const t = boot();
  window.SpotifyUI.setView('track');
  assert.strictEqual(window.SpotifyUI.stepView(-1), true);
  assert.strictEqual(t.view(), 'search');
  window.SpotifyUI.setView('download');
  assert.strictEqual(window.SpotifyUI.stepView(-1), true);
  assert.strictEqual(t.view(), 'track');
});

check('the view panels sit in the same order as the tabs (the slide offset is index * 100%)', () => {
  const html = read('index.html');
  const panels = (html.match(/<section id="sp-view-(\w+)" class="sp-view"/g) || []).map((m) => m.match(/sp-view-(\w+)/)[1]);
  assert.deepStrictEqual(panels, ORDER);
});

check('the bottom bar lists the tabs in that same order, Download last, and each has a view', () => {
  const html = read('index.html');
  const nav = html.slice(html.indexOf('<nav id="sp-nav"'), html.indexOf('</nav>', html.indexOf('<nav id="sp-nav"')));
  const buttons = [...nav.matchAll(/data-sp-view="(\w+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(buttons, ORDER);
  buttons.forEach((v) => assert.ok(html.includes('id="sp-view-' + v + '"'), 'no view for ' + v));
  assert.ok(new RegExp("const VIEWS = \\['library', 'album', 'search', 'track', 'download'\\]").test(read('spotify-ui.js')));
});

check('the bottom bar also shows on Now playing (only the mini player is hidden there)', () => {
  const html = read('index.html');
  assert.ok(!/data-view="track"\] #sp-nav/.test(html), 'a rule still hides the bottom bar on Now playing');
  assert.ok(/data-view="track"\] #sp-mini \{ display: none; \}/.test(html), 'the mini player should hide on Now playing');
});

check('the Download songs button is gone from Home', () => {
  assert.ok(!read('index.html').includes('dl-open-btn'));
  assert.ok(!read('song-download.js').includes('dl-open-btn'));
});

check('swiping the panel follows the finger, switches tabs and no longer closes the panel', () => {
  const js = read('player-app.js');
  const swipe = js.slice(js.indexOf('swipe sideways between the tabs'), js.indexOf('/* ---- Back:'));
  assert.ok(swipe.includes('dragView(dx)') && swipe.includes('releaseView('), 'the swipe must follow the finger and settle on release');
  assert.ok(!swipe.includes('closeAllPanels'), 'the swipe still closes the panel');
  assert.ok(swipe.includes('#audio-playlist-btn'), 'the playlist button keeps its own sideways swipe');
  assert.ok(/\.sp-view \{\s*touch-action: pan-y;/.test(read('index.html')), 'tab pages must leave sideways drags to the swipe');
});

check('dragging a page: it follows the finger only when there is a page that way', () => {
  const t = boot();
  window.SpotifyUI.setView('library');
  assert.strictEqual(window.SpotifyUI.dragView(40), false, 'Home dragged right: nothing (that is the drawer)');
  assert.strictEqual(window.SpotifyUI.dragView(-40), true, 'Home dragged left: the next page follows');
  window.SpotifyUI.releaseView(0, 0);
  window.SpotifyUI.setView('download');
  assert.strictEqual(window.SpotifyUI.dragView(-40), false, 'the last page dragged left: nothing');
  assert.strictEqual(window.SpotifyUI.dragView(40), true);
  window.SpotifyUI.releaseView(0, 0);
  assert.strictEqual(t.view(), 'download');
});

check('letting go: about a third of the width or a quick flick slides on, less slides back', () => {
  const t = boot();
  window.SpotifyUI.setView('album');
  assert.strictEqual(window.SpotifyUI.releaseView(-40, -0.1), false);          // short and slow: back
  assert.strictEqual(t.view(), 'album');
  assert.strictEqual(window.SpotifyUI.releaseView(-118, -0.2), false);         // just under a third of 360
  assert.strictEqual(t.view(), 'album');
  assert.strictEqual(window.SpotifyUI.releaseView(-130, -0.2), true);          // past a third: on
  assert.strictEqual(t.view(), 'search');
  assert.strictEqual(window.SpotifyUI.releaseView(60, 0.9), true);             // a quick flick right: back one
  assert.strictEqual(t.view(), 'album');
  assert.strictEqual(window.SpotifyUI.releaseView(60, -0.9), false);           // flick against the drag: not a flick
  assert.strictEqual(t.view(), 'album');
});

check('letting go past either end stays on the page', () => {
  const t = boot();
  window.SpotifyUI.setView('library');
  assert.strictEqual(window.SpotifyUI.releaseView(300, 1), false);
  assert.strictEqual(t.view(), 'library');
  window.SpotifyUI.setView('download');
  assert.strictEqual(window.SpotifyUI.releaseView(-300, -1), false);
  assert.strictEqual(t.view(), 'download');
});

check('while dragging the slide animation is off, on release it is back on and starts where the finger left it', () => {
  const js = read('spotify-ui.js');
  const drag = js.slice(js.indexOf('function dragView'), js.indexOf('function releaseView'));
  const rel = js.slice(js.indexOf('function releaseView'), js.indexOf('/** The cover picture'));
  assert.ok(drag.includes("transition = 'none'") && drag.includes('translate3d(calc(-'), 'dragView must follow the finger without animating');
  assert.ok(rel.includes("transition = ''") && rel.includes('offsetWidth'), 'releaseView must animate from the dragged position');
});

check('text in the music player cannot be selected, but the fields you type in still can', () => {
  const html = read('index.html');
  assert.ok(/#audio-panel \{ user-select: none; -webkit-user-select: none;/.test(html));
  assert.ok(/#audio-panel input, #audio-panel textarea \{ user-select: text;/.test(html));
});

check('sliding tab navigation: GPU-accelerated horizontal track and clean bottom nav buttons with spNavPop', () => {
  const html = read('index.html');
  const js = read('spotify-ui.js');
  assert.ok(html.includes('id="sp-views-track"'));
  assert.ok(html.includes('spNavPop'));
  assert.ok(html.includes('translate3d'));
  assert.ok(html.includes('.sp-view:not(.is-active)'));
  assert.ok(html.includes('content-visibility: auto'));
  assert.ok(html.includes('.no-transition'));
  assert.ok(js.includes('sp-views-track'));
  assert.strictEqual(html.includes('id="sp-nav-pill"'), false, 'sp-nav-pill removed in favor of classic clean bottom buttons');
});

console.log(n + ' checks passed');
