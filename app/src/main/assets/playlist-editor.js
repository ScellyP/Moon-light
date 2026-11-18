/* ============================================================================
   Edit playlist: drag to reorder, take songs out, nothing is saved until Save
   ============================================================================
     window.PlaylistEditor.open(key, title)   key: 'name:<playlist>' or 'list:<id>' (see NovelAudio.getPlaylistInfo)
     window.PlaylistEditor.close() / .isOpen()    close() acts like the back arrow (it asks first when there are changes)

   The screen works on a COPY of the order: dragging a row only moves one element, the minus takes a row out of
   the copy, and Save sends the whole result in ONE call (NovelAudio.applyPlaylistEdit), so a long playlist is
   written once instead of once per move. Only the playlist's record changes: a song taken out of a playlist is
   never deleted from the phone. Rows have a fixed height, so the drag maths is plain arithmetic; long
   playlists are drawn 100 rows at a time while scrolling, and artwork is asked only for rows on screen.
   ========================================================================= */
(function (root) {
  'use strict';

  const doc = root.document;
  if (!doc) return;

  const ROW_H = 72;            // px, fixed (CSS .pe-row): drag positions are index * ROW_H
  const CHUNK = 100;
  let layer = null, list = null, saveBtn = null, selectBar = null, pill = null, removePill = null, cancelPill = null, titleNode = null;
  let ctx = null;              // { key, title, pending: [tracks not drawn yet], removed: Set, selected: Set, dirty, selecting, armed, drag }
  let seen = null;
  const rowJobs = new WeakMap();
  const artCache = {};
  const artQueue = [];
  let artTimer = 0;

  const audio = () => root.NovelAudio || null;
  const nextFrame = (f) => (typeof root.requestAnimationFrame === 'function' ? root.requestAnimationFrame(f) : root.setTimeout(f, 16));

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

  /* ---- artwork: only rows that come on screen, one picture per animation frame ---- */
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
    while (artQueue.length) {
      const job = artQueue.shift();
      if (job.tile.isConnected === false) continue;
      const uri = artFor(job.track);
      if (uri) { job.tile.style.setProperty('--pe-cover', 'url("' + uri + '")'); job.tile.setAttribute('data-pe-cover', '1'); }
      break;
    }
    if (artQueue.length) scheduleArt();
  }

  function scheduleArt() {
    if (artTimer) return;
    artTimer = -1;
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
    layer.id = 'pe-layer';
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-label', 'Edit playlist');

    const bar = el('div', 'pe-bar');
    const back = button('pe-back', 'Back');
    back.appendChild(icon('i-chev-left'));
    back.addEventListener('click', close);
    titleNode = el('div', 'pe-title', 'Edit playlist');
    saveBtn = button('pe-save', 'Save');
    saveBtn.textContent = 'Save';
    saveBtn.disabled = true;
    saveBtn.addEventListener('click', save);
    bar.appendChild(back);
    bar.appendChild(titleNode);
    bar.appendChild(saveBtn);
    layer.appendChild(bar);

    list = el('div', 'pe-list');
    if (typeof root.IntersectionObserver === 'function') {
      try { seen = new root.IntersectionObserver(onSeen, { root: list, rootMargin: '240px 0px' }); } catch (e) { seen = null; }
    }
    list.addEventListener('scroll', () => {
      if (ctx && ctx.pending.length && list.scrollTop + list.clientHeight >= list.scrollHeight - 600) drawMore();
    });
    layer.appendChild(list);

    selectBar = el('div', 'pe-selectbar');
    pill = button('pe-pill', 'Select songs');
    pill.textContent = 'Select';
    pill.addEventListener('click', () => setSelecting(true));
    cancelPill = button('pe-pill', 'Stop selecting');
    cancelPill.textContent = 'Cancel';
    cancelPill.addEventListener('click', () => setSelecting(false));
    removePill = button('pe-pill danger', 'Remove the selected songs');
    removePill.addEventListener('click', removeSelected);
    selectBar.appendChild(pill);
    selectBar.appendChild(cancelPill);
    selectBar.appendChild(removePill);
    layer.appendChild(selectBar);
    doc.body.appendChild(layer);
    if (root.SpotifyUI && root.SpotifyUI.syncTint) root.SpotifyUI.syncTint();      // the song colours, if a song is loaded
  }

  function markDirty() {
    if (!ctx) return;
    ctx.dirty = true;
    saveBtn.disabled = false;
  }

  function setSelecting(on) {
    if (!ctx) return;
    ctx.selecting = !!on;
    ctx.selected.clear();
    layer.classList.toggle('selecting', ctx.selecting);
    Array.prototype.forEach.call(list.children, (row) => row.classList.remove('picked'));
    pill.classList.toggle('hidden', ctx.selecting);
    cancelPill.classList.toggle('hidden', !ctx.selecting);
    removePill.classList.toggle('hidden', !ctx.selecting);
    updateSelectLabel();
  }

  function updateSelectLabel() {
    if (!ctx) return;
    const n = ctx.selected.size;
    removePill.textContent = n ? 'Remove ' + n : 'Remove';
    removePill.disabled = n === 0;
  }

  function takeOut(row) {
    const id = row.getAttribute('data-id');
    ctx.removed.add(id);
    ctx.selected.delete(id);
    if (seen) seen.unobserve(row);
    if (row.parentNode) row.parentNode.removeChild(row);
    markDirty();
  }

  function removeSelected() {
    if (!ctx || !ctx.selected.size) return;
    const rows = Array.prototype.filter.call(list.children, (row) => ctx.selected.has(row.getAttribute('data-id')));
    rows.forEach(takeOut);
    setSelecting(false);
    toast(rows.length === 1 ? 'Song taken out. Save to keep it.' : rows.length + ' songs taken out. Save to keep that.');
    if (!list.children.length && ctx.pending.length) drawMore();
  }

  function makeRow(track) {
    const row = el('div', 'pe-row');
    row.setAttribute('data-id', track.id);
    const minus = button('pe-minus', 'Take out: ' + (track.title || 'song'));
    minus.appendChild(icon('i-circle-minus', 'pe-i-minus'));
    minus.appendChild(icon('i-check', 'pe-i-check'));
    minus.addEventListener('click', () => {
      if (!ctx) return;
      if (ctx.selecting) { togglePicked(row); return; }
      takeOut(row);
    });
    row.appendChild(minus);
    const tile = el('div', 'pe-art');
    tile.appendChild(icon('i-moon-music'));
    row.appendChild(tile);
    const text = el('div', 'pe-text');
    text.appendChild(el('div', 'pe-name', track.title || 'Unknown song'));
    if (track.artist) text.appendChild(el('div', 'pe-artist', track.artist));
    text.addEventListener('click', () => { if (ctx && ctx.selecting) togglePicked(row); });
    row.appendChild(text);
    const grip = button('pe-grip', 'Drag to move: ' + (track.title || 'song'));
    grip.appendChild(icon('i-menu'));
    grip.addEventListener('pointerdown', (e) => startDrag(row, e));
    row.appendChild(grip);
    if (seen) { rowJobs.set(row, { tile: tile, track: track }); seen.observe(row); }
    else queueArt(tile, track);
    return row;
  }

  function togglePicked(row) {
    const id = row.getAttribute('data-id');
    if (ctx.selected.has(id)) { ctx.selected.delete(id); row.classList.remove('picked'); }
    else { ctx.selected.add(id); row.classList.add('picked'); }
    updateSelectLabel();
  }

  function drawMore() {
    if (!ctx || !ctx.pending.length) return;
    ctx.pending.splice(0, CHUNK).forEach((t) => list.appendChild(makeRow(t)));
  }

  /* ---- dragging: fixed row height, so the position is index * ROW_H ---- */
  function startDrag(row, e) {
    if (!ctx || ctx.selecting || ctx.drag) return;
    if (e.preventDefault) e.preventDefault();
    const rows = Array.prototype.slice.call(list.children);
    const idx = rows.indexOf(row);
    if (idx < 0) return;
    const grip = e.currentTarget || e.target;
    try { if (grip && grip.setPointerCapture && e.pointerId !== undefined) grip.setPointerCapture(e.pointerId); } catch (err) { /* the move listeners below still work */ }
    const drag = { row: row, startIdx: idx, curIdx: idx, startY: e.clientY, startScroll: list.scrollTop, lastY: e.clientY, grip: grip, raf: 0 };
    ctx.drag = drag;
    row.classList.add('dragging');
    drag.move = (ev) => { drag.lastY = ev.clientY; follow(); };
    drag.up = () => endDrag();
    doc.addEventListener('pointermove', drag.move);
    doc.addEventListener('pointerup', drag.up);
    doc.addEventListener('pointercancel', drag.up);
    autoScroll();
  }

  // Puts the dragged row under the finger: the DOM position follows the finger in whole rows, the transform
  // covers the rest.
  function follow() {
    const d = ctx && ctx.drag;
    if (!d) return;
    const dy = (d.lastY - d.startY) + (list.scrollTop - d.startScroll);
    const count = list.children.length;
    const want = Math.max(0, Math.min(count - 1, d.startIdx + Math.round(dy / ROW_H)));
    if (want !== d.curIdx) {
      const rows = Array.prototype.slice.call(list.children);
      list.insertBefore(d.row, want > d.curIdx ? (rows[want + 1] || null) : rows[want]);
      d.curIdx = want;
    }
    d.row.style.transform = 'translateY(' + (dy - (d.curIdx - d.startIdx) * ROW_H) + 'px)';
  }

  function autoScroll() {
    const d = ctx && ctx.drag;
    if (!d) return;
    if (list.getBoundingClientRect) {
      const r = list.getBoundingClientRect();
      if (d.lastY < r.top + 90) list.scrollTop -= 14;
      else if (d.lastY > r.bottom - 90) list.scrollTop += 14;
      follow();
    }
    d.raf = nextFrame(autoScroll);
  }

  function endDrag() {
    const d = ctx && ctx.drag;
    if (!d) return;
    ctx.drag = null;
    doc.removeEventListener('pointermove', d.move);
    doc.removeEventListener('pointerup', d.up);
    doc.removeEventListener('pointercancel', d.up);
    if (d.raf && typeof root.cancelAnimationFrame === 'function') root.cancelAnimationFrame(d.raf);
    d.row.classList.remove('dragging');
    d.row.style.transform = '';
    if (d.curIdx !== d.startIdx) markDirty();
  }

  /* ---- order, save, open, close ---- */
  function currentOrder() {
    const ids = Array.prototype.map.call(list.children, (row) => row.getAttribute('data-id'));
    return ids.concat(ctx.pending.map((t) => t.id));
  }

  function save() {
    if (!ctx || !ctx.dirty) return;
    const a = audio();
    if (!a || !a.applyPlaylistEdit) { toast('Could not save the playlist'); return; }
    const r = a.applyPlaylistEdit(ctx.key, currentOrder(), Array.from(ctx.removed));
    if (!r.ok) { toast('Could not save the playlist'); return; }
    const done = ctx.removed.size;
    ctx.dirty = false;
    closeNow();
    toast(done ? 'Playlist updated. ' + (done === 1 ? '1 song' : done + ' songs') + ' taken out.' : 'Playlist updated');
  }

  function open(key, title) {
    const a = audio();
    if (!a || !a.applyPlaylistEdit || !a.getPlaylistInfo || !a.getPlaylistInfo(String(key || ''))) return false;
    build();
    endDrag();
    const tracks = a.getPlaylistTracks(keyToName(String(key)));
    ctx = { key: String(key), title: title || '', pending: tracks.slice(), removed: new Set(), selected: new Set(), dirty: false, selecting: false, armed: false, drag: null };
    saveBtn.disabled = true;
    list.replaceChildren();
    list.scrollTop = 0;
    if (!tracks.length) list.appendChild(el('div', 'pe-empty', 'No songs in this playlist yet.'));
    else drawMore();
    setSelecting(false);
    pill.classList.toggle('hidden', !tracks.length);
    layer.classList.remove('hidden');
    return true;
  }

  function keyToName(key) { return key.indexOf('list:') === 0 ? '@list:' + key.slice(5) : key.replace(/^name:/, ''); }

  // Back arrow / Android Back: leaves selecting first; with unsaved changes the first press only warns.
  function close() {
    if (!layer || layer.classList.contains('hidden') || !ctx) return;
    if (ctx.selecting) { setSelecting(false); return; }
    if (ctx.dirty && !ctx.armed) {
      ctx.armed = true;
      toast('Unsaved changes. Tap back again to discard them.');
      root.setTimeout(() => { if (ctx) ctx.armed = false; }, 3500);
      return;
    }
    closeNow();
  }

  function closeNow() {
    if (!layer) return;
    endDrag();
    layer.classList.add('hidden');
    artQueue.length = 0;
    if (seen) seen.disconnect();
    list.replaceChildren();
    ctx = null;
  }

  function isOpen() { return !!(layer && !layer.classList.contains('hidden')); }

  root.PlaylistEditor = { open: open, close: close, isOpen: isOpen };
})(typeof window !== 'undefined' ? window : this);
