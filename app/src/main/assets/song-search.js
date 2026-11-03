/* =========================================================================
   Moonlight — Search (a Spotify-style search over your own library)

   Type in the box and the results appear as you type: a "Top result", then Songs, Playlists and
   Artists, with the letters you typed highlighted. Filter chips (All / Songs / Playlists / Artists)
   narrow it down. With nothing typed it shows your recent searches, category tiles made from your own
   library (Artists, Albums, Genres, Liked songs, All songs), a "From your library" rail and a "Browse all"
   grid of your playlists.

   The matching works on every word you type: a song must match ALL of them, in its title, any credited
   artist (also the ones only in the "artist; artist" tag and the album artist), album, genre or playlist name (accents and capitals do not matter; a small typo is forgiven). Matches at
   the start of a word beat matches in the middle; the title counts most.

   The first half is pure (the tests run it); the second half builds the tab.
   ========================================================================= */
(function (root) {
  'use strict';

  const Pure = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('./song-memory.js')
    : root.SongMemoryPure;
  if (!Pure) return;
  const normalizeText = Pure.normalizeText;
  const levenshtein = Pure.levenshtein;

  /* ======================================================================
     Pure search
     ====================================================================== */

  // What a match in each field is worth: at the start of a word / inside a word / a typo.
  const W_TITLE = { start: 100, contain: 60, fuzzy: 35 };
  const W_ARTIST = { start: 70, contain: 45, fuzzy: 25 };
  const W_ALBUM = { start: 50, contain: 30, fuzzy: 15 };
  const W_LIST = { start: 40, contain: 25, fuzzy: 10 };
  const W_GENRE = { start: 40, contain: 25, fuzzy: 10 };

  function field(text) {
    const n = normalizeText(text);
    // c: the same without spaces, so "lofi" finds "Lo-fi" and "hiphop" finds "Hip Hop".
    return { n: n, words: n ? n.split(' ') : [], c: n.replace(/ /g, '') };
  }

  function typoLimit(len) { return len >= 8 ? 2 : len >= 4 ? 1 : 0; }

  function fieldScore(token, f, w) {
    if (!f.n) return 0;
    let best = 0;
    for (let i = 0; i < f.words.length; i++) {
      const word = f.words[i];
      if (word === token) { best = Math.max(best, w.start + 10); }
      else if (word.indexOf(token) === 0) { best = Math.max(best, w.start); }
    }
    if (!best && f.n.indexOf(token) !== -1) best = w.contain;
    if (!best && token.length >= 4 && f.c.indexOf(token) !== -1) best = w.contain - 5;
    if (!best) {
      const limit = typoLimit(token.length);
      if (limit) {
        for (let i = 0; i < f.words.length; i++) {
          const word = f.words[i];
          if (Math.abs(word.length - token.length) > limit) continue;
          if (levenshtein(token, word) <= limit) { best = w.fuzzy; break; }
        }
      }
    }
    return best;
  }

  // One entry per track, worked out once (normalising thousands of names on every key press would lag).
  // Every artist a song credits, one entry per distinct person: the artists list the scan builds (it splits
  // "A; B" and adds the album artist), else the artist tag as written. Shown spelling = the first one seen.
  function creditedArtists(t) {
    const seen = new Map();
    const add = (name) => {
      const shown = String(name || '').trim();
      const key = normalizeText(shown);
      if (key && !seen.has(key)) seen.set(key, shown);
    };
    if (Array.isArray(t.artists) && t.artists.length) t.artists.forEach(add);
    else add(t.artist);
    add(t.albumArtist);
    return Array.from(seen.values());
  }

  function indexTracks(tracks) {
    return (tracks || []).map((t) => {
      const names = creditedArtists(t);
      return {
        track: t, title: field(t.title), artist: field(t.artist), album: field(t.album), list: field(t.playlist),
        genre: field(t.genre),
        // all credited artists in one field, so a search for any of them finds the song
        artistAll: field(names.join(' ') + ' ' + (t.artist || '')),
        names: names.map((n) => ({ shown: n, f: field(n) })),
      };
    });
  }

  /* Searches the library.
       query      what was typed
       tracks     [{ id, title, artist, album, playlist }]
       opts.playlists  [{ name, title, count }]   (folders, your own lists, Liked ...)
       opts.liked      ids of liked songs (a tiny boost)
       opts.index      a result of indexTracks(tracks), to reuse between key presses
     Returns { tokens, songs: [{ track, score }], playlists: [{ row, score }],
               artists: [{ name, count, score }], top: { type, item } | null } */
  function searchLibrary(query, tracks, opts) {
    const o = opts || {};
    const q = normalizeText(query);
    const tokens = q ? q.split(' ') : [];
    const result = { tokens: tokens, songs: [], playlists: [], artists: [], albums: [], genres: [], top: null };
    if (!tokens.length) return result;

    const liked = new Set(o.liked || []);
    const index = o.index || indexTracks(tracks);

    index.forEach((e) => {
      let total = 0;
      for (let i = 0; i < tokens.length; i++) {
        const s = Math.max(
          fieldScore(tokens[i], e.title, W_TITLE), fieldScore(tokens[i], e.artist, W_ARTIST),
          fieldScore(tokens[i], e.artistAll, W_ARTIST), fieldScore(tokens[i], e.genre, W_GENRE),
          fieldScore(tokens[i], e.album, W_ALBUM), fieldScore(tokens[i], e.list, W_LIST));
        if (!s) return;                      // every word must match somewhere
        total += s;
      }
      if (e.title.n === q) total += 300;
      else if (e.title.n.indexOf(q) === 0) total += 150;
      else if (e.title.n.indexOf(q) !== -1) total += 70;
      if (e.artist.n && e.artist.n === q) total += 120;
      if (liked.has(e.track.id)) total += 6;
      result.songs.push({ track: e.track, score: total });
    });
    result.songs.sort((a, b) => (b.score - a.score) || String(a.track.title).localeCompare(String(b.track.title)));

    (o.playlists || []).forEach((row) => {
      const f = field(row.title || row.name);
      let total = 0;
      for (let i = 0; i < tokens.length; i++) {
        const s = fieldScore(tokens[i], f, W_TITLE);
        if (!s) return;
        total += s;
      }
      if (f.n === q) total += 250;
      result.playlists.push({ row: row, score: total });
    });
    result.playlists.sort((a, b) => b.score - a.score);

    // Artists: one entry per distinct person (the spelling most songs use). A song credited to "A; B" counts
    // for both, so searching either name lists them.
    const byArtist = new Map();
    index.forEach((e) => {
      e.names.forEach((nm) => {
        if (!nm.f.n) return;
        let a = byArtist.get(nm.f.n);
        if (!a) { a = { f: nm.f, names: new Map(), count: 0 }; byArtist.set(nm.f.n, a); }
        a.count++;
        a.names.set(nm.shown, (a.names.get(nm.shown) || 0) + 1);
      });
    });
    byArtist.forEach((a) => {
      let total = 0;
      for (let i = 0; i < tokens.length; i++) {
        const s = fieldScore(tokens[i], a.f, W_TITLE);
        if (!s) return;
        total += s;
      }
      if (a.f.n === q) total += 250;
      let name = '', best = 0;
      a.names.forEach((n, shown) => { if (n > best) { best = n; name = shown; } });
      result.artists.push({ name: name, count: a.count, score: total });
    });
    result.artists.sort((a, b) => (b.score - a.score) || (b.count - a.count));

    // Albums and genres of your own library, matched on their name.
    collections(index).albums.forEach((al) => {
      let total = 0;
      for (let i = 0; i < tokens.length; i++) {
        const s = fieldScore(tokens[i], al.f, W_TITLE);
        if (!s) return;
        total += s;
      }
      if (al.f.n === q) total += 250;
      result.albums.push({ name: al.name, artist: al.artist, count: al.count, first: al.first, score: total });
    });
    result.albums.sort((a, b) => (b.score - a.score) || (b.count - a.count));
    collections(index).genres.forEach((g) => {
      let total = 0;
      for (let i = 0; i < tokens.length; i++) {
        const s = fieldScore(tokens[i], g.f, W_TITLE);
        if (!s) return;
        total += s;
      }
      if (g.f.n === q) total += 250;
      result.genres.push({ name: g.name, count: g.count, score: total });
    });
    result.genres.sort((a, b) => (b.score - a.score) || (b.count - a.count));

    // The top result: the best match of any kind. A playlist or artist named exactly as typed wins.
    const best = [];
    if (result.songs[0]) best.push({ type: 'song', item: result.songs[0].track, score: result.songs[0].score });
    if (result.playlists[0]) best.push({ type: 'playlist', item: result.playlists[0].row, score: result.playlists[0].score });
    if (result.artists[0]) best.push({ type: 'artist', item: result.artists[0], score: result.artists[0].score });
    best.sort((a, b) => b.score - a.score);
    result.top = best[0] ? { type: best[0].type, item: best[0].item } : null;
    return result;
  }

  /* The albums and genres of the library, grouped from an index (worked out once per index).
       albums: [{ name, artist, count, first (a track of it), f }]   genres: [{ name, count, f }]
     A song with no album tag is in no album, one with no genre in no genre: nothing is made up. */
  const collectionsCache = new WeakMap();
  function collections(index) {
    let c = collectionsCache.get(index);
    if (c) return c;
    const albums = new Map();
    const genres = new Map();
    index.forEach((e) => {
      const t = e.track;
      if (e.album.n) {
        let a = albums.get(e.album.n);
        if (!a) {
          a = { name: String(t.album).trim(), artist: String(t.albumArtist || t.artist || '').trim(), count: 0, first: t, f: e.album };
          albums.set(e.album.n, a);
        }
        a.count++;
      }
      if (e.genre.n) {
        let g = genres.get(e.genre.n);
        if (!g) { g = { name: String(t.genre).trim(), count: 0, f: e.genre }; genres.set(e.genre.n, g); }
        g.count++;
      }
    });
    c = { albums: Array.from(albums.values()), genres: Array.from(genres.values()) };
    collectionsCache.set(index, c);
    return c;
  }

  // The songs of one album / genre (by name, ignoring capitals and accents), in the order of the library.
  function collectionTracks(index, kind, name) {
    const key = normalizeText(name);
    return index.filter((e) => (kind === 'genre' ? e.genre.n : e.album.n) === key).map((e) => e.track);
  }

  // Every artist of the library with the number of songs: [{ name, count }], most songs first.
  function allArtists(index) {
    const by = new Map();
    index.forEach((e) => e.names.forEach((nm) => {
      if (!nm.f.n) return;
      let a = by.get(nm.f.n);
      if (!a) { a = { name: nm.shown, count: 0 }; by.set(nm.f.n, a); }
      a.count++;
    }));
    return Array.from(by.values()).sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));
  }

  /* [text] cut into pieces, each { text, hit }, where hit marks the letters that match the typed words
     (ignoring capitals and accents). Used to highlight what was typed. */
  function highlight(text, tokens) {
    const chars = Array.from(String(text == null ? '' : text));
    let folded = '';
    const map = [];
    chars.forEach((ch, i) => {
      const f = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      for (let k = 0; k < f.length; k++) { folded += f[k]; map.push(i); }
    });
    const mark = new Array(chars.length).fill(false);
    (tokens || []).forEach((tok) => {
      if (!tok) return;
      let from = 0;
      for (;;) {
        const at = folded.indexOf(tok, from);
        if (at < 0) break;
        for (let k = at; k < at + tok.length; k++) mark[map[k]] = true;
        from = at + tok.length;
      }
    });
    const pieces = [];
    chars.forEach((ch, i) => {
      const last = pieces[pieces.length - 1];
      if (last && last.hit === mark[i]) last.text += ch;
      else pieces.push({ text: ch, hit: mark[i] });
    });
    return pieces;
  }

  // The recent searches list: newest first, no repeats (ignoring case), at most [max].
  function addRecentSearch(list, text, max) {
    const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!t) return list.slice();
    const key = normalizeText(t);
    return [t].concat(list.filter((x) => normalizeText(x) !== key)).slice(0, max || 8);
  }

  const api = { searchLibrary: searchLibrary, indexTracks: indexTracks, highlight: highlight, addRecentSearch: addRecentSearch,
    collections: collections, collectionTracks: collectionTracks, allArtists: allArtists, creditedArtists: creditedArtists };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined' || !document.getElementById) return;

  /* ======================================================================
     The Search tab
     ====================================================================== */

  const $ = (id) => document.getElementById(id);
  const view = $('sp-view-search');
  const input = $('srch-input');
  const body = $('srch-body');
  if (!view || !input || !body) return;
  const panel = $('audio-panel');
  const clearBtn = $('srch-clear');
  const chipsEl = $('srch-chips');

  const RECENT_KEY = 'moonlight_recentSearches';
  const SONGS_IN_ALL = 5;
  const SONGS_MAX = 100;

  let filter = 'all';
  let browse = null;          // a category page opened from the landing tiles: { kind: 'artists'|'albums'|'genres'|'liked'|'songs'|'album'|'genre', name }
  let scanTimer = 0;
  let scanPolls = 0;
  let timer = 0;
  let index = null;
  let indexFor = null;
  let indexLen = -1;
  let indexRev = -1;
  let recent = [];
  try { recent = JSON.parse(root.localStorage.getItem(RECENT_KEY) || '[]').filter((x) => typeof x === 'string').slice(0, 8); } catch (e) { recent = []; }

  const audio = () => root.NovelAudio || null;
  const ui = () => root.SpotifyUI || null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function icon(name, extra) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ico' + (extra ? ' ' + extra : ''));
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#' + name);
    svg.appendChild(use);
    return svg;
  }

  function saveRecent() { try { root.localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch (e) { /* non-fatal */ } }
  function rememberQuery(text) { recent = addRecentSearch(recent, text, 8); saveRecent(); }

  function tracks() {
    const a = audio();
    return a && a.getTracks ? a.getTracks() : [];
  }

  function currentIndex() {
    const t = tracks();
    const a = audio();
    const rev = a && a.getInfoRev ? a.getInfoRev() : 0;      // an edited title / artist / playlist rebuilds the index
    if (!index || indexFor !== t || indexLen !== t.length || indexRev !== rev) { index = indexTracks(t); indexFor = t; indexLen = t.length; indexRev = rev; }
    return index;
  }

  function playlistRows() {
    const u = ui();
    try { return u && u.getPlaylistRows ? u.getPlaylistRows() : []; } catch (e) { return []; }
  }

  function cover(url, tone, iconName, className) {
    const c = el('span', 'sp-cover' + (className ? ' ' + className : ''));
    c.setAttribute('data-tone', String(tone % 4));
    c.appendChild(icon(iconName || 'i-moon-music'));
    if (url) { c.style.setProperty('--sp-cover', 'url("' + url + '")'); c.setAttribute('data-sp-cover', '1'); }
    return c;
  }

  /* ---- cover art for song rows ----------------------------------------------------------------
     A song row used to be built with no image at all, so every result showed the placeholder moon-and-note
     tile. The art is now asked from the app (AndroidBridge.getArtwork, which keeps its own disk cache) and
     painted into the row's tile a few at a time, so a long result list never blocks typing. Results are
     remembered for the session: a data: URI, or '' for a song without art. */
  const artCache = {};
  const artQueue = [];
  let artTimer = 0;

  function paintCover(tile, uri) {
    tile.style.setProperty('--sp-cover', 'url("' + uri + '")');
    tile.setAttribute('data-sp-cover', '1');
  }

  function artFor(track) {
    if (Object.prototype.hasOwnProperty.call(artCache, track.path)) return artCache[track.path];
    const b = root.AndroidBridge;
    let uri = '';
    try { uri = b && typeof b.getArtwork === 'function' ? (b.getArtwork(track.path) || '') : ''; } catch (e) { uri = ''; }
    artCache[track.path] = uri;
    return uri;
  }

  function drainArt() {
    artTimer = 0;
    for (let n = 0; n < 4 && artQueue.length; n++) {
      const job = artQueue.shift();
      if (job.tile.isConnected === false) continue;          // the results were redrawn meanwhile
      const uri = artFor(job.track);
      if (uri) paintCover(job.tile, uri);
    }
    if (artQueue.length) artTimer = root.setTimeout(drainArt, 0);
  }

  function queueArt(tile, track) {
    artQueue.push({ tile: tile, track: track });
    if (!artTimer) artTimer = root.setTimeout(drainArt, 0);
  }

  function highlighted(text, tokens, className) {
    const node = el('span', className);
    highlight(text, tokens).forEach((p) => {
      if (p.hit) node.appendChild(el('mark', 'srch-hit', p.text));
      else node.appendChild(document.createTextNode(p.text));
    });
    return node;
  }

  function songsText(n) { return n + (n === 1 ? ' song' : ' songs'); }

  function onActivate(node, handler) {
    node.addEventListener('click', handler);
    node.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target === node) { e.preventDefault(); handler(e); }
    });
  }

  /* ---- actions ---- */

  function playSong(track) {
    const a = audio();
    rememberQuery(input.value);
    if (a && a.playTrack) a.playTrack(track.id);
  }

  function openPlaylist(row) {
    rememberQuery(input.value);
    const u = ui();
    if (u && u.openPlaylist) u.openPlaylist(row.name);
  }

  function openArtist(artist) {
    rememberQuery(artist.name);
    input.value = artist.name;
    filter = 'songs';
    run();
  }

  /* ---- result rows ---- */

  function songRow(track, tokens, tone) {
    const a = audio();
    const row = el('div', 'srch-row');
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.setAttribute('data-id', track.id);
    if (a && a.getCurrentTrackId && a.getCurrentTrackId() === track.id) row.classList.add('playing');
    const thumb = cover('', tone, 'i-moon-music', 'srch-thumb');
    row.appendChild(thumb);
    if (track.path) {
      if (Object.prototype.hasOwnProperty.call(artCache, track.path)) { if (artCache[track.path]) paintCover(thumb, artCache[track.path]); }
      else queueArt(thumb, track);
    }
    const text = el('span', 'srch-text');
    text.appendChild(highlighted(track.title || '', tokens, 'srch-title'));
    const sub = [track.artist, track.playlist].filter(Boolean).join(' • ');
    text.appendChild(highlighted(sub || 'Song', tokens, 'srch-sub'));
    row.appendChild(text);

    const heart = el('button', 'srch-heart');
    heart.type = 'button';
    const liked = !!(a && a.isLiked && a.isLiked(track.id));
    heart.setAttribute('aria-label', liked ? 'Remove from liked songs' : 'Add to liked songs');
    heart.setAttribute('aria-pressed', liked ? 'true' : 'false');
    heart.appendChild(icon('i-heart', liked ? 'fill' : ''));
    heart.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!a || !a.toggleLike) return;
      const now = a.toggleLike(track.id);
      heart.setAttribute('aria-pressed', now ? 'true' : 'false');
      heart.setAttribute('aria-label', now ? 'Remove from liked songs' : 'Add to liked songs');
      heart.replaceChildren(icon('i-heart', now ? 'fill' : ''));
    });
    row.appendChild(heart);
    const more = el('button', 'srch-more');
    more.type = 'button';
    more.setAttribute('data-song-more', track.id);
    more.setAttribute('aria-label', 'Song options for ' + (track.title || 'this song'));
    more.appendChild(icon('sp-more', ''));
    row.appendChild(more);
    onActivate(row, () => playSong(track));
    return row;
  }

  function playlistRow(row, tokens, tone) {
    const n = el('div', 'srch-row');
    n.setAttribute('role', 'button');
    n.tabIndex = 0;
    const u = ui();
    const url = u && u.getCover ? u.getCover(row.name) : '';
    n.appendChild(cover(url, tone, 'i-moon-music', 'srch-thumb'));
    const text = el('span', 'srch-text');
    text.appendChild(highlighted(row.title || row.name, tokens, 'srch-title'));
    text.appendChild(el('span', 'srch-sub', 'Playlist' + (row.count ? ' • ' + row.count : '')));
    n.appendChild(text);
    onActivate(n, () => openPlaylist(row));
    return n;
  }

  function artistRow(artist, tokens, tone) {
    const n = el('div', 'srch-row');
    n.setAttribute('role', 'button');
    n.tabIndex = 0;
    const av = el('span', 'srch-avatar', (Array.from(artist.name)[0] || '?').toUpperCase());
    av.setAttribute('data-tone', String(tone % 4));
    n.appendChild(av);
    const text = el('span', 'srch-text');
    text.appendChild(highlighted(artist.name, tokens, 'srch-title'));
    text.appendChild(el('span', 'srch-sub', 'Artist • ' + songsText(artist.count)));
    n.appendChild(text);
    onActivate(n, () => openArtist(artist));
    return n;
  }

  function albumRow(album, tokens, tone) {
    const n = el('div', 'srch-row');
    n.setAttribute('role', 'button');
    n.tabIndex = 0;
    const thumb = cover('', tone, 'i-moon-music', 'srch-thumb');
    n.appendChild(thumb);
    if (album.first && album.first.path) {
      if (Object.prototype.hasOwnProperty.call(artCache, album.first.path)) { if (artCache[album.first.path]) paintCover(thumb, artCache[album.first.path]); }
      else queueArt(thumb, album.first);
    }
    const text = el('span', 'srch-text');
    text.appendChild(highlighted(album.name, tokens, 'srch-title'));
    text.appendChild(el('span', 'srch-sub', 'Album' + (album.artist ? ' \u2022 ' + album.artist : '') + ' \u2022 ' + songsText(album.count)));
    n.appendChild(text);
    onActivate(n, () => openCollection('album', album.name));
    return n;
  }

  function genreRow(genre, tokens, tone) {
    const n = el('div', 'srch-row');
    n.setAttribute('role', 'button');
    n.tabIndex = 0;
    const av = el('span', 'srch-avatar', '#');
    av.setAttribute('data-tone', String(tone % 4));
    n.appendChild(av);
    const text = el('span', 'srch-text');
    text.appendChild(highlighted(genre.name, tokens, 'srch-title'));
    text.appendChild(el('span', 'srch-sub', 'Genre \u2022 ' + songsText(genre.count)));
    n.appendChild(text);
    onActivate(n, () => openCollection('genre', genre.name));
    return n;
  }

  // An album or a genre of your library as a page of its songs (so a tap shows exactly those songs).
  function openCollection(kind, name) {
    rememberQuery(name);
    browse = { kind: kind, name: name };
    input.value = '';
    filter = 'all';
    run();
  }

  function topCard(top, tokens) {
    const card = el('div', 'srch-top');
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    const u = ui();
    let title = '', label = '', handler = null;
    if (top.type === 'song') {
      title = top.item.title || '';
      label = 'Song' + (top.item.artist ? ' • ' + top.item.artist : '');
      card.appendChild(cover('', 0, 'i-moon-music', 'srch-top-cover'));
      handler = () => playSong(top.item);
    } else if (top.type === 'playlist') {
      title = top.item.title || top.item.name;
      label = 'Playlist' + (top.item.count ? ' • ' + top.item.count : '');
      card.appendChild(cover(u && u.getCover ? u.getCover(top.item.name) : '', 1, 'i-moon-music', 'srch-top-cover'));
      handler = () => openPlaylist(top.item);
    } else {
      title = top.item.name;
      label = 'Artist • ' + songsText(top.item.count);
      const av = el('span', 'srch-avatar srch-top-cover', (Array.from(title)[0] || '?').toUpperCase());
      av.setAttribute('data-tone', '2');
      card.appendChild(av);
      handler = () => openArtist(top.item);
    }
    card.appendChild(highlighted(title, tokens, 'srch-top-title'));
    card.appendChild(el('span', 'srch-top-sub', label));
    onActivate(card, handler);
    return card;
  }

  function section(title, action) {
    const s = el('section', 'srch-section');
    const head = el('div', 'srch-head');
    head.appendChild(el('h2', null, title));
    if (action) {
      const b = el('button', 'srch-link', action.label);
      b.type = 'button';
      b.addEventListener('click', action.onClick);
      head.appendChild(b);
    }
    s.appendChild(head);
    return s;
  }

  /* ---- the two states of the tab ---- */

  // The library is still being read: say so instead of an empty page.
  function indexingNote() {
    const a = audio();
    const yes = !!(a && a.isScanning && a.isScanning() && !tracks().length);
    if (!yes) scanPolls = 0;
    return yes;
  }

  function loadingState() {
    const box = el('div', 'srch-none');
    box.setAttribute('role', 'status');
    box.appendChild(el('h2', null, 'Indexing your library\u2026'));
    box.appendChild(el('p', null, 'Search is ready as soon as your music has been read.'));
    return box;
  }

  // Look again until the scan is finished (gives up after ~3.5 min). Called AFTER the box is on the page.
  function pollScan() {
    clearTimeout(scanTimer);
    if (++scanPolls < 300) scanTimer = setTimeout(run, 700);
  }

  // Back from a category page (or an album / genre page) to the landing page. True when something was open.
  function back() {
    if (!browse) return false;
    browse = null;
    run();
    return true;
  }

  function pageHead(title, sub) {
    const head = el('div', 'srch-page-head');
    const b = el('button', 'srch-back');
    b.type = 'button';
    b.setAttribute('aria-label', 'Back');
    b.appendChild(icon('i-chev-left'));
    b.addEventListener('click', back);
    head.appendChild(b);
    const text = el('div', 'srch-page-text');
    text.appendChild(el('h2', null, title));
    if (sub) text.appendChild(el('p', null, sub));
    head.appendChild(text);
    return head;
  }

  const BROWSE_SONGS_MAX = 300;

  function renderBrowse() {
    const a = audio();
    const idx = currentIndex();
    const col = collections(idx);
    body.replaceChildren();
    body.setAttribute('data-state', 'browse');
    let title = '';
    let sub = '';
    let list = [];
    if (browse.kind === 'artists') {
      const artists = allArtists(idx);
      title = 'Artists'; sub = artists.length + (artists.length === 1 ? ' artist' : ' artists');
      body.appendChild(pageHead(title, sub));
      artists.forEach((x, i) => body.appendChild(artistRow(x, [], i)));
      return;
    }
    if (browse.kind === 'albums') {
      const albums = col.albums.slice().sort((x, y) => x.name.localeCompare(y.name));
      title = 'Albums'; sub = albums.length + (albums.length === 1 ? ' album' : ' albums');
      body.appendChild(pageHead(title, sub));
      albums.forEach((x, i) => body.appendChild(albumRow(x, [], i)));
      return;
    }
    if (browse.kind === 'genres') {
      const genres = col.genres.slice().sort((x, y) => (y.count - x.count) || x.name.localeCompare(y.name));
      title = 'Genres'; sub = genres.length + (genres.length === 1 ? ' genre' : ' genres');
      body.appendChild(pageHead(title, sub));
      genres.forEach((x, i) => body.appendChild(genreRow(x, [], i)));
      return;
    }
    if (browse.kind === 'liked') {
      const ids = new Set(a && a.getLikedIds ? a.getLikedIds() : []);
      list = tracks().filter((t) => ids.has(t.id));
      title = 'Liked Songs';
    } else if (browse.kind === 'album' || browse.kind === 'genre') {
      list = collectionTracks(idx, browse.kind, browse.name);
      title = browse.name;
      sub = (browse.kind === 'album' ? 'Album' : 'Genre') + ' \u2022 ' + songsText(list.length);
    } else {
      list = tracks().slice().sort((x, y) => String(x.title).localeCompare(String(y.title)));
      title = 'All songs';
    }
    if (!sub) sub = songsText(list.length);
    body.appendChild(pageHead(title, sub));
    if (!list.length) { body.appendChild(el('p', 'srch-empty', 'Nothing here yet.')); return; }
    list.slice(0, BROWSE_SONGS_MAX).forEach((t, i) => body.appendChild(songRow(t, [], i)));
    if (list.length > BROWSE_SONGS_MAX) body.appendChild(el('p', 'srch-empty', 'Showing the first ' + BROWSE_SONGS_MAX + '. Type in the search box to find the rest.'));
  }

  // Tiles made from your own library: only the categories that have something in them.
  function categoryTiles() {
    const a = audio();
    const idx = currentIndex();
    const col = collections(idx);
    const likedIds = new Set(a && a.getLikedIds ? a.getLikedIds() : []);
    const liked = tracks().filter((t) => likedIds.has(t.id)).length;
    const artists = allArtists(idx).length;
    const total = tracks().length;
    return [
      { kind: 'artists', title: 'Artists', sub: artists + (artists === 1 ? ' artist' : ' artists'), n: artists },
      { kind: 'albums', title: 'Albums', sub: col.albums.length + (col.albums.length === 1 ? ' album' : ' albums'), n: col.albums.length },
      { kind: 'genres', title: 'Genres', sub: col.genres.length + (col.genres.length === 1 ? ' genre' : ' genres'), n: col.genres.length },
      { kind: 'liked', title: 'Liked Songs', sub: songsText(liked), n: liked },
      { kind: 'songs', title: 'All songs', sub: songsText(total), n: total },
    ].filter((t) => t.n > 0);
  }

  // "From your library": your biggest albums and genres as cards (nothing here comes from outside the phone).
  function discoverRail() {
    const idx = currentIndex();
    const col = collections(idx);
    const albums = col.albums.slice().sort((x, y) => (y.count - x.count) || x.name.localeCompare(y.name)).slice(0, 8);
    const genres = col.genres.slice().sort((x, y) => (y.count - x.count) || x.name.localeCompare(y.name)).slice(0, 6);
    if (albums.length + genres.length < 2) return null;
    const s = section('From your library');
    const rail = el('div', 'srch-rail');
    albums.forEach((al, i) => {
      const card = el('button', 'srch-card');
      card.type = 'button';
      card.setAttribute('data-tone', String(i % 6));
      if (al.first && al.first.path) {
        if (Object.prototype.hasOwnProperty.call(artCache, al.first.path)) { if (artCache[al.first.path]) paintCover(card, artCache[al.first.path]); }
        else queueArt(card, al.first);
      }
      card.appendChild(el('span', 'srch-card-name', al.name));
      card.appendChild(el('span', 'srch-card-sub', songsText(al.count)));
      card.addEventListener('click', () => openCollection('album', al.name));
      rail.appendChild(card);
    });
    genres.forEach((g, i) => {
      const card = el('button', 'srch-card srch-card-tag');
      card.type = 'button';
      card.setAttribute('data-tone', String((i + 3) % 6));
      card.appendChild(el('span', 'srch-card-name', '#' + g.name.toLowerCase().replace(/\s+/g, '')));
      card.appendChild(el('span', 'srch-card-sub', songsText(g.count)));
      card.addEventListener('click', () => openCollection('genre', g.name));
      rail.appendChild(card);
    });
    s.appendChild(rail);
    return s;
  }

  function renderEmpty() {
    if (browse) { renderBrowse(); return; }
    body.replaceChildren();
    body.setAttribute('data-state', 'empty');
    if (indexingNote()) { body.appendChild(loadingState()); pollScan(); return; }
    if (recent.length) {
      const s = section('Recent searches', {
        label: 'Clear all',
        onClick: () => { recent = []; saveRecent(); renderEmpty(); },
      });
      recent.forEach((text) => {
        const row = el('div', 'srch-row srch-recent');
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        row.appendChild(el('span', 'srch-recent-ico')).appendChild(icon('i-history'));
        row.appendChild(el('span', 'srch-title', text));
        const x = el('button', 'srch-x');
        x.type = 'button';
        x.setAttribute('aria-label', 'Remove “' + text + '” from recent searches');
        x.appendChild(icon('i-close'));
        x.addEventListener('click', (e) => {
          e.stopPropagation();
          recent = recent.filter((r) => r !== text);
          saveRecent();
          renderEmpty();
        });
        row.appendChild(x);
        onActivate(row, () => { browse = null; input.value = text; filter = 'all'; run(); });
        s.appendChild(row);
      });
      body.appendChild(s);
    }

    const cats = categoryTiles();
    if (cats.length) {
      const s = section('Browse your library');
      const grid = el('div', 'srch-grid');
      cats.forEach((c, i) => {
        const tile = el('button', 'srch-cat');                // like a playlist tile, but a category of the library
        tile.type = 'button';
        tile.setAttribute('data-tone', String((i + 1) % 6));
        tile.appendChild(el('span', 'srch-tile-name', c.title));
        tile.appendChild(el('span', 'srch-tile-sub', c.sub));
        tile.addEventListener('click', () => { browse = { kind: c.kind }; run(); });
        grid.appendChild(tile);
      });
      s.appendChild(grid);
      body.appendChild(s);
      const rail = discoverRail();
      if (rail) body.appendChild(rail);
    }

    const rows = playlistRows();
    if (rows.length) {
      const s = section('Browse all');
      const grid = el('div', 'srch-grid');
      const u = ui();
      rows.forEach((row, i) => {
        const tile = el('button', 'srch-tile');
        tile.type = 'button';
        tile.setAttribute('data-tone', String(i % 6));
        const url = u && u.getCover ? u.getCover(row.name) : '';
        if (url) { tile.style.setProperty('--sp-cover', 'url("' + url + '")'); tile.setAttribute('data-sp-cover', '1'); }
        tile.appendChild(el('span', 'srch-tile-name', row.title || row.name));
        if (row.count) tile.appendChild(el('span', 'srch-tile-sub', row.count));
        tile.addEventListener('click', () => openPlaylist(row));
        grid.appendChild(tile);
      });
      s.appendChild(grid);
      body.appendChild(s);
    } else if (!recent.length) {
      body.appendChild(el('p', 'srch-empty', 'Search your songs, artists and playlists. Add some music first, then tap Scan the sky on Home.'));
    }
  }

  function noResults(q) {
    const box = el('div', 'srch-none');
    box.appendChild(el('h2', null, 'No results for “' + q + '”'));
    box.appendChild(el('p', null, 'Check the spelling, or try fewer or different words.'));
    return box;
  }

  function renderResults(q) {
    const a = audio();
    const found = searchLibrary(q, tracks(), { playlists: playlistRows(), liked: a && a.getLikedIds ? a.getLikedIds() : [], index: currentIndex() });
    body.replaceChildren();
    body.setAttribute('data-state', 'results');
    const tokens = found.tokens;
    const total = found.songs.length + found.playlists.length + found.artists.length + found.albums.length + found.genres.length;
    const status = el('div', 'srch-status', total ? total + (total === 1 ? ' result' : ' results') : 'No results');
    status.setAttribute('role', 'status');
    body.appendChild(status);
    if (!total) {
      if (indexingNote()) { body.appendChild(loadingState()); pollScan(); } else body.appendChild(noResults(q));
      return;
    }

    if (filter === 'all' && found.top) {
      const s = section('Top result');
      s.appendChild(topCard(found.top, tokens));
      body.appendChild(s);
    }
    if ((filter === 'all' || filter === 'songs') && found.songs.length) {
      const limit = filter === 'all' ? SONGS_IN_ALL : SONGS_MAX;
      const more = filter === 'all' && found.songs.length > SONGS_IN_ALL
        ? { label: 'Show all ' + found.songs.length, onClick: () => { filter = 'songs'; syncChips(); renderResults(q); } } : null;
      const s = section('Songs', more);
      found.songs.slice(0, limit).forEach((r, i) => s.appendChild(songRow(r.track, tokens, i)));
      body.appendChild(s);
    }
    if ((filter === 'all' || filter === 'playlists') && found.playlists.length) {
      const s = section('Playlists');
      found.playlists.slice(0, filter === 'all' ? 3 : 50).forEach((r, i) => s.appendChild(playlistRow(r.row, tokens, i)));
      body.appendChild(s);
    }
    if ((filter === 'all' || filter === 'artists') && found.artists.length) {
      const s = section('Artists');
      found.artists.slice(0, filter === 'all' ? 3 : 50).forEach((r, i) => s.appendChild(artistRow(r, tokens, i)));
      body.appendChild(s);
    }
    if ((filter === 'all' || filter === 'albums') && found.albums.length) {
      const s = section('Albums');
      found.albums.slice(0, filter === 'all' ? 3 : 50).forEach((r, i) => s.appendChild(albumRow(r, tokens, i)));
      body.appendChild(s);
    }
    if ((filter === 'all' || filter === 'genres') && found.genres.length) {
      const s = section('Genres');
      found.genres.slice(0, filter === 'all' ? 3 : 50).forEach((r, i) => s.appendChild(genreRow(r, tokens, i)));
      body.appendChild(s);
    }
    // A chosen filter with nothing in it.
    if (filter !== 'all' && body.children.length === 1) body.appendChild(noResults(q));
  }

  function syncChips() {
    if (!chipsEl) return;
    chipsEl.querySelectorAll('[data-srch-filter]').forEach((b) => {
      const on = b.getAttribute('data-srch-filter') === filter;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function run() {
    const q = input.value.trim();
    if (clearBtn) clearBtn.hidden = !input.value;
    if (chipsEl) chipsEl.hidden = !q;
    syncChips();
    if (q) browse = null;                           // typing leaves a category page
    if (chipsEl) chipsEl.hidden = !q;
    if (!q) { filter = 'all'; syncChips(); renderEmpty(); return; }
    renderResults(q);
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 90);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(timer);
      run();
      if (input.value.trim()) rememberQuery(input.value);
      input.blur();            // hides the keyboard, like Spotify
    }
  });
  if (clearBtn) {
    clearBtn.addEventListener('click', () => { input.value = ''; filter = 'all'; run(); input.focus(); });
  }
  if (chipsEl) {
    chipsEl.addEventListener('click', (e) => {
      const b = e.target.closest ? e.target.closest('[data-srch-filter]') : null;
      if (!b) return;
      filter = b.getAttribute('data-srch-filter');
      run();
    });
  }

  // Each time the tab is opened, refresh it (new playlists, new recent searches, liked hearts).
  if (panel && typeof MutationObserver === 'function') {
    new MutationObserver(() => { if (panel.getAttribute('data-view') === 'search') run(); })
      .observe(panel, { attributes: true, attributeFilter: ['data-view'] });
  }
  run();

  // back(): leaves a category / album / genre page; true when it did (the Back button asks first).
  root.SongSearch = { run: run, back: back, setQuery: (text) => { browse = null; input.value = text; filter = 'all'; run(); } };
})(typeof window !== 'undefined' ? window : this);
