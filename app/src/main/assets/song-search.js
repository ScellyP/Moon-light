/* =========================================================================
   Moonlight — Search (a Spotify-style search over your own library)

   Type in the box and the results appear as you type: a "Top result", then Songs, Playlists and
   Artists, with the letters you typed highlighted. Filter chips (All / Songs / Playlists / Artists)
   narrow it down. With nothing typed it shows your recent searches and a "Browse all" grid of your
   playlists.

   The matching works on every word you type: a song must match ALL of them, in its title, artist,
   album or playlist name (accents and capitals do not matter; a small typo is forgiven). Matches at
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
  function indexTracks(tracks) {
    return (tracks || []).map((t) => ({
      track: t, title: field(t.title), artist: field(t.artist), album: field(t.album), list: field(t.playlist),
    }));
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
    const result = { tokens: tokens, songs: [], playlists: [], artists: [], top: null };
    if (!tokens.length) return result;

    const liked = new Set(o.liked || []);
    const index = o.index || indexTracks(tracks);

    index.forEach((e) => {
      let total = 0;
      for (let i = 0; i < tokens.length; i++) {
        const s = Math.max(
          fieldScore(tokens[i], e.title, W_TITLE), fieldScore(tokens[i], e.artist, W_ARTIST),
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

    // Artists: one entry per distinct artist name (the spelling most songs use).
    const byArtist = new Map();
    index.forEach((e) => {
      if (!e.artist.n) return;
      let a = byArtist.get(e.artist.n);
      if (!a) { a = { f: e.artist, names: new Map(), count: 0 }; byArtist.set(e.artist.n, a); }
      a.count++;
      const shown = String(e.track.artist).trim();
      a.names.set(shown, (a.names.get(shown) || 0) + 1);
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

    // The top result: the best match of any kind. A playlist or artist named exactly as typed wins.
    const best = [];
    if (result.songs[0]) best.push({ type: 'song', item: result.songs[0].track, score: result.songs[0].score });
    if (result.playlists[0]) best.push({ type: 'playlist', item: result.playlists[0].row, score: result.playlists[0].score });
    if (result.artists[0]) best.push({ type: 'artist', item: result.artists[0], score: result.artists[0].score });
    best.sort((a, b) => b.score - a.score);
    result.top = best[0] ? { type: best[0].type, item: best[0].item } : null;
    return result;
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

  const api = { searchLibrary: searchLibrary, indexTracks: indexTracks, highlight: highlight, addRecentSearch: addRecentSearch };
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
  let timer = 0;
  let index = null;
  let indexFor = null;
  let indexLen = -1;
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
    if (!index || indexFor !== t || indexLen !== t.length) { index = indexTracks(t); indexFor = t; indexLen = t.length; }
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
    row.appendChild(cover('', tone, 'i-moon-music', 'srch-thumb'));
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

  function renderEmpty() {
    body.replaceChildren();
    body.setAttribute('data-state', 'empty');
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
        onActivate(row, () => { input.value = text; filter = 'all'; run(); });
        s.appendChild(row);
      });
      body.appendChild(s);
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
    const total = found.songs.length + found.playlists.length + found.artists.length;
    const status = el('div', 'srch-status', total ? total + (total === 1 ? ' result' : ' results') : 'No results');
    status.setAttribute('role', 'status');
    body.appendChild(status);
    if (!total) { body.appendChild(noResults(q)); return; }

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

  root.SongSearch = { run: run, setQuery: (text) => { input.value = text; filter = 'all'; run(); } };
})(typeof window !== 'undefined' ? window : this);
