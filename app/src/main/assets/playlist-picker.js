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
  let worker = 0;
  const buttons = new Map();     // song id -> its + / check button (only for rows that are drawn)

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
    layer = el('div', 'dyn-colours hidden');
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
    if (root.SpotifyUI && root.SpotifyUI.syncTint) root.SpotifyUI.syncTint();      // the song colours, if a song is loaded
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
    buttons.clear();
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

  function markAdded(btn, track, pop) {
    btn.className = 'pp-add done' + (pop ? ' pop' : '');
    btn.replaceChildren(icon('i-check'));
    btn.setAttribute('aria-label', 'In the playlist, tap to take out: ' + (track.title || 'song'));
    btn.setAttribute('aria-pressed', 'true');
  }

  // Writes the wanted changes to the playlist one song per task, so taps and scrolling stay smooth in between.
  function kick() {
    if (worker) return;
    worker = -1;                                    // (a timer that fires at once must not be overwritten below)
    const id = root.setTimeout(step, 0);
    if (worker === -1) worker = id;
  }

  function writeOne() {
    const next = ctx.wanted.entries().next();
    if (next.done) return false;
    const id = next.value[0], want = next.value[1];
    ctx.wanted.delete(id);
    if (ctx.written.has(id) === want) return true;              // already in that state on the phone (a tap and an undo)
    const a = audio();
    const ok = a && (want ? a.addSongToPlaylist(ctx.key, id, true) : (a.removeSongFromPlaylist && a.removeSongFromPlaylist(ctx.key, id, true)));
    if (ok) {
      if (want) ctx.written.add(id); else ctx.written.delete(id);
      return true;
    }
    // It did not work: the button goes back to what is really in the playlist, and says so.
    if (want) ctx.inList.delete(id); else ctx.inList.add(id);
    const shown = buttons.get(id);
    if (shown) { if (want) markAddable(shown.btn, shown.track, true); else markAdded(shown.btn, shown.track, true); }
    toast(want ? 'Could not add the song' : 'Could not take the song out');
    return true;
  }

  function step() {
    worker = 0;
    if (!ctx) return;
    writeOne();
    if (ctx.wanted.size) kick();
  }

  function markAddable(btn, track, pop) {
    btn.className = 'pp-add' + (pop ? ' pop' : '');
    btn.replaceChildren(icon('i-circle-plus'));
    btn.setAttribute('aria-label', 'Add to playlist: ' + (track.title || 'song'));
    btn.setAttribute('aria-pressed', 'false');
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
    // The + adds the song; the check takes it out again (only its place in the playlist, never the music file).
    // The button answers at once; the write to the phone follows right after (see step()), one song per task.
    buttons.set(track.id, { btn: add, track: track });
    add.addEventListener('click', () => {
      if (!ctx) return;
      const want = !ctx.inList.has(track.id);
      if (want) ctx.inList.add(track.id); else ctx.inList.delete(track.id);
      if (want) markAdded(add, track, true); else markAddable(add, track, true);
      ctx.wanted.set(track.id, want);
      kick();
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
    const was = new Set(order.map((s) => s.id));
    ctx = { key: String(key), title: title || '', inList: new Set(was), was: was, written: new Set(was), wanted: new Map(), query: '', shown: [], drawn: 0 };
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
    while (ctx && ctx.wanted.size) writeOne();                  // nothing tapped is left unwritten when the screen closes
    const done = ctx;
    ctx = null;
    artQueue.length = 0;
    buttons.clear();
    if (seen) seen.disconnect();
    list.replaceChildren();
    if (done) {
      // What changed by the end (a song added and then taken out again changes nothing).
      let added = 0, removed = 0;
      done.inList.forEach((id) => { if (!done.was.has(id)) added++; });
      done.was.forEach((id) => { if (!done.inList.has(id)) removed++; });
      if (added || removed) {
        const a = audio();
        if (a && a.refreshPlaylists) a.refreshPlaylists();     // the playlist behind redraws once
        const n = (k) => (k === 1 ? '1 song' : k + ' songs');
        const q = '\u201c' + done.title + '\u201d';
        toast(added && removed ? 'Added ' + n(added) + ' and took out ' + n(removed) + ' (' + q + ')'
          : added ? 'Added ' + n(added) + ' to ' + q : 'Took out ' + n(removed) + ' from ' + q);
      }
    }
  }

  function isOpen() { return !!(layer && !layer.classList.contains('hidden')); }

  root.PlaylistPicker = { open: open, close: close, isOpen: isOpen };
})(typeof window !== 'undefined' ? window : this);
