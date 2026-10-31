// Run with: node tests/download-memory.test.js
// The Download tab with song memory: a link downloaded before is flagged (and can be downloaded again
// on purpose), similar names show up while naming, "Don't keep this song" removes just that file, and
// every saved song is written to downloads.txt. Drives the real song-download.js on a fake page.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createNode, findAll, click } = require('./fake-dom');

const ASSETS = path.join(__dirname, '../app/src/main/assets');
const MEM = fs.readFileSync(path.join(ASSETS, 'song-memory.js'), 'utf8');
const DL = fs.readFileSync(path.join(ASSETS, 'song-download.js'), 'utf8');
const SD = require(path.join(ASSETS, 'song-download.js'));
const M = require(path.join(ASSETS, 'song-memory.js'));

let n = 0;
function check(name, fn) { try { fn(); } catch (e) { console.log('FAIL -', name); throw e; } n++; console.log('ok -', name); }

const STAGED = (i, name) => '/storage/emulated/0/Moonlight/Songs/.staging/s_' + i + '/' + name + '.mp3';

/* ---------------------------------------------------------------- the wizard on its own */
check('a placed song is reported with its link, final path and playlist', () => {
  const placed = [];
  const w = SD.createWizard({
    stage() {}, place() {}, cancel() {}, discard() {}, play() {},
    onPlaced(item, finalPath, folder) { placed.push([item.url, item.name, finalPath, folder]); },
  });
  w.start(['https://youtu.be/one']);
  w.report('s1', 'done', STAGED(1, 'Blinding Lights (Official Video)'));
  w.save();
  w.choose('Pop');
  const placeId = 'p2';             // stage jobs and place jobs share one counter
  w.report(placeId, 'done', '/storage/emulated/0/Novel/Audio/Pop/Blinding Lights.mp3');
  assert.deepStrictEqual(placed, [['https://youtu.be/one', 'Blinding Lights (Official Video)', '/storage/emulated/0/Novel/Audio/Pop/Blinding Lights.mp3', 'Pop']]);
});

check('"Don\'t keep this song" deletes only that file and moves on; the next song carries on', () => {
  const discardedOne = [];
  let discardedAll = 0;
  const w = SD.createWizard({ stage() {}, place() {}, cancel() {}, discard() { discardedAll++; }, discardOne(p) { discardedOne.push(p); }, play() {} });
  w.start(['https://youtu.be/a', 'https://youtu.be/b']);
  const discardedAtStart = discardedAll;
  w.report('s1', 'done', STAGED(1, 'First'));
  assert.strictEqual(w.state.step, 'name');
  w.report('s2', 'done', STAGED(2, 'Second'));             // finishes behind the scenes
  assert.strictEqual(w.dropCurrent(), true);
  assert.deepStrictEqual(discardedOne, [STAGED(1, 'First')]);
  assert.strictEqual(discardedAll, discardedAtStart, 'the other staged song is untouched');
  assert.strictEqual(w.state.step, 'name', 'on to the second song, already downloaded');
  assert.strictEqual(w.current().name, 'Second');
  w.dropCurrent();
  assert.strictEqual(w.state.step, 'done');
  assert.strictEqual(w.dropCurrent(), false, 'nothing left to drop');
});

check('dropping is only possible while naming or choosing a playlist', () => {
  const w = SD.createWizard({ stage() {}, place() {}, cancel() {}, discard() {}, discardOne() {}, play() {} });
  w.start(['https://youtu.be/a']);
  assert.strictEqual(w.dropCurrent(), false, 'still downloading');
  w.report('s1', 'done', STAGED(1, 'First'));
  w.save();
  assert.strictEqual(w.state.step, 'playlist');
  assert.strictEqual(w.dropCurrent(), true);
});

/* ---------------------------------------------------------------- the tab on a fake page */
const LIB = [
  { id: '/storage/emulated/0/Novel/Audio/Pop/Blinding Lights.mp3', title: 'Blinding Lights', artist: 'The Weeknd', album: '', playlist: 'Pop', durationSec: 200 },
  { id: '/storage/emulated/0/Novel/Audio/Pop/Starboy.mp3', title: 'Starboy', artist: 'The Weeknd', album: '', playlist: 'Pop', durationSec: 230 },
];

function makePage({ files = {}, clipboard = '', tracks = LIB } = {}) {
  const byId = {};
  ['sp-view-download', 'dl-stage', 'audio-panel'].forEach((id) => { byId[id] = createNode('div'); byId[id].attrs.id = id; });
  byId['audio-panel'].attrs['data-view'] = 'download';
  const bridgeCalls = [];
  const trackMap = new Map(tracks.map((t) => [t.id, t]));
  const sandbox = {
    document: {
      getElementById: (id) => byId[id] || null, activeElement: null,
      createElement: createNode, createElementNS: (ns, tag) => createNode(tag),
      createTextNode: (t) => { const x = createNode('#text'); x._text = t; return x; },
      addEventListener() {}, hidden: false,
    },
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {},
    URL, Date,
    NovelAudio: {
      getTracks: () => tracks,
      getTrackInfo: (id) => (trackMap.has(id) ? trackMap.get(id) : null),
      getLikedIds: () => [], getHistoryIds: () => [], getPlaylists: () => [{ name: 'Pop' }], playAfterRescan: () => Promise.resolve(true),
    },
    AndroidBridge: {
      readClipboard: () => clipboard,
      stageSong: (id, url) => { bridgeCalls.push(['stage', id, url]); return true; },
      placeSong: (id, p, name, folder) => { bridgeCalls.push(['place', id, p, name, folder]); return true; },
      cancelSongDownload: () => bridgeCalls.push(['cancel']), discardStagedSongs: () => bridgeCalls.push(['discardAll']),
      discardStagedSong: (p) => { bridgeCalls.push(['discardOne', p]); return true; },
      getArtwork: () => '',
      readDataFile: (name) => (name in files ? files[name] : ''),
      writeDataFile: (name, text) => { files[name] = text; return true; },
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(MEM, sandbox);
  vm.runInNewContext(DL, sandbox);
  const stage = byId['dl-stage'];
  const buttons = () => findAll(stage, (c) => c.tag === 'button');
  const buttonLabelled = (re) => buttons().find((b) => re.test(b.textContent));
  const staged = () => bridgeCalls.filter((c) => c[0] === 'stage').map((c) => c[2]);
  return {
    sandbox, files, bridgeCalls, stage, buttons, buttonLabelled, staged, wizard: sandbox.SongDownload.wizard,
    text: () => stage.textContent,
    paste(text) { sandbox.AndroidBridge.readClipboard = () => text; click(buttonLabelled(/Click to paste/)); },
    answer(id, status, message) { sandbox.onSongDownloadStatus(id, status, message); },
  };
}

const DOWNLOADED_BEFORE = M.formatDownloadLog([
  { t: new Date(2026, 8, 1, 10, 0).getTime(), name: 'Blinding Lights', playlist: 'Pop', url: 'https://youtu.be/AAAAAAAAAAA', path: LIB[0].id },
  { t: new Date(2026, 8, 2, 10, 0).getTime(), name: 'Deleted Song', playlist: 'Old', url: 'https://youtu.be/BBBBBBBBBBB', path: '/storage/emulated/0/Novel/Audio/Old/Deleted Song.mp3' },
]);

check('a fresh link downloads straight away, as before', () => {
  const p = makePage({});
  p.paste('https://youtu.be/CCCCCCCCCCC');
  assert.deepStrictEqual(p.staged(), ['https://youtu.be/CCCCCCCCCCC']);
  assert.ok(!/Already downloaded/.test(p.text()));
});

check('a link downloaded before is flagged, with its saved name, playlist and that the file is still there', () => {
  const p = makePage({ files: { 'downloads.txt': DOWNLOADED_BEFORE } });
  p.paste('https://www.youtube.com/watch?v=AAAAAAAAAAA&feature=share');     // another way of writing the same link
  assert.deepStrictEqual(p.staged(), [], 'nothing downloads yet');
  const t = p.text();
  assert.ok(/Already downloaded/.test(t));
  assert.ok(/Blinding Lights/.test(t) && /Pop/.test(t) && /2026-09-01/.test(t));
  assert.ok(/Still on your phone/.test(t));
  assert.ok(p.buttonLabelled(/Skip them all/), 'by default nothing is downloaded again');
});

check('"Skip them all" downloads nothing and says why', () => {
  const p = makePage({ files: { 'downloads.txt': DOWNLOADED_BEFORE } });
  p.paste('https://youtu.be/AAAAAAAAAAA');
  click(p.buttonLabelled(/Skip them all/));
  assert.deepStrictEqual(p.staged(), []);
  assert.ok(/Nothing new to download/.test(p.text()));
  assert.ok(p.buttonLabelled(/Click to paste/), 'back on the first step');
});

check('the "Again" switch downloads it anyway, and the button says how many', () => {
  const p = makePage({ files: { 'downloads.txt': DOWNLOADED_BEFORE } });
  p.paste('https://youtu.be/AAAAAAAAAAA');
  const box = findAll(p.stage, (c) => c.tag === 'input')[0];
  box.checked = true;
  box.listeners.change.forEach((f) => f());
  assert.ok(p.buttonLabelled(/Download 1 song/));
  click(p.buttonLabelled(/Download 1 song/));
  assert.deepStrictEqual(p.staged(), ['https://youtu.be/AAAAAAAAAAA']);
});

check('new links in the same paste download as usual; the known one waits for your choice', () => {
  const p = makePage({ files: { 'downloads.txt': DOWNLOADED_BEFORE } });
  p.paste('https://youtu.be/AAAAAAAAAAA\nhttps://youtu.be/CCCCCCCCCCC');
  assert.ok(/1 new link will download/.test(p.text()));
  assert.ok(p.buttonLabelled(/Download 1 song/));
  click(p.buttonLabelled(/Download 1 song/));
  assert.deepStrictEqual(p.staged(), ['https://youtu.be/CCCCCCCCCCC']);
});

check('a downloaded song whose file was deleted since is offered again by default', () => {
  const p = makePage({ files: { 'downloads.txt': DOWNLOADED_BEFORE } });
  p.paste('https://youtu.be/BBBBBBBBBBB');
  assert.ok(/No longer on your phone/.test(p.text()));
  assert.ok(p.buttonLabelled(/Download 1 song/), 'already switched on');
  click(p.buttonLabelled(/Download 1 song/));
  assert.deepStrictEqual(p.staged(), ['https://youtu.be/BBBBBBBBBBB']);
});

check('the same song twice in one paste (written two ways) downloads once', () => {
  const p = makePage({});
  p.paste('https://youtu.be/DDDDDDDDDDD\nhttps://www.youtube.com/watch?v=DDDDDDDDDDD');
  assert.deepStrictEqual(p.staged(), ['https://youtu.be/DDDDDDDDDDD']);
});

check('Cancel on the duplicate screen returns to the first step without downloading', () => {
  const p = makePage({ files: { 'downloads.txt': DOWNLOADED_BEFORE } });
  p.paste('https://youtu.be/AAAAAAAAAAA');
  click(p.buttonLabelled(/Cancel/));
  assert.deepStrictEqual(p.staged(), []);
  assert.ok(p.buttonLabelled(/Click to paste/));
});

check('while naming, a song with the same name already on the phone is flagged, with a way to drop it', () => {
  const p = makePage({});
  p.paste('https://youtu.be/EEEEEEEEEEE');
  p.answer('s1', 'done', STAGED(1, 'Blinding Lights (Official Video)'));
  assert.strictEqual(p.wizard.state.step, 'name');
  const t = p.text();
  assert.ok(/“Blinding Lights” is already in Pop\. Saving adds another copy\./.test(t), t);
  assert.ok(/Same song/.test(t));
  assert.ok(/The Weeknd/.test(t));
  click(p.buttonLabelled(/Don’t keep this song/));
  assert.ok(p.bridgeCalls.some((c) => c[0] === 'discardOne' && c[1] === STAGED(1, 'Blinding Lights (Official Video)')));
  assert.strictEqual(p.wizard.state.step, 'done');
});

check('a merely similar name is listed without the warning', () => {
  const p = makePage({});
  p.paste('https://youtu.be/FFFFFFFFFFF');
  p.answer('s1', 'done', STAGED(1, 'Blinding Lihgts'));
  const t = p.text();
  assert.ok(/Similar songs already here/.test(t));
  assert.ok(/Similar/.test(t) && !/Saving adds another copy/.test(t));
});

check('a name with nothing like it shows nothing extra, and no drop button', () => {
  const p = makePage({});
  p.paste('https://youtu.be/GGGGGGGGGGG');
  p.answer('s1', 'done', STAGED(1, 'Completely Different Tune'));
  assert.ok(!/Similar|already/.test(p.text()));
  assert.ok(!p.buttonLabelled(/Don’t keep/));
});

check('typing another name updates the list', () => {
  const p = makePage({});
  p.paste('https://youtu.be/HHHHHHHHHHH');
  p.answer('s1', 'done', STAGED(1, 'Fresh Name'));
  assert.ok(!/already/.test(p.text()));
  const input = findAll(p.stage, (c) => c.tag === 'input')[0];
  input.value = 'Starboy';
  input.listeners.input.forEach((f) => f());
  assert.ok(/“Starboy” is already in Pop/.test(p.text()));
});

check('a downloaded song whose file is gone still warns about its name (file gone)', () => {
  const p = makePage({ files: { 'downloads.txt': DOWNLOADED_BEFORE } });
  p.paste('https://youtu.be/IIIIIIIIIII');
  p.answer('s1', 'done', STAGED(1, 'Deleted Song'));
  assert.ok(/was downloaded before into Old \(the file is gone\)/.test(p.text()), p.text());
});

check('saving a song writes its link, name, playlist and path to downloads.txt; pasting it again is then flagged', () => {
  const p = makePage({});
  p.paste('https://youtu.be/JJJJJJJJJJJ');
  p.answer('s1', 'done', STAGED(1, 'New Tune'));
  p.wizard.save();
  p.wizard.choose('Pop');
  const place = p.bridgeCalls.find((c) => c[0] === 'place');
  assert.ok(place && place[3] === 'New Tune' && place[4] === 'Pop');
  p.answer(place[1], 'done', '/storage/emulated/0/Novel/Audio/Pop/New Tune.mp3');
  const log = M.parseDownloadLog(p.files['downloads.txt']);
  assert.strictEqual(log.length, 1);
  assert.deepStrictEqual([log[0].name, log[0].playlist, log[0].url, log[0].path],
    ['New Tune', 'Pop', 'https://youtu.be/JJJJJJJJJJJ', '/storage/emulated/0/Novel/Audio/Pop/New Tune.mp3']);
  p.wizard.again();
  p.paste('https://www.youtube.com/watch?v=JJJJJJJJJJJ');
  assert.ok(/Already downloaded/.test(p.text()) && /New Tune/.test(p.text()));
});

console.log(n + ' checks passed');
