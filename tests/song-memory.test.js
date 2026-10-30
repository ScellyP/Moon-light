// Run with: node tests/song-memory.test.js
// song-memory.js: link matching, similar names, the three text files and their restore.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_PATH = path.join(__dirname, '../app/src/main/assets/song-memory.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');
const M = require(SRC_PATH);

let n = 0;
function check(name, fn) { try { fn(); } catch (e) { console.log('FAIL -', name); throw e; } n++; console.log('ok -', name); }

/* ---------------------------------------------------------------- links */
check('every way of writing the same YouTube link gives the same key', () => {
  const k = M.normalizeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.strictEqual(k, 'youtube:dQw4w9WgXcQ');
  [
    'https://youtu.be/dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?si=abc123&t=30',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVM',
    'https://m.youtube.com/watch?feature=share&v=dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'HTTPS://WWW.YOUTUBE.COM/watch?v=dQw4w9WgXcQ#t=10',
  ].forEach((u) => assert.strictEqual(M.normalizeUrl(u), k, u));
  assert.notStrictEqual(M.normalizeUrl('https://youtu.be/aaaaaaaaaaa'), k);
});

check('other sites: tracking parameters and a trailing slash do not make a different link', () => {
  const a = M.normalizeUrl('https://soundcloud.com/artist/track');
  assert.strictEqual(M.normalizeUrl('https://www.soundcloud.com/artist/track/?utm_source=x&si=1'), a);
  assert.notStrictEqual(M.normalizeUrl('https://soundcloud.com/artist/other'), a);
  assert.strictEqual(M.normalizeUrl('https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC?si=x'), 'spotify:track:4uLU6hMCjMI75M1A2tKUQC');
  assert.strictEqual(M.normalizeUrl('https://example.com/play?id=7&utm_medium=a'), M.normalizeUrl('https://example.com/play?id=7'));
  assert.notStrictEqual(M.normalizeUrl('https://example.com/play?id=7'), M.normalizeUrl('https://example.com/play?id=8'));
  assert.strictEqual(M.normalizeUrl('not a link'), 'not a link');
});

/* ---------------------------------------------------------------- similar names */
check('the same song name is recognised through noise, case, accents, punctuation and word order', () => {
  assert.strictEqual(M.similarity('Blinding Lights', 'blinding lights'), 1);
  assert.strictEqual(M.similarity('Blinding Lights (Official Video)', 'Blinding Lights'), 1);
  assert.strictEqual(M.similarity('Beyoncé - Halo [Official Audio] HD', 'beyonce halo'), 1);
  assert.ok(M.similarity('The Weeknd - Blinding Lights', 'Blinding Lights - The Weeknd') >= 0.95);
});

check('similar but not the same: typos and one name inside the other', () => {
  const typo = M.similarity('Blinding Lights', 'Blinding Lihgts');
  assert.ok(typo >= 0.6 && typo < 0.95, 'typo ' + typo);
  const inside = M.similarity('Believer', 'Believer Imagine Dragons');
  assert.ok(inside >= 0.7 && inside < 0.95, 'inside ' + inside);
  assert.ok(M.similarity('Blinding Lights', 'Starboy') < 0.4);
  assert.ok(M.similarity('Run', 'Sun') < 0.6, 'short names are not typo-matched');
  assert.strictEqual(M.similarity('', 'x'), 0);
});

check('findSimilar: best first, exact flagged, library before log, limited, short list', () => {
  const lib = [
    { title: 'Starboy', artist: 'The Weeknd', playlist: 'Pop', path: '/a', source: 'library' },
    { title: 'Blinding Lights', artist: 'The Weeknd', playlist: 'Pop', path: '/b', source: 'library' },
    { title: 'Blinding Lihgts', artist: '', playlist: '', path: '/c', source: 'library' },
    { title: 'Blinding Lights', artist: '', playlist: 'Old', path: '/d', source: 'log' },
  ];
  const r = M.findSimilar('Blinding Lights (Official Video)', lib, { limit: 5 });
  assert.deepStrictEqual(r.map((x) => x.path), ['/b', '/d', '/c']);
  assert.ok(r[0].exact && r[1].exact && !r[2].exact);
  assert.strictEqual(M.findSimilar('Blinding Lights', lib, { limit: 1 }).length, 1);
  assert.deepStrictEqual(M.findSimilar('', lib), []);
  // matches "artist title" typed the YouTube way
  assert.ok(M.findSimilar('The Weeknd - Starboy', lib)[0].exact);
});

/* ---------------------------------------------------------------- the text files */
check('downloads.txt: written, read back, comments skipped, odd characters cannot break a line', () => {
  const t = new Date(2026, 9, 28, 16, 42).getTime();
  const text = M.formatDownloadLog([
    { t, name: 'Song\tName\nTwo', playlist: 'Lo-fi', url: 'https://youtu.be/abc', path: '/storage/emulated/0/Novel/Audio/Lo-fi/Song Name Two.mp3' },
    { t, name: 'Other', playlist: '', url: 'https://youtu.be/def', path: '' },
  ]);
  assert.ok(text.startsWith('# Moonlight download log'));
  assert.strictEqual(text.split('\n').filter((l) => l && l[0] !== '#').length, 2);
  const back = M.parseDownloadLog(text);
  assert.strictEqual(back.length, 2);
  assert.strictEqual(back[0].name, 'Song Name Two');
  assert.strictEqual(back[0].playlist, 'Lo-fi');
  assert.strictEqual(back[0].url, 'https://youtu.be/abc');
  assert.strictEqual(back[0].path, '/storage/emulated/0/Novel/Audio/Lo-fi/Song Name Two.mp3');
  assert.strictEqual(back[0].t, t);
  assert.strictEqual(back[0].key, 'youtube:abc');
  assert.strictEqual(back[1].path, '');
  // hand-edited or damaged lines are ignored, not fatal
  assert.strictEqual(M.parseDownloadLog('garbage\n\n# c\n2026-01-01 10:00\tx\ty\tnot a url\tz\n').length, 0);
});

check('favorites.txt / recents.txt: one song per line, details kept, path last', () => {
  const t = new Date(2026, 0, 5, 9, 3).getTime();
  const rows = [
    { t, title: 'Halo', artist: 'Beyoncé', album: 'I Am', playlist: 'Pop', length: '3:45', path: '/x/Pop/Halo.mp3' },
    { t, title: 'Tab\there', artist: '', album: '', playlist: '', length: '', path: '/x/a b.mp3' },
  ];
  const fav = M.formatSongList('favorites', rows);
  const rec = M.formatSongList('recents', rows);
  assert.ok(/favourites/.test(fav.split('\n')[0]) && /recently played/.test(rec.split('\n')[0]));
  const back = M.parseSongList(fav);
  assert.strictEqual(back.length, 2);
  assert.deepStrictEqual(back[0], { t, title: 'Halo', artist: 'Beyoncé', album: 'I Am', playlist: 'Pop', length: '3:45', path: '/x/Pop/Halo.mp3' });
  assert.strictEqual(back[1].title, 'Tab here');
  assert.strictEqual(back[1].path, '/x/a b.mp3');
  assert.strictEqual(M.lengthText(225), '3:45');
  assert.strictEqual(M.lengthText(0), '');
});

/* ---------------------------------------------------------------- the page glue */
function makePage({ files = {}, liked = [], history = [], tracks = [], withBridge = true } = {}) {
  const timers = []; let now = 1;
  const ls = {};
  const written = {};
  const lists = { liked: liked.slice(), history: history.slice() };
  const trackMap = new Map(tracks.map((t) => [t.id, t]));
  const sandbox = {
    document: { addEventListener() {}, hidden: false },
    localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); } },
    setTimeout: (fn, ms) => { timers.push({ fn, at: now + ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    Date, URL,
    NovelAudio: {
      getTracks: () => tracks,
      getTrackInfo: (id) => (trackMap.has(id) ? Object.assign({ album: '', durationSec: 0 }, trackMap.get(id)) : null),
      getLikedIds: () => lists.liked.slice(), getHistoryIds: () => lists.history.slice(),
      setLikedIds: (ids) => { lists.liked = ids.slice(); return true; },
      setHistoryIds: (ids) => { lists.history = ids.slice(); return true; },
    },
  };
  sandbox.window = sandbox;
  if (withBridge) {
    sandbox.AndroidBridge = {
      readDataFile: (name) => (name in files ? files[name] : ''),
      writeDataFile: (name, text) => { files[name] = text; written[name] = (written[name] || 0) + 1; return true; },
    };
  }
  vm.runInNewContext(SRC, sandbox);
  return {
    sm: sandbox.SongMemory, files, written, lists, sandbox, ls,
    wait(ms) { now += ms; timers.filter((t) => t.fn && t.at <= now).forEach((t) => { const f = t.fn; t.fn = null; f(); }); },
  };
}

check('a recorded download is found again by any form of its link, and survives a restart', () => {
  const p = makePage({ tracks: [{ id: '/a/Lo-fi/Song.mp3', title: 'Song', artist: '', playlist: 'Lo-fi' }] });
  assert.strictEqual(p.sm.findDownloaded('https://youtu.be/abc'), null);
  assert.ok(p.sm.recordDownload({ url: 'https://youtu.be/abc', name: 'Song', playlist: 'Lo-fi', path: '/a/Lo-fi/Song.mp3' }));
  assert.ok(/youtu\.be\/abc/.test(p.files['downloads.txt']));
  const hit = p.sm.findDownloaded('https://www.youtube.com/watch?v=abc&feature=share');
  assert.strictEqual(hit.name, 'Song');
  assert.strictEqual(p.sm.isPresent(hit), true);
  // a new launch reads the same file
  const q = makePage({ files: p.files, tracks: [] });
  const again = q.sm.findDownloaded('https://music.youtube.com/watch?v=abc');
  assert.ok(again && again.playlist === 'Lo-fi');
  assert.strictEqual(q.sm.isPresent(again), false, 'the song is not in this library any more');
});

check('downloading the same link again updates its line, it is not listed twice', () => {
  const p = makePage();
  p.sm.recordDownload({ url: 'https://youtu.be/abc', name: 'Song', playlist: 'A', path: '/p.mp3' });
  p.sm.recordDownload({ url: 'https://youtu.be/abc', name: 'Song v2', playlist: 'A', path: '/p.mp3' });
  assert.strictEqual(p.sm.downloadLog().length, 1);
  assert.strictEqual(p.sm.downloadLog()[0].name, 'Song v2');
  assert.strictEqual(p.sm.recordDownload({ url: 'ftp://nope', name: 'x' }), false);
});

check('similar names see the library and songs downloaded before whose file is gone', () => {
  const p = makePage({
    files: { 'downloads.txt': M.formatDownloadLog([
      { t: 1, name: 'Gone Song', playlist: 'Old', url: 'https://youtu.be/g1', path: '/old/Gone Song.mp3' },
      { t: 1, name: 'Here Song', playlist: 'Pop', url: 'https://youtu.be/g2', path: '/a/Here Song.mp3' },
    ]) },
    tracks: [{ id: '/a/Here Song.mp3', title: 'Here Song', artist: 'X', playlist: 'Pop' }],
  });
  const r = p.sm.similarTo('Gone Song (Official Video)');
  assert.strictEqual(r.length, 1);
  assert.ok(r[0].exact && r[0].source === 'log');
  const h = p.sm.similarTo('here song');
  assert.strictEqual(h.length, 1, 'a file that still exists is listed once (as the library song), not twice');
  assert.strictEqual(h[0].source, 'library');
});

check('comparing a name with 5000 songs is quick (the typo check is skipped for names with nothing in common)', () => {
  const words = ['love', 'night', 'fire', 'heart', 'dance', 'rain', 'gold', 'moon', 'blue', 'storm', 'dream', 'road', 'light', 'ocean', 'shadow', 'river', 'summer', 'wild', 'angel', 'time'];
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = () => words[Math.floor(rnd() * words.length)];
  const big = Array.from({ length: 5000 }, (_, i) => ({ title: pick() + ' ' + pick() + ' ' + i, artist: 'Artist ' + (i % 200), playlist: 'L' }));
  M.findSimilar('night rain 1', big);                         // warm up
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) M.findSimilar(pick() + ' ' + pick() + ' ' + (i * 37), big, { limit: 4 });
  const ms = Date.now() - t0;
  assert.ok(ms < 2500, '20 checks took ' + ms + ' ms');
  // and the skip never hides a real typo
  assert.ok(M.findSimilar('Blinding Lihgts', [{ title: 'Blinding Lights', artist: '' }]).length === 1);
  assert.ok(M.findSimilar('Believr', [{ title: 'Believer', artist: '' }]).length === 1);
});

check('nothing is written to favorites/recents before they were read once', () => {
  const p = makePage({ liked: [], history: [] });
  p.sm.changed(); p.wait(2000);
  assert.strictEqual(p.written['favorites.txt'], undefined);
  assert.strictEqual(p.sm._isRestored(), false);
});

check('after a restore, liking a song and playing a song rewrite the two files with details', () => {
  const tracks = [
    { id: '/a/Pop/Halo.mp3', title: 'Halo', artist: 'Beyoncé', playlist: 'Pop', durationSec: 225 },
    { id: '/a/Pop/Starboy.mp3', title: 'Starboy', artist: 'The Weeknd', playlist: 'Pop', durationSec: 230 },
  ];
  const p = makePage({ tracks });
  p.sm.restore(); p.wait(1000);
  assert.ok(p.sm._isRestored());
  assert.ok('favorites.txt' in p.files && 'recents.txt' in p.files, 'the files exist from the first launch on');
  p.lists.liked = ['/a/Pop/Halo.mp3'];
  p.lists.history = ['/a/Pop/Starboy.mp3'];
  p.sm.changed();
  assert.strictEqual(p.written['favorites.txt'], 1, 'debounced: nothing yet');
  p.wait(1000);
  const fav = M.parseSongList(p.files['favorites.txt']);
  assert.strictEqual(fav.length, 1);
  assert.deepStrictEqual([fav[0].title, fav[0].artist, fav[0].playlist, fav[0].length], ['Halo', 'Beyoncé', 'Pop', '3:45']);
  assert.ok(fav[0].t > 0);
  const rec = M.parseSongList(p.files['recents.txt']);
  assert.strictEqual(rec[0].title, 'Starboy');
  // many quick changes = one write
  const before = p.written['favorites.txt'];
  p.lists.liked = ['/a/Pop/Halo.mp3', '/a/Pop/Starboy.mp3']; p.sm.changed();
  p.lists.liked = ['/a/Pop/Starboy.mp3']; p.sm.changed();
  p.wait(1000);
  assert.strictEqual(p.written['favorites.txt'], before + 1);
  assert.strictEqual(M.parseSongList(p.files['favorites.txt']).length, 1);
});

check('a fresh install brings the liked and recent songs back from the files', () => {
  const t = Date.now();
  const files = {
    'favorites.txt': M.formatSongList('favorites', [{ t, title: 'Halo', artist: 'B', album: '', playlist: 'Pop', length: '3:45', path: '/a/Pop/Halo.mp3' }]),
    'recents.txt': M.formatSongList('recents', [
      { t, title: 'Starboy', artist: 'W', album: '', playlist: 'Pop', length: '3:50', path: '/a/Pop/Starboy.mp3' },
      { t, title: 'Halo', artist: 'B', album: '', playlist: 'Pop', length: '3:45', path: '/a/Pop/Halo.mp3' },
    ]),
  };
  const p = makePage({ files, liked: [], history: [] });
  p.sm.restore();
  assert.deepStrictEqual(Array.from(p.lists.liked), ['/a/Pop/Halo.mp3']);
  assert.deepStrictEqual(Array.from(p.lists.history), ['/a/Pop/Starboy.mp3', '/a/Pop/Halo.mp3'], 'order kept: newest first');
});

check('the app\'s own lists win when it has them (the file is rewritten from them)', () => {
  const t = Date.now();
  const files = { 'favorites.txt': M.formatSongList('favorites', [{ t, title: 'Old', artist: '', album: '', playlist: '', length: '', path: '/old.mp3' }]) };
  const p = makePage({ files, liked: ['/mine.mp3'], history: [] });
  p.sm.restore(); p.wait(1000);
  assert.deepStrictEqual(Array.from(p.lists.liked), ['/mine.mp3']);
  assert.deepStrictEqual(M.parseSongList(p.files['favorites.txt']).map((r) => r.path), ['/mine.mp3']);
});

check('a song that is not in the library right now keeps the details the file had', () => {
  const t = Date.now();
  const files = { 'favorites.txt': M.formatSongList('favorites', [{ t, title: 'Away', artist: 'Someone', album: 'LP', playlist: 'Trip', length: '2:00', path: '/sd/Away.mp3' }]) };
  const p = makePage({ files, tracks: [] });
  p.sm.restore(); p.wait(1000);
  const row = M.parseSongList(p.files['favorites.txt'])[0];
  assert.deepStrictEqual([row.title, row.artist, row.album, row.playlist, row.length], ['Away', 'Someone', 'LP', 'Trip', '2:00']);
});

check('without storage access nothing breaks and nothing is lost', () => {
  const files = {};
  const p = makePage({ files });
  p.sandbox.AndroidBridge.readDataFile = () => null;          // no "All files access" yet
  p.sm.recordDownload({ url: 'https://youtu.be/zz', name: 'Z', playlist: '', path: '/z.mp3' });
  assert.ok(p.sm.findDownloaded('https://youtu.be/zz'), 'remembered in memory');
  p.sm.restore();
  assert.strictEqual(p.sm._isRestored(), false, 'will try again after the next scan');
  p.sandbox.AndroidBridge.readDataFile = (name) => (name in files ? files[name] : '');
  p.sm.restore();
  assert.ok(p.sm._isRestored());
  assert.ok(/youtu\.be\/zz/.test(files['downloads.txt']), 'the pending entry reached the file');
});

check('in a plain browser the same text is kept in localStorage', () => {
  const p = makePage({ withBridge: false });
  p.sm.recordDownload({ url: 'https://youtu.be/ls', name: 'LS', playlist: '', path: '/ls.mp3' });
  assert.ok(/youtu\.be\/ls/.test(p.ls['moonlight_file_downloads.txt']));
});

console.log(n + ' checks passed');
