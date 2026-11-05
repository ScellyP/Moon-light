/* ============================================================================
   Song options ("..." menu)
   ============================================================================
   The three dots next to a song (Songs list, Search results, Home's recently played, and the player's own
   "..." sheet) open one bottom sheet, like Spotify's:

     Edit song info             -> title, artist, album
     Share song                 -> Android's share sheet with the song's file (mp3) for messaging apps, Bluetooth, Drive...
     Share                      -> the song's link (the page it was downloaded from) in the share sheet, no file; only for songs that have one
     Like / Remove from Liked Songs
     Add to playlist            -> a playlist picker (and "New playlist")
     Move to another playlist   -> only when opened from inside a playlist
     Remove from this playlist  -> only when opened from inside a playlist (the song file is NOT deleted)
     Add to Queue               -> plays right after the song that is playing now
     Go to Queue                -> shows this song in the Songs list, scrolled to and flashed
     Play on loop / Stop looping
     Delete                     -> deletes the song FILE for good (after a confirmation), unlike "Remove from this playlist"

   HOW A "..." BUTTON ASKS FOR IT
     Any element with data-song-more="<song id>" opens the sheet when tapped. Add data-song-ctx="1" when the
     button sits inside a playlist's own list (a button inside the Songs list, #audio-queue, counts too): the
     sheet then also offers Move / Remove for the playlist that is shown. This file listens at the very start of the click (capture), so a row's own tap handler
     (play the song) does not also run.

   EDITS ARE AN OVERLAY. "Edit song info" changes what Moonlight shows (list, player, search, notification);
   the music file and its tags are never rewritten, so every format works and "Reset to the file's info"
   always brings the original back (see SongEdits.kt).

   Needs window.NovelAudio (audio-player.js). Outside the Android app the edit and the playlist-file actions
   say they could not be saved; Like, loop and hand-picked playlists still work.
   ========================================================================= */
(function (root) {
  'use strict';

  const doc = root.document;
  if (!doc) return;

  let layer = null;       // the sheet, built on first use
  let body = null;
  let toastNode = null;
  let toastTimer = 0;
  let current = null;     // { id, ctx }: the song the sheet is about, and the playlist key it was opened from ('' = none)

  const audio = () => root.NovelAudio || null;

  /* ---- tiny DOM helpers ------------------------------------------------------------------------- */
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
    if (!toastNode) {
      toastNode = el('div', 'sm-toast');
      toastNode.setAttribute('role', 'status');
      doc.body.appendChild(toastNode);
    }
    toastNode.textContent = message;
    toastNode.classList.add('show');
    if (toastTimer) root.clearTimeout(toastTimer);
    toastTimer = root.setTimeout(() => { toastNode.classList.remove('show'); }, 2200);
  }

  // Opens the phone's share sheet with the link. Outside the Android app: the browser's share, else copy to the clipboard.
  function shareLink(link) {
    const b = root.AndroidBridge;
    try {
      if (b && typeof b.shareText === 'function' && b.shareText(link)) return;
    } catch (e) { /* fall through */ }
    try {
      const nav = root.navigator;
      if (nav && nav.share) { nav.share({ text: link }); return; }
      if (nav && nav.clipboard && nav.clipboard.writeText) { nav.clipboard.writeText(link); toast('Link copied'); return; }
    } catch (e) { /* nothing more to try */ }
    toast('Could not share this song');
  }

  /* ---- the sheet ----------------------------------------------------------------------------------- */
  function build() {
    if (layer) return;
    layer = el('div', 'sm-layer hidden');
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'true');
    layer.setAttribute('aria-label', 'Song options');
    const scrim = el('div', 'sm-scrim');
    scrim.setAttribute('data-sm-close', '');
    body = el('div', 'sm-body');
    layer.appendChild(scrim);
    layer.appendChild(body);
    doc.body.appendChild(layer);
    layer.addEventListener('click', (e) => {
      if (e.target.closest && e.target.closest('[data-sm-close]')) close();
    });
    doc.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close(); });
  }

  function isOpen() { return !!(layer && !layer.classList.contains('hidden')); }

  function close() {
    if (layer) layer.classList.add('hidden');
    current = null;
  }

  function trackOf() {
    const a = audio();
    return a && current ? a.getTrackRecord(current.id) : null;
  }

  // The song's header, like Spotify's: cover, title, "artist \u2022 album". With the grip on top it is also the
  // part you drag down to close the sheet.
  function header(track) {
    const zone = el('div', 'sm-drag');
    zone.appendChild(el('div', 'sm-grip'));
    const head = el('div', 'sm-head');
    const tile = el('div', 'sm-cover');
    tile.appendChild(icon('i-moon-music'));
    try {
      const b = root.AndroidBridge;
      const uri = b && b.getArtwork && track.path ? b.getArtwork(track.path) : '';
      if (uri) { tile.style.setProperty('--sm-cover', 'url("' + uri + '")'); tile.setAttribute('data-sm-cover', '1'); }
    } catch (e) { /* the placeholder stays */ }
    const text = el('div', 'sm-head-text');
    text.appendChild(el('div', 'sm-title', track.title || ''));
    const sub = [track.artist, track.album].filter(Boolean).join(' \u2022 ');
    if (sub) text.appendChild(el('div', 'sm-artist', sub));
    head.appendChild(tile);
    head.appendChild(text);
    zone.appendChild(head);
    enableSwipeDown(zone);
    return zone;
  }

  // Dragging the header down more than ~90px closes the sheet; a shorter drag springs back.
  function enableSwipeDown(handle) {
    let y0 = null;
    let dy = 0;
    handle.addEventListener('touchstart', (e) => {
      y0 = e.touches[0].clientY;
      dy = 0;
      body.style.transition = 'none';
    }, { passive: true });
    handle.addEventListener('touchmove', (e) => {
      if (y0 === null) return;
      dy = Math.max(0, e.touches[0].clientY - y0);
      body.style.transform = 'translateY(' + dy + 'px)';
    }, { passive: true });
    const end = () => {
      if (y0 === null) return;
      y0 = null;
      body.style.transition = '';
      body.style.transform = '';
      if (dy > 90) close();
    };
    handle.addEventListener('touchend', end);
    handle.addEventListener('touchcancel', end);
  }

  function row(iconId, label, onTap, opts) {
    const o = opts || {};
    const b = button('sm-row' + (o.active ? ' active' : '') + (o.danger ? ' danger' : ''), label);
    b.appendChild(icon(iconId, o.fill ? 'fill' : ''));
    b.appendChild(el('span', 'sm-row-label', label));
    if (o.note) b.appendChild(el('em', 'sm-row-note', o.note));
    b.addEventListener('click', onTap);
    return b;
  }

  /* ---- view: the menu -------------------------------------------------------------------------------- */
  function showMenu() {
    const a = audio();
    const track = trackOf();
    if (!a || !track) { close(); return; }
    body.replaceChildren();
    body.appendChild(header(track));
    const list = el('div', 'sm-list');

    // Where Spotify has "Share": Edit.
    list.appendChild(row('i-pencil', 'Edit song info', () => showEdit(), { note: track.edited ? 'Edited' : '' }));

    // Sends the song file itself (the mp3) to any app that takes audio: WhatsApp, Telegram, Bluetooth, Drive, mail...
    list.appendChild(row('i-share', 'Share song', () => {
      const ok = a.shareSong(track.id);
      if (!ok) toast('Could not share this song');
      close();
    }));

    // Share: just the song's link (where it was downloaded from), no file. Only shown for songs that have one, and it
    // simply says "Share".
    if (track.source) list.appendChild(row('i-link', 'Share', () => { shareLink(track.source); close(); }));

    const liked = !!(a.isLiked && a.isLiked(track.id));
    list.appendChild(row('i-heart', liked ? 'Remove from Liked Songs' : 'Add to Liked Songs', () => {
      const now = a.toggleLike(track.id);
      toast(now ? 'Added to Liked Songs' : 'Removed from Liked Songs');
      close();
    }, { active: liked, fill: liked }));

    list.appendChild(row('i-circle-plus', 'Add to playlist', () => showPicker('add')));

    if (current.ctx) {
      list.appendChild(row('i-move', 'Move to another playlist', () => showPicker('move')));
      list.appendChild(row('i-circle-minus', 'Remove from this playlist', () => {
        const ok = a.removeSongFromPlaylist(current.ctx, track.id);
        toast(ok ? 'Removed from this playlist' : 'Could not remove it from this playlist');
        close();
      }));
    }

    list.appendChild(row('i-queue-add', 'Add to Queue', () => {
      const ok = a.addToQueue(track.id);
      toast(ok ? 'Added to queue' : 'This song is playing now');
      close();
    }));

    list.appendChild(row('i-queue', 'Go to Queue', () => {
      const id = track.id;
      close();
      if (root.SpotifyUI && root.SpotifyUI.setView) root.SpotifyUI.setView('album');      // the Songs tab
      root.setTimeout(() => { a.revealSong(id); }, 120);
    }));

    const looping = !!(a.isLoopingSong && a.isLoopingSong(track.id));
    list.appendChild(row('i-repeat-one', looping ? 'Stop looping this song' : 'Play on loop', () => {
      const now = a.loopSong(track.id);
      toast(now ? 'Playing this song on loop' : 'Loop off');
      close();
    }, { active: looping }));

    // The last row: deletes the file itself (after a confirmation). Same colour as the other rows.
    list.appendChild(row('i-trash', 'Delete', () => showDelete()));

    body.appendChild(list);
    const done = button('sm-close', 'Close');
    done.textContent = 'Close';
    done.setAttribute('data-sm-close', '');
    body.appendChild(done);
  }

  /* ---- view: delete the song from the phone ------------------------------------------------------------- */
  // Unlike "Remove from this playlist", this deletes the music FILE for good (there is no recycle bin).
  function showDelete() {
    const a = audio();
    const track = trackOf();
    if (!a || !track) { close(); return; }
    body.replaceChildren();
    body.appendChild(backBar('Delete song'));
    const box = el('div', 'sm-form');
    box.appendChild(el('p', 'sm-warn-title', '\u201c' + (track.title || 'This song') + '\u201d'));
    box.appendChild(el('p', 'sm-hint',
      'This deletes the song file from your phone for good, and takes it out of every playlist, Liked Songs and the history. It cannot be undone.'));
    const actions = el('div', 'sm-actions');
    const del = button('sm-btn danger', 'Delete forever');
    del.textContent = 'Delete forever';
    del.addEventListener('click', () => {
      const title = track.title || 'song';
      const ok = a.deleteSong(track.id);
      toast(ok ? 'Deleted \u201c' + title + '\u201d' : 'Could not delete the file');
      close();
    });
    const keep = button('sm-btn', 'Cancel');
    keep.textContent = 'Cancel';
    keep.addEventListener('click', showMenu);
    actions.appendChild(del);
    actions.appendChild(keep);
    box.appendChild(actions);
    body.appendChild(box);
  }

  /* ---- view: the playlist picker ---------------------------------------------------------------------- */
  function backBar(title) {
    const bar = el('div', 'sm-bar');
    const back = button('sm-back', 'Back');
    back.appendChild(icon('i-chev-left'));
    back.addEventListener('click', showMenu);
    bar.appendChild(back);
    bar.appendChild(el('div', 'sm-bar-title', title));
    return bar;
  }

  // mode 'add': put the song into the tapped playlist. mode 'move': also take it out of the playlist the sheet came from.
  function showPicker(mode) {
    const a = audio();
    const track = trackOf();
    if (!a || !track) { close(); return; }
    body.replaceChildren();
    body.appendChild(backBar(mode === 'move' ? 'Move to playlist' : 'Add to playlist'));
    const list = el('div', 'sm-list sm-picker');

    const finish = (key, name) => {
      let ok = true;
      if (mode === 'move' && current.ctx && current.ctx !== key) ok = a.removeSongFromPlaylist(current.ctx, track.id);
      toast(ok ? (mode === 'move' ? 'Moved to ' : 'Added to ') + name : 'Could not change the playlists');
      close();
    };

    // New playlist: a name box, then the song goes in.
    const make = el('form', 'sm-new');
    const input = el('input', 'sm-input');
    input.type = 'text';
    input.placeholder = 'New playlist';
    input.maxLength = 60;
    input.setAttribute('aria-label', 'New playlist name');
    const create = button('sm-btn primary', 'Create playlist');
    create.type = 'submit';
    create.textContent = 'Create';
    make.appendChild(input);
    make.appendChild(create);
    make.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      const key = a.createPlaylistWith(name, track.id);
      if (!key) { toast('Could not create the playlist'); return; }
      finish(key, name);
    });
    list.appendChild(make);

    const here = new Set(a.getSongPlaylists(track.id));
    const targets = a.getPlaylistTargets().filter((t) => !(mode === 'move' && t.key === current.ctx));
    if (!targets.length) list.appendChild(el('div', 'sm-empty', 'No playlists yet. Create one above.'));
    targets.forEach((t) => {
      const inIt = here.has(t.key);
      const r = button('sm-row' + (inIt ? ' active' : ''), t.name + (inIt ? ', already in it' : ''));
      r.appendChild(icon(inIt ? 'i-check' : 'i-circle-plus'));
      r.appendChild(el('span', 'sm-row-label', t.name));
      r.appendChild(el('em', 'sm-row-note', String(t.count)));
      r.addEventListener('click', () => {
        if (inIt && mode === 'add') { toast('Already in ' + t.name); return; }
        const ok = inIt ? true : a.addSongToPlaylist(t.key, track.id);
        if (!ok) { toast('Could not add it to ' + t.name); return; }
        finish(t.key, t.name);
      });
      list.appendChild(r);
    });
    body.appendChild(list);
  }

  /* ---- view: edit song info --------------------------------------------------------------------------- */
  function showEdit() {
    const a = audio();
    const track = trackOf();
    if (!a || !track) { close(); return; }
    body.replaceChildren();
    body.appendChild(backBar('Edit song info'));
    const form = el('form', 'sm-form');

    const fields = {};
    const order = ['title', 'artist', 'album'];

    // A box grows with its text (up to its max height in CSS), so a long title or album is readable, not cut off.
    const grow = (box) => {
      if (typeof box.scrollHeight !== 'number') return;
      box.style.height = 'auto';
      box.style.height = box.scrollHeight + 2 + 'px';
    };

    [['title', 'Title', track.title], ['artist', 'Artist', track.artist], ['album', 'Album', track.album]].forEach(([key, label, value]) => {
      const wrap = el('label', 'sm-field');
      wrap.appendChild(el('span', 'sm-field-label', label));
      const input = el('textarea', 'sm-input');
      input.rows = 1;
      input.maxLength = 200;
      input.value = value || '';
      input.setAttribute('data-sm-field', key);
      input.setAttribute('enterkeyhint', key === 'album' ? 'done' : 'next');
      input.addEventListener('input', () => {
        if (/[\r\n]/.test(input.value)) input.value = input.value.replace(/[\r\n]+/g, ' ');     // one line of data: Enter never adds a break
        grow(input);
      });
      // Enter: on to the next box, and Save from the last one.
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const next = fields[order[order.indexOf(key) + 1]];
        if (next) next.focus(); else if (form.requestSubmit) form.requestSubmit(); else form.dispatchEvent(new root.Event('submit', { cancelable: true }));
      });
      // The keyboard slides up after the tap: bring the box into view once the sheet has moved above it.
      input.addEventListener('focus', () => {
        root.setTimeout(() => { if (input.scrollIntoView) input.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 300);
      });
      fields[key] = input;
      wrap.appendChild(input);
      form.appendChild(wrap);
    });
    root.setTimeout(() => { order.forEach((k) => grow(fields[k])); }, 0);

    form.appendChild(el('p', 'sm-hint',
      'Several artists: separate them with ; \u2013 for example \u201cA; B\u201d. This only changes how Moonlight shows the song. The music file is not changed.'));

    const actions = el('div', 'sm-actions');
    const save = button('sm-btn primary', 'Save');
    save.type = 'submit';
    save.textContent = 'Save';
    actions.appendChild(save);
    if (track.edited) {
      const reset = button('sm-btn', 'Reset to the file\u2019s info');
      reset.textContent = 'Reset to the file\u2019s info';
      reset.addEventListener('click', () => {
        const info = a.resetSongEdit(track.id);
        toast(info ? 'Back to the file\u2019s info' : 'Could not reset');
        if (info) close();
      });
      actions.appendChild(reset);
    }
    form.appendChild(actions);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const title = fields.title.value.trim();
      if (!title) { toast('A song needs a title'); fields.title.focus(); return; }
      const info = a.editSong(track.id, { title: title, artist: fields.artist.value.trim(), album: fields.album.value.trim() });
      toast(info ? 'Song info saved' : 'Could not save the changes');
      if (info) close();
    });
    body.appendChild(form);
    root.setTimeout(() => { try { fields.title.focus(); } catch (err) { /* no keyboard */ } }, 0);
  }

  /* ---- view: change a playlist's cover ----------------------------------------------------------------- */
  // The cover is kept natively (Moonlight/playlist-covers) and stays as chosen while songs play. It can come from
  // the gallery or from the cover of one of the playlist's own songs, or go back to the automatic mosaic.
  let coverCtx = null;           // { name, title }

  function bridge() { return root.AndroidBridge || null; }

  function coverChanged(name) {
    if (root.SpotifyUI && root.SpotifyUI.coverChanged) root.SpotifyUI.coverChanged(name);
  }

  function showCover() {
    if (!coverCtx) { close(); return; }
    const b = bridge();
    body.replaceChildren();
    const zone = el('div', 'sm-drag');
    zone.appendChild(el('div', 'sm-grip'));
    const head = el('div', 'sm-head');
    const tile = el('div', 'sm-cover');
    tile.appendChild(icon('i-moon-music'));
    const url = root.SpotifyUI && root.SpotifyUI.getCover ? root.SpotifyUI.getCover(coverCtx.name) : '';
    if (url) { tile.style.setProperty('--sm-cover', 'url("' + url + '")'); tile.setAttribute('data-sm-cover', '1'); }
    const text = el('div', 'sm-head-text');
    text.appendChild(el('div', 'sm-title', coverCtx.title || 'Playlist'));
    text.appendChild(el('div', 'sm-artist', 'Change the playlist cover'));
    head.appendChild(tile);
    head.appendChild(text);
    zone.appendChild(head);
    enableSwipeDown(zone);
    body.appendChild(zone);

    const list = el('div', 'sm-list');
    list.appendChild(row('i-image', 'Choose from gallery', () => {
      if (!b || !b.playlistCoverPick) { toast('Only available in the Moonlight app'); return; }
      b.playlistCoverPick(coverCtx.name);          // the answer comes back through window.onPlaylistCoverPicked
      close();
    }));
    list.appendChild(row('i-moon-music', 'Pick from this playlist\u2019s songs', () => showCoverSongs()));
    let hasCustom = false;
    try { hasCustom = !!(b && b.playlistCoverGet && b.playlistCoverGet(coverCtx.name)); } catch (e) { hasCustom = false; }
    if (hasCustom) {
      list.appendChild(row('i-refresh', 'Use the automatic cover', () => {
        let ok = false;
        try { ok = !!(b && b.playlistCoverClear && b.playlistCoverClear(coverCtx.name)); } catch (e) { ok = false; }
        if (ok) coverChanged(coverCtx.name);
        toast(ok ? 'Back to the automatic cover' : 'Could not change the cover');
        close();
      }));
    }
    body.appendChild(list);
    const done = button('sm-close', 'Close');
    done.textContent = 'Close';
    done.setAttribute('data-sm-close', '');
    body.appendChild(done);
  }

  // A grid of the covers of the playlist's songs (only songs that have one), filled in a few at a time.
  function showCoverSongs() {
    const a = audio();
    const b = bridge();
    if (!coverCtx || !a) { close(); return; }
    body.replaceChildren();
    const bar = el('div', 'sm-bar');
    const back = button('sm-back', 'Back');
    back.appendChild(icon('i-chev-left'));
    back.addEventListener('click', showCover);
    bar.appendChild(back);
    bar.appendChild(el('div', 'sm-bar-title', 'Pick a song\u2019s cover'));
    body.appendChild(bar);
    const grid = el('div', 'sm-grid');
    const note = el('div', 'sm-empty', 'Looking through the songs\u2026');
    body.appendChild(note);
    body.appendChild(grid);
    const tracks = a.getPlaylistTracks(coverCtx.name).filter((t) => t && t.path);
    const name = coverCtx.name;
    let i = 0;
    let shown = 0;
    const MAX = 60;
    const seen = {};
    const step = () => {
      if (!isOpen() || !coverCtx || coverCtx.name !== name) return;
      for (let n = 0; n < 6 && i < tracks.length && shown < MAX; n++, i++) {
        let uri = '';
        try { uri = b && b.getArtwork ? (b.getArtwork(tracks[i].path) || '') : ''; } catch (e) { uri = ''; }
        const sig = uri.length + uri.slice(-40);
        if (!uri || seen[sig]) continue;               // no cover, or the same picture again (one album)
        seen[sig] = true;
        const t = button('sm-tile', 'Use the cover of ' + (tracks[i].title || 'this song'));
        t.style.setProperty('--sm-cover', 'url("' + uri + '")');
        t.addEventListener('click', () => {
          let ok = false;
          try { ok = !!(b && b.playlistCoverSave && b.playlistCoverSave(name, uri)); } catch (e) { ok = false; }
          if (ok) coverChanged(name);
          toast(ok ? 'Playlist cover changed' : 'Could not use that picture');
          if (ok) close();
        });
        grid.appendChild(t);
        shown++;
      }
      if (i < tracks.length && shown < MAX) root.setTimeout(step, 30);
      else note.textContent = shown ? '' : 'None of these songs has a cover picture.';
    };
    step();
  }

  function openCover(name, title) {
    build();
    current = { id: '', ctx: '' };
    coverCtx = { name: String(name || 'all'), title: title || '' };
    body.style.transform = '';
    layer.classList.remove('hidden');
    showCover();
    return true;
  }

  /* ---- public ------------------------------------------------------------------------------------------ */
  // ctx: the key of the playlist the song is listed in ('list:3' / 'name:Lo-fi'), or '' when not opened from a playlist.
  function open(id, ctx) {
    const a = audio();
    if (!a || !id || !a.getTrackRecord(id)) return false;
    build();
    current = { id: String(id), ctx: ctx || '' };
    body.style.transform = '';
    layer.classList.remove('hidden');
    showMenu();
    return true;
  }

  root.SongMenu = { open: open, close: close, isOpen: isOpen, openCover: openCover, toast: toast };

  // Any "..." button on the page: <button data-song-more="<id>" [data-song-ctx="1"]>.
  const EDGE = 50;                        // px at the right end of a Songs-list row that count as its "..." button

  doc.addEventListener('click', (e) => {
    const target = e.target;
    if (!target || !target.closest) return;
    const a = audio();

    const t = target.closest('[data-song-more]');
    if (t) {
      e.preventDefault();
      e.stopPropagation();                // the row's own tap (play the song) must not run too
      const inList = !!(t.getAttribute('data-song-ctx'));
      open(t.getAttribute('data-song-more'), inList && a && a.getActivePlaylistKey ? a.getActivePlaylistKey() : '');
      return;
    }

    // The Songs list draws its "..." with CSS on the row itself (no element per row): a tap on the right end of a row is it.
    const li = target.closest('#audio-queue li');
    if (li && li.dataset && li.dataset.trackId && typeof e.clientX === 'number' && li.getBoundingClientRect) {
      if (e.clientX >= li.getBoundingClientRect().right - EDGE) {
        e.preventDefault();
        e.stopPropagation();
        open(li.dataset.trackId, a && a.getActivePlaylistKey ? a.getActivePlaylistKey() : '');
      }
    }
  }, true);
})(typeof window !== 'undefined' ? window : this);
