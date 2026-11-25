// Run with: node tests/duplicates-reflag.test.js
// The duplicate checker must not flag the same songs again at every launch.
const assert = require('assert');
const { launch, check, finish } = require('./audio-harness');

const mk = (n, extra) => Object.assign({ id: '/m/' + n + '.mp3', path: '/m/' + n + '.mp3', title: 'Same Song', artist: 'Same Artist', titleFromTag: true, durationSec: 200, playlist: null, modified: 1000 + n.charCodeAt(0) }, extra || {});
const TRACKS = [mk('a'), mk('b'), mk('c'), mk('z', { title: 'Other', durationSec: 150 })];

function boot(saved) {
  const t = launch({ saved: saved || {}, bluetooth: false });
  global.AndroidBridge.songsMergeDuplicates = () => '[]';
  t.nativeReady();
  t.scanFinished(TRACKS);
  return t;
}
function flagged(t) {
  const lib = t.app._modules.MediaLibrary;
  let seen = null;
  lib.promptDuplicates = (pairs) => { seen = pairs; };
  t.state.scanning = false;
  lib.removeDuplicates();
  return seen ? seen.map((p) => [p.keep, p.drop]) : [];
}

check('three copies are found as two pairs (before anything is ignored)', () => {
  const t = boot();
  assert.strictEqual(flagged(t).length, 2);
});

check('"Keep both" for a group is remembered even when another copy becomes the one to keep', () => {
  const t = boot();
  const lib = t.app._modules.MediaLibrary;
  const first = flagged(t);
  first.forEach(([keep, drop]) => lib.ignoreDuplicatePair(keep, drop));     // the user chose Keep both for each pair
  assert.strictEqual(flagged(t).length, 0, 'nothing flagged right after');
  // Another launch: a like makes a different copy the one to keep.
  const other = TRACKS.map((x) => x.id).find((id) => first.every(([k]) => k !== id));
  t.app.features.likes.toggle ? t.app.features.likes.toggle(other) : t.app.features.likes.like(other);
  assert.strictEqual(flagged(t).length, 0, 'still nothing flagged when the kept copy changed');
});

check('only reviewed copies stay quiet: a new third copy is still flagged', () => {
  const t = boot();
  const lib = t.app._modules.MediaLibrary;
  lib.ignoreDuplicatePair('/m/a.mp3', '/m/b.mp3');      // a and b reviewed, c never
  const f = flagged(t);
  assert.ok(f.length >= 1 && f.every(([k, d]) => d === '/m/c.mp3' || k === '/m/c.mp3'), 'c is still flagged: ' + JSON.stringify(f));
});

check('closing the dialog without choosing keeps the rest (they are remembered)', () => {
  const t = boot();
  const lib = t.app._modules.MediaLibrary;
  lib._dupeQueue = flagged(t).map(([keep, drop]) => ({ keep, drop, keepId: keep, dropId: drop }));
  lib._dupeIndex = 0;
  lib.dismissDuplicateDialog();
  assert.strictEqual(flagged(t).length, 0);
});

check('a song that could not be moved is not asked about again', () => {
  const t = boot();
  const lib = t.app._modules.MediaLibrary;
  const pairs = flagged(t).map(([keep, drop]) => ({ keep, drop, keepId: keep, dropId: drop }));
  lib._dupeQueue = pairs; lib._dupeIndex = 0;
  lib._handleDuplicateChoice(false, true);          // "Move all remaining": the bridge moves nothing
  assert.strictEqual(flagged(t).length, 0);
});

finish();
