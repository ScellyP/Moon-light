// Run with: node tests/song-search.test.js
// song-search.js: the matching, and the Search tab (run on a small fake page).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createNode, findAll, click: bubbleClick } = require('./fake-dom');

const ASSETS = path.join(__dirname, '../app/src/main/assets');
const SRC = fs.readFileSync(path.join(ASSETS, 'song-search.js'), 'utf8');
const MEM = fs.readFileSync(path.join(ASSETS, 'song-memory.js'), 'utf8');
const S = require(path.join(ASSETS, 'song-search.js'));
const HTML = fs.readFileSync(path.join(ASSETS, 'index.html'), 'utf8');

let n = 0;
function check(name, fn) { try { fn(); } catch (e) { console.log('FAIL -', name); throw e; } n++; console.log('ok -', name); }

const T = (id, title, artist, album, playlist) => ({ id: '/a/' + id + '.mp3', title, artist, album: album || '', playlist: playlist || '' });
const LIB = [
  T('1', 'Blinding Lights', 'The Weeknd', 'After Hours', 'Pop'),
  T('2', 'Starboy', 'The Weeknd', 'Starboy', 'Pop'),
  T('3', 'Halo', 'Beyoncé', 'I Am... Sasha Fierce', 'Pop'),
  T('4', 'Moonlight Sonata', 'Beethoven', '', 'Classical'),
  T('5', 'Weeknd Tribute Mix', 'Various', '', 'Mixes'),
  T('6', 'Lo-fi Rain', '', '', 'Lo-fi Focus'),
  T('7', 'Blinding Rain', 'Someone Else', '', 'Rock'),
];
const PLAYLISTS = [
  { name: 'all', title: 'All songs', count: '7 songs' }, { name: 'Pop', title: 'Pop', count: '3 songs' },
  { name: 'Lo-fi Focus', title: 'Lo-fi Focus', count: '1 song' }, { name: 'Classical', title: 'Classical', count: '1 song' },
];
const search = (q, extra) => S.searchLibrary(q, LIB, Object.assign({ playlists: PLAYLISTS }, extra));
const ids = (r) => r.songs.map((x) => x.track.id.slice(3, 4));

/* ---------------------------------------------------------------- the matching */
check('every typed word must match, in title, artist, album or playlist', () => {
  assert.deepStrictEqual(ids(search('blinding')), ['1', '7']);
  assert.deepStrictEqual(ids(search('blinding weeknd')), ['1']);
  assert.deepStrictEqual(ids(search('weeknd after')), ['1']);
  assert.deepStrictEqual(ids(search('classical')), ['4']);
  assert.deepStrictEqual(ids(search('zzzz')), []);
  assert.deepStrictEqual(search('   ').songs, []);
});

check('capitals, accents and punctuation do not matter', () => {
  assert.deepStrictEqual(ids(search('BEYONCE')), ['3']);
  assert.deepStrictEqual(ids(search('beyoncé halo')), ['3']);
  assert.strictEqual(ids(search('lo fi'))[0], '6');
  assert.deepStrictEqual(ids(search('lofi')), ['6'], 'spaces and hyphens do not matter either');
  assert.deepStrictEqual(ids(search('sasha fierce')), ['3']);
});

check('a small typo is forgiven (from 4 letters), a 3 letter word must be exact', () => {
  assert.deepStrictEqual(ids(search('blindng lights')), ['1']);
  assert.deepStrictEqual(ids(search('beyonse')), ['3']);
  assert.deepStrictEqual(ids(search('hlo')), [], 'too short to guess');
});

check('ranking: title beats artist, start of a word beats the middle, exact beats all', () => {
  const r = search('weeknd');
  assert.strictEqual(r.songs[0].track.id.slice(3, 4), '5', 'the title that starts with it comes first');
  assert.deepStrictEqual(ids(r).slice(1).sort(), ['1', '2']);
  assert.strictEqual(ids(search('halo'))[0], '3');
  const rain = [T('r1', 'Black Rain', 'A'), T('r2', 'Rain Man', 'B'), T('r3', 'Rain', 'C'), T('r4', 'Umbrella', 'Rain Band')];
  const order = S.searchLibrary('rain', rain, {}).songs.map((x) => x.track.title);
  assert.deepStrictEqual(order, ['Rain', 'Rain Man', 'Black Rain', 'Umbrella'], 'exact, then starts-with, then a later word, then only the artist');
  const liked = S.searchLibrary('blinding', LIB, { liked: ['/a/7.mp3'] });
  assert.strictEqual(liked.songs[0].track.id.slice(3, 4), '7', 'between equal matches a liked song comes first');
  const better = S.searchLibrary('blinding lights', LIB, { liked: ['/a/7.mp3'] });
  assert.strictEqual(better.songs[0].track.id.slice(3, 4), '1', 'but a like never beats a better match');
});

check('playlists and artists are found too, artists counted once', () => {
  const r = search('pop');
  assert.deepStrictEqual(r.playlists.map((p) => p.row.name), ['Pop']);
  const a = search('weeknd');
  assert.deepStrictEqual(a.artists.map((x) => [x.name, x.count]), [['The Weeknd', 2]]);
  assert.strictEqual(search('lo fi').playlists[0].row.name, 'Lo-fi Focus');
});

check('the top result: an exact playlist or artist name wins over a looser song', () => {
  assert.strictEqual(search('blinding lights').top.type, 'song');
  assert.strictEqual(search('beethoven').top.type, 'artist');
  assert.strictEqual(search('classical').top.type, 'playlist');
  assert.strictEqual(search('nothing here').top, null);
});

check('highlight marks what was typed, ignoring case and accents', () => {
  const joined = (p) => p.map((x) => (x.hit ? '[' + x.text + ']' : x.text)).join('');
  assert.strictEqual(joined(S.highlight('Blinding Lights', ['blind', 'light'])), '[Blind]ing [Light]s');
  assert.strictEqual(joined(S.highlight('Beyoncé', ['beyonce'])), '[Beyoncé]');
  assert.strictEqual(joined(S.highlight('Starboy', ['zzz'])), 'Starboy');
  assert.strictEqual(joined(S.highlight('', ['a'])), '');
});

check('recent searches: newest first, no repeats, at most 8', () => {
  let list = [];
  ['rain', 'halo', 'Rain ', 'a', 'b', 'c', 'd', 'e', 'f', 'g'].forEach((q) => { list = S.addRecentSearch(list, q, 8); });
  assert.strictEqual(list.length, 8);
  assert.strictEqual(list[0], 'g');
  assert.ok(!list.includes('halo'), 'the oldest dropped off');
  assert.deepStrictEqual(S.addRecentSearch(['x'], '   ', 8), ['x']);
  assert.deepStrictEqual(S.addRecentSearch(['Rain', 'x'], 'rain', 8), ['rain', 'x']);
});

check('5000 songs search in well under a second', () => {
  const big = Array.from({ length: 5000 }, (_, i) => T('b' + i, 'Song number ' + i, 'Artist ' + (i % 300), 'Album ' + (i % 90), 'List ' + (i % 12)));
  const index = S.indexTracks(big);
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) S.searchLibrary('song number 4' + i, big, { index });
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, '20 searches took ' + ms + ' ms');
});

/* ---------------------------------------------------------------- the tab, on a fake page */
function makeDom() {
  const node = createNode;
  const byId = {};
  ['sp-view-search', 'srch-input', 'srch-body', 'srch-clear', 'srch-chips', 'audio-panel'].forEach((id) => { byId[id] = node('div'); byId[id].attrs.id = id; });
  byId['audio-panel'].attrs['data-view'] = 'search';
  ['all', 'songs', 'playlists', 'artists'].forEach((f) => { const b = node('button'); b.attrs['data-srch-filter'] = f; byId['srch-chips'].appendChild(b); });
  const doc = {
    getElementById: (id) => byId[id] || null,
    createElement: node, createElementNS: (ns, tag) => node(tag), createTextNode: (t) => { const x = node('#text'); x._text = t; return x; },
  };
  return { doc, byId, node };
}

function makePage(opts) {
  const o = opts || {};
  const dom = makeDom();
  const calls = [];
  const store = {};
  const liked = new Set(o.liked || []);
  const sandbox = {
    document: dom.doc,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {},
    SongMemoryPure: undefined,
    NovelAudio: {
      getTracks: () => LIB, getLikedIds: () => [...liked], isLiked: (id) => liked.has(id), getCurrentTrackId: () => o.current || null,
      toggleLike: (id) => { if (liked.has(id)) liked.delete(id); else liked.add(id); calls.push(['like', id]); return liked.has(id); },
      playTrack: (id) => { calls.push(['play', id]); return true; },
    },
    SpotifyUI: {
      getPlaylistRows: () => PLAYLISTS, getCover: (name) => (name === 'Pop' ? 'data:image/png;base64,AAAA' : ''),
      openPlaylist: (name) => calls.push(['open', name]),
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(MEM, sandbox);          // defines SongMemoryPure
  vm.runInNewContext(SRC, sandbox);
  const type = (text) => { dom.byId['srch-input'].value = text; (dom.byId['srch-input'].listeners.input || []).forEach((f) => f()); };
  const byClass = (cls) => findAll(dom.byId['srch-body'], (c) => c.classList.contains(cls));
  const click = bubbleClick;
  return { dom, calls, store, type, byClass, click, body: dom.byId['srch-body'], input: dom.byId['srch-input'], sandbox, liked };
}

check('the empty tab shows a tile for each playlist; recent searches appear once there are some', () => {
  const p = makePage();
  assert.strictEqual(p.body.attrs['data-state'], 'empty');
  const tiles = p.byClass('srch-tile');
  assert.strictEqual(tiles.length, PLAYLISTS.length);
  assert.ok(/All songs/.test(tiles[0].textContent));
  assert.ok(tiles[1].attrs['data-sp-cover'], 'a playlist with a cover shows it');
  assert.strictEqual(p.byClass('srch-recent').length, 0);
});

check('typing shows results: a top result, songs with the typed letters highlighted, playlists, artists', () => {
  const p = makePage();
  p.type('weeknd');
  assert.strictEqual(p.body.attrs['data-state'], 'results');
  assert.strictEqual(p.byClass('srch-top').length, 1);
  const rows = p.byClass('srch-row');
  assert.ok(rows.length >= 3, 'songs + artist rows');
  const hits = p.byClass('srch-hit');
  assert.ok(hits.length > 0 && hits.every((h) => h.tag === 'mark'));
  assert.ok(hits.some((h) => h.textContent.toLowerCase() === 'weeknd'));
  assert.strictEqual(p.dom.byId['srch-chips'].hidden, false);
  assert.strictEqual(p.dom.byId['srch-clear'].hidden, false);
});

check('tapping a song plays it and remembers the search', () => {
  const p = makePage();
  p.type('starboy');
  const row = p.byClass('srch-row').find((r) => r.getAttribute('data-id') === '/a/2.mp3');
  p.click(row);
  assert.deepStrictEqual(p.calls[p.calls.length - 1], ['play', '/a/2.mp3']);
  assert.ok(/starboy/.test(p.store.moonlight_recentSearches));
});

check('the heart likes a song without playing it, and shows it', () => {
  const p = makePage();
  p.type('halo');
  const heart = p.byClass('srch-heart')[0];
  p.click(heart);
  assert.deepStrictEqual(p.calls, [['like', '/a/3.mp3']]);
  assert.strictEqual(heart.attrs['aria-pressed'], 'true');
  assert.ok(!p.calls.some((c) => c[0] === 'play'));
});

check('the Songs filter lists only songs; Show all switches to it; the others narrow the same way', () => {
  const p = makePage();
  p.type('s');            // matches many
  const chips = p.dom.byId['srch-chips'].children;
  const chip = (f) => chips.find((c) => c.attrs['data-srch-filter'] === f);
  p.click(chip('playlists'));
  assert.strictEqual(p.byClass('srch-top').length, 0);
  assert.ok(p.byClass('srch-row').every((r) => !r.getAttribute('data-id')), 'no song rows');
  assert.ok(chip('playlists').classList.contains('active'));
  p.click(chip('songs'));
  assert.ok(p.byClass('srch-row').every((r) => r.getAttribute('data-id')), 'only song rows');
});

check('tapping a playlist opens it; tapping an artist searches for their songs', () => {
  const p = makePage();
  p.type('classical');
  const pl = p.byClass('srch-row').find((r) => /Classical/.test(r.textContent) && !r.getAttribute('data-id'));
  p.click(pl);
  assert.deepStrictEqual(p.calls[p.calls.length - 1], ['open', 'Classical']);
  const q = makePage();
  q.type('beethoven');
  const artist = q.byClass('srch-row').find((r) => /Artist •/.test(r.textContent));
  q.click(artist);
  assert.strictEqual(q.input.value, 'Beethoven');
  assert.ok(q.byClass('srch-row').some((r) => r.getAttribute('data-id') === '/a/4.mp3'));
});

check('no results gives a friendly message and no rows', () => {
  const p = makePage();
  p.type('qqqqqq');
  assert.ok(/No results for “qqqqqq”/.test(p.body.textContent));
  assert.strictEqual(p.byClass('srch-row').length, 0);
});

check('recent searches come back in the empty state, can be tapped, removed and cleared', () => {
  const p = makePage();
  p.type('halo'); p.click(p.byClass('srch-row')[0]);        // remembers "halo"
  p.type('');                                               // back to the empty state
  assert.strictEqual(p.body.attrs['data-state'], 'empty');
  const recents = p.byClass('srch-recent');
  assert.strictEqual(recents.length, 1);
  p.click(recents[0]);
  assert.strictEqual(p.input.value, 'halo');
  assert.strictEqual(p.body.attrs['data-state'], 'results');
  p.type('');
  p.click(p.byClass('srch-x')[0]);
  assert.strictEqual(p.byClass('srch-recent').length, 0);
  assert.strictEqual(JSON.parse(p.store.moonlight_recentSearches).length, 0);
});

check('Enter searches, remembers and hides the keyboard; the clear button empties the field', () => {
  const p = makePage();
  p.input.value = 'starboy';
  let prevented = false;
  p.input.listeners.keydown.forEach((f) => f({ key: 'Enter', preventDefault() { prevented = true; } }));
  assert.ok(prevented && p.input.blurred);
  assert.ok(/starboy/.test(p.store.moonlight_recentSearches));
  p.click(p.dom.byId['srch-clear']);
  assert.strictEqual(p.input.value, '');
  assert.strictEqual(p.body.attrs['data-state'], 'empty');
});

check('the song being played is marked', () => {
  const p = makePage({ current: '/a/2.mp3' });
  p.type('starboy');
  assert.ok(p.byClass('srch-row').find((r) => r.getAttribute('data-id') === '/a/2.mp3').classList.contains('playing'));
});

/* ---------------------------------------------------------------- the page structure */
const body = HTML.slice(HTML.indexOf('<body'));

check('the Search tab sits second in the bottom bar and has its view, input and chips', () => {
  const nav = [...body.matchAll(/data-sp-view="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(nav, ['library', 'search', 'album', 'track', 'download']);
  ['sp-view-search', 'srch-input', 'srch-body', 'srch-clear', 'srch-chips'].forEach((id) => assert.ok(body.includes('id="' + id + '"'), id));
  ['all', 'songs', 'playlists', 'artists'].forEach((f) => assert.ok(body.includes('data-srch-filter="' + f + '"'), f));
  assert.ok(/#audio-panel\[data-view="search"\] #sp-view-search/.test(HTML));
  assert.ok(/id="i-history"/.test(HTML));
});

check('the scripts load in an order that works', () => {
  const order = [...HTML.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  const at = (f) => order.indexOf(f);
  assert.ok(at('song-memory.js') > at('audio-player.js') && at('song-memory.js') < at('song-download.js'));
  assert.ok(at('song-search.js') > at('spotify-ui.js') && at('song-search.js') > at('song-memory.js'));
});

console.log(n + ' checks passed');
