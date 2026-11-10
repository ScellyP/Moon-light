/* ============================================================================
   Add songs to a playlist ("Add to this playlist")
   ============================================================================
   A full-screen picker that lists EVERY song on the phone (the one shared Songs library) with its artwork,
   title and artist, a search box at the bottom and a + button on each row. The playlist it adds to is fixed
   for as long as the picker is open (nothing here changes which playlist is shown behind it).

     window.PlaylistPicker.open(key, title)   key: 'name:<playlist>' or 'list:<id>' (see NovelAudio.getPlaylistInfo)
     window.PlaylistPicker.close() / .isOpen()

   A + only ADDS A REFERENCE to the playlist's record (at the end, in the order tapped): the music file is never
   copied, moved or deleted. A song already in the playlist shows a check instead, so it cannot be added twice.
   Long libraries are drawn 60 rows at a time while scrolling; artwork is asked a few songs at a time so typing
   and scrolling never wait for it. The playlist behind the picker is redrawn once, when the picker closes.
   Needs window.NovelAudio (audio-player.js); messages use SongMenu.toast when it exists.
   ========================================================================= */
(function (root) {
  'use strict';

  const doc = root.document;
  if (!doc) return;

  const CHUNK = 60;
  let layer = null, list = null, input = null, subNode = null;
  let ctx = null;            // { key, title, inList: Set of song ids, added, query, shown: [tracks], drawn }
  let searchTimer = 0;

  const audio = () => root.NovelAudio || null;

  function el(tag, cls, text) {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function icon(id, extra) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'ico' + (extra ? ' ' + extra : ''));
    svg.setAttribute('aria-hidden', 'true');
    const use = doc.createElementNS(NS, 'use');
    use.setAttribute('href', '#' + id);
    svg.appendChild(use);
    return svg;
  }

  function button(cls, label) {
    const b = el('button', cls);
    b.type = 'button';
    if (label) b.setAttribute('aria-label', label);
    return b;
  }

  function toast(message) {
    if (root.SongMenu && root.SongMenu.toast) root.SongMenu.toast(message);
  }

  /* ---- artwork, a few songs at a time (the app keeps its own disk cache) ---- */
  const artCache = {};
  const artQueue = [];
  let artTimer = 0;
  let seen = null;                // IntersectionObserver: artwork is only asked for rows that are (nearly) on screen
  const rowJobs = new WeakMap();  // row element -> { tile, track }
  const nextFrame = (f) => (typeof root.requestAnimationFrame === 'function' ? root.requestAnimationFrame(f) : root.setTimeout(f, 16));

  function artFor(track) {
    if (Object.prototype.hasOwnProperty.call(artCache, track.path)) return artCache[track.path];
    const b = root.AndroidBridge;
    let uri = '';
    try { uri = b && typeof b.getArtwork === 'function' ? (b.getArtwork(track.path) || '') : ''; } catch (e) { uri = ''; }
    artCache[track.path] = uri;
    return uri;
  }

  // One picture per animation frame, so scrolling and typing never wait for a batch of them.
  function drainArt() {
    artTimer = 0;
    while (artQueue.length) {
      const job = artQueue.shift();
      if (job.tile.isConnected === false) continue;       // the list was redrawn meanwhile
      const uri = artFor(job.track);
      if (uri) { job.tile.style.setProperty('--pp-cover', 'url("' + uri + '")'); job.tile.setAttribute('data-pp-cover', '1'); }
      break;
    }
    if (artQueue.length) scheduleArt();
  }

  function scheduleArt() {
    if (artTimer) return;
    artTimer = -1;                                  // (a timer that fires at once must not be overwritten below)
    const id = nextFrame(drainArt);
    if (artTimer === -1) artTimer = id;
  }

  function queueArt(tile, track) {
    artQueue.push({ tile: tile, track: track });
    scheduleArt();
  }

  function onSeen(entries) {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      const job = rowJobs.get(e.target);
      if (seen) seen.unobserve(e.target);
      if (job) queueArt(job.tile, job.track);
    });
  }

  /* ---- the screen ---- */
  function build() {
    if (layer) return;
    layer = el('div', 'hidden');
    layer.id = 'pp-layer';
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-label', 'Add to this playlist');

    const bar = el('div', 'pp-bar');
    const back = button('pp-back', 'Back');
    back.appendChild(icon('i-chev-left'));
    back.addEventListener('click', close);
    const head = el('div', 'pp-head');
    head.appendChild(el('div', 'pp-title', 'Add to this playlist'));
    subNode = el('div', 'pp-sub');
    head.appendChild(subNode);
    const done = button('pp-done', 'Done');
    done.textContent = 'Done';
    done.addEventListener('click', close);
    bar.appendChild(back);
    bar.appendChild(head);
    bar.appendChild(done);
    layer.appendChild(bar);

    list = el('div', 'pp-list');
    if (typeof root.IntersectionObserver === 'function') {
      try { seen = new root.IntersectionObserver(onSeen, { root: list, rootMargin: '240px 0px' }); } catch (e) { seen = null; }
    }
    list.addEventListener('scroll', () => {
      if (ctx && ctx.drawn < ctx.shown.length && list.scrollTop + list.clientHeight >= list.scrollHeight - 800) drawMore();
    });
    layer.appendChild(list);

    const search = el('div', 'pp-search');
    search.appendChild(icon('i-search'));
    input = el('input', 'pp-input');
    input.type = 'search';
    input.placeholder = 'What would you like to add?';
    input.setAttribute('aria-label', 'Search your songs');
    input.setAttribute('enterkeyhint', 'search');
    input.setAttribute('autocomplete', 'off');
    input.addEventListener('input', () => {
      if (searchTimer) root.clearTimeout(searchTimer);
      searchTimer = root.setTimeout(() => { searchTimer = 0; runSearch(); }, 200);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && input.blur) input.blur(); });
    search.appendChild(input);
    layer.appendChild(search);
    doc.body.appendChild(layer);
  }

  function sourceTracks(query) {
    const a = audio();
    if (!a) return [];
    return String(query || '').trim() ? (a.searchTracks ? a.searchTracks(query) : []) : (a.getTracks ? a.getTracks() : []);
  }

  function runSearch() {
    if (!ctx) return;
    ctx.query = input.value;
    ctx.shown = sourceTracks(ctx.query);
    renderList();
    list.scrollTop = 0;
  }

  function renderList() {
    list.replaceChildren();
    artQueue.length = 0;
    if (seen) seen.disconnect();
    ctx.drawn = 0;
    if (!ctx.shown.length) {
      const total = (audio() && audio().getTracks ? audio().getTracks().length : 0);
      list.appendChild(el('div', 'pp-empty', total
        ? 'No songs match \u201c' + String(ctx.query).trim().slice(0, 40) + '\u201d.'
        : 'No songs on this phone yet. Download some from the Download tab, then come back.'));
      return;
    }
    drawMore();
  }

  function drawMore() {
    const end = Math.min(ctx.shown.length, ctx.drawn + CHUNK);
    for (let i = ctx.drawn; i < end; i++) list.appendChild(makeRow(ctx.shown[i]));
    ctx.drawn = end;
  }

  function markAdded(btn, track) {
    btn.className = 'pp-add done';
    btn.replaceChildren(icon('i-check'));
    btn.setAttribute('aria-label', 'In the playlist: ' + (track.title || 'song'));
    btn.setAttribute('aria-pressed', 'true');
  }

  function makeRow(track) {
    const row = el('div', 'pp-row');
    const tile = el('div', 'pp-art');
    tile.appendChild(icon('i-moon-music'));
    row.appendChild(tile);
    const text = el('div', 'pp-text');
    text.appendChild(el('div', 'pp-name', track.title || 'Unknown song'));
    if (track.artist) text.appendChild(el('div', 'pp-artist', track.artist));
    row.appendChild(text);
    const add = button('pp-add', 'Add to playlist: ' + (track.title || 'song'));
    add.appendChild(icon('i-circle-plus'));
    if (ctx.inList.has(track.id)) markAdded(add, track);
    add.addEventListener('click', () => {
      if (!ctx || ctx.inList.has(track.id)) return;           // already there: never twice
      const a = audio();
      if (!a || !a.addSongToPlaylist(ctx.key, track.id, true)) { toast('Could not add the song'); return; }
      ctx.inList.add(track.id);
      ctx.added++;
      markAdded(add, track);
    });
    row.appendChild(add);
    if (seen) { rowJobs.set(row, { tile: tile, track: track }); seen.observe(row); }      // art when it scrolls into view
    else queueArt(tile, track);
    return row;
  }

  /* ---- public ---- */
  function open(key, title) {
    const a = audio();
    if (!a || !a.addSongToPlaylist || !a.getPlaylistInfo || !a.getPlaylistInfo(String(key || ''))) return false;
    build();
    const order = a.getPlaylistOrder ? a.getPlaylistOrder(key) : [];
    ctx = { key: String(key), title: title || '', inList: new Set(order.map((s) => s.id)), added: 0, query: '', shown: [], drawn: 0 };
    subNode.textContent = ctx.title;
    input.value = '';
    ctx.shown = sourceTracks('');
    layer.classList.remove('hidden');
    renderList();
    list.scrollTop = 0;
    return true;
  }

  function close() {
    if (!layer || layer.classList.contains('hidden')) return;
    layer.classList.add('hidden');
    if (searchTimer) { root.clearTimeout(searchTimer); searchTimer = 0; }
    const done = ctx;
    ctx = null;
    artQueue.length = 0;
    if (seen) seen.disconnect();
    list.replaceChildren();
    if (done && done.added) {
      const a = audio();
      if (a && a.refreshPlaylists) a.refreshPlaylists();     // the playlist behind redraws once
      toast(done.added === 1 ? 'Added 1 song to \u201c' + done.title + '\u201d' : 'Added ' + done.added + ' songs to \u201c' + done.title + '\u201d');
    }
  }

  function isOpen() { return !!(layer && !layer.classList.contains('hidden')); }

  root.PlaylistPicker = { open: open, close: close, isOpen: isOpen };
})(typeof window !== 'undefined' ? window : this);
