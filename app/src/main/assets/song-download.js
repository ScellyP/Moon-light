/* =========================================================================
   Download songs tab (music panel -> bottom bar -> "Download")
   -------------------------------------------------------------------------
   A step-by-step wizard, one step on screen at a time (each new step replaces
   the one before it):

     1. paste      "Click to paste" reads the clipboard; every web link found on it
                   is one song (up to 50). Songs go through steps 2-5 one after
                   another.
     2. download   the song downloads into a staging folder (nothing shows up in
                   the library yet). While you name and place a song, the NEXT
                   song already downloads in the background. A failed download
                   offers Retry and Skip.
     3. name       the song's thumbnail and its name, editable; Save.
     4. playlist   tiles: "New playlist" first, then the playlist folders, then
                   "No playlist" (the song stays directly in Audio/).
     5. place      the song is renamed (file name and title tag), moved into the
                   chosen folder, the library is rescanned and the song starts
                   playing in that playlist. Then on to the next song.

   Leaving the tab (the ✕, another tab, closing the panel) before a song is
   placed cancels the running downloads and deletes every staged song.

   The work itself runs natively: MainActivity's AndroidBridge hands each job to
   SongDownloader.kt, which runs the yt-dlp that is bundled in the app. The contract:

     page   -> AndroidBridge.stageSong(jobId, url)
               AndroidBridge.placeSong(jobId, path, name, folder)  folder "" = none, name "" = keep
               AndroidBridge.cancelSongDownload()                   stops every job
               AndroidBridge.discardStagedSongs()                   deletes the staging folder
               AndroidBridge.readClipboard()                        the clipboard's text
               AndroidBridge.getArtwork(path)                       the thumbnail (data: URL or "")
               AndroidBridge.songStageCrop(path, x, y, size)        the square of the thumbnail to use as the cover
                                                                    (fractions; size -1 = the whole picture)
     native -> window.onSongDownloadStatus(jobId, "running"|"done"|"failed", message)
               exactly one done/failed per job; the message of a "done" is a file
               path (the staged file for stageSong, the song's new path for placeSong).
     player -> NovelAudio.playAfterRescan(path, playlist), NovelAudio.getPlaylists(),
               SpotifyUI.getCover(playlistName)

   Without the native hook a job fails at once with "Not connected to the app yet".
   Playlist and song names are cleaned here (cleanFolderName, cleanSongName) and again
   natively (SongNames.kt, which must give the same answers).

   The pure parts (parseLinks, cleanFolderName, cleanSongName, shortLink, stemOf,
   createWizard) are exported for tests/song-download.test.js.
   ========================================================================= */
(function (root) {
  'use strict';

  const MAX_LINKS = 50;

  /* =======================================================================
     Pure helpers (tested)
     ======================================================================= */

  // Letters, digits, space and _ - ( ) . & ' , only. Same rule as SongNames.cleanFolder in SongNames.kt.
  // Leading/trailing dots go so ".." can never climb out of the Audio folder.
  function cleanFolderName(name) {
    return String(name == null ? '' : name)
      .replace(/[^A-Za-z0-9 _\-().&',]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+|\.+$/g, '')
      .trim()
      .slice(0, 60);
  }

  // A song's file name: any language is fine, but not the characters a file name cannot hold
  // (/ \ : * ? " < > |); tabs, line breaks and other control characters become spaces. At most
  // 120 characters. Same rule as SongNames.cleanSongName in SongNames.kt.
  function cleanSongName(name) {
    const tidy = String(name == null ? '' : name)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+|\.+$/g, '')
      .trim();
    return Array.from(tidy).slice(0, 120).join('');
  }

  // Splits pasted text into web links: pieces separated by spaces, commas or line breaks, anything
  // that is not an http(s) link ignored, duplicates dropped. Share texts such as "Song name
  // https://…" therefore work. Returns { links, skipped }: skipped counts the pieces that were
  // not links.
  function parseLinks(text) {
    const links = [];
    const seen = new Set();
    let skipped = 0;
    String(text == null ? '' : text).split(/[\s,]+/).forEach((piece) => {
      if (!piece) return;
      if (!/^https?:\/\/\S+$/i.test(piece)) { skipped++; return; }
      if (seen.has(piece)) return;
      seen.add(piece);
      links.push(piece);
    });
    return { links: links.slice(0, MAX_LINKS), skipped: skipped + Math.max(0, links.length - MAX_LINKS) };
  }

  // A short title for a link: host + path, without the scheme or tracking query.
  function shortLink(url) {
    const bare = String(url).replace(/^https?:\/\/(www\.)?/i, '').split(/[?#]/)[0].replace(/\/$/, '');
    return bare.length > 48 ? bare.slice(0, 47) + '…' : bare;
  }

  // "/a/b/Some Song.mp3" -> "Some Song"
  function stemOf(path) {
    return String(path == null ? '' : path).split(/[\\/]/).pop().replace(/\.[^.]*$/, '');
  }

  /* -----------------------------------------------------------------------
     The wizard's state machine.
       stage(jobId, url)                        starts a download; return false (or throw) if it cannot start
       place(jobId, path, name, folder)         starts a placement; same
       cancel()                                 stops every running job
       discard()                                deletes every staged song
       play(path, folder)                       a song was placed: start playing it
       onChange(state)                          after any change
     state = { step, items, index, message, error, folder }
       step    paste | download | name | playlist | newplaylist | placing | placefail | done
       items   [{ id, url, state, path, name, error }]
               state: waiting | downloading | ready | failed | placed | skipped
       index   which item the screen is about
     ----------------------------------------------------------------------- */
  function createWizard({ stage, place, cancel, discard, discardOne, play, onPlaced, onChange } = {}) {
    const w = { step: 'paste', items: [], index: 0, message: '', error: '', folder: '' };
    const jobs = {};            // jobId -> { kind: 'stage' | 'place', item }
    let seq = 0;                // job ids never repeat within a session, so a late answer can't be mistaken

    const emit = () => { if (onChange) onChange(w); };
    const current = () => w.items[w.index] || null;
    const stageRunning = () => Object.keys(jobs).some((id) => jobs[id].kind === 'stage');

    function reset() {
      w.step = 'paste'; w.items = []; w.index = 0; w.message = ''; w.error = ''; w.folder = '';
    }

    function startStage(item) {
      const id = 's' + (++seq);
      jobs[id] = { kind: 'stage', item };
      item.state = 'downloading';
      item.error = '';
      let ok = false;
      let why = '';
      try { ok = !!stage && stage(id, item.url) !== false; } catch (e) { why = e && e.message ? e.message : ''; }
      if (!ok) { delete jobs[id]; stageFailed(item, why || 'Could not start the download'); }
    }

    // One download at a time. The song on screen comes first; once it is downloaded, the next one
    // downloads in the background. A failed song holds everything back until the user decides.
    function pump() {
      if (stageRunning()) return;
      const cur = current();
      if (!cur) return;
      if (cur.state === 'waiting') return startStage(cur);
      if (cur.state === 'ready') {
        const next = w.items[w.index + 1];
        if (next && next.state === 'waiting') startStage(next);
      }
    }

    function stageDone(item, path) {
      if (!path) return stageFailed(item, 'The download left no file behind.');
      item.path = path;
      item.name = cleanSongName(stemOf(path));
      item.state = 'ready';
      if (item === current() && w.step === 'download') w.step = 'name';
      emit();
      pump();
    }

    function stageFailed(item, message) {
      item.state = 'failed';
      item.error = message || 'The download failed.';
      emit();
    }

    function startPlace(item) {
      const id = 'p' + (++seq);
      jobs[id] = { kind: 'place', item };
      w.step = 'placing';
      w.error = '';
      let ok = false;
      let why = '';
      try { ok = !!place && place(id, item.path, item.name, w.folder) !== false; } catch (e) { why = e && e.message ? e.message : ''; }
      if (!ok) { delete jobs[id]; placeFailed(why || 'Could not start moving the song'); return; }
      emit();
    }

    function placeFailed(message) {
      w.step = 'placefail';
      w.error = message || 'The song could not be added.';
      emit();
    }

    function placeDone(item, finalPath) {
      item.state = 'placed';
      item.finalPath = finalPath || '';
      // Remember the link and the name it was saved under (downloads.txt), before anything else can go wrong.
      try { if (onPlaced) onPlaced(item, finalPath || '', w.folder); } catch (e) { /* the song is placed either way */ }
      try { if (play && finalPath) play(finalPath, w.folder); } catch (e) { /* the song is placed either way */ }
      advance();
    }

    // On to the next song (the one on screen is placed or skipped).
    function advance() {
      w.index++;
      w.message = '';
      w.error = '';
      w.folder = '';
      const next = current();
      if (!next) w.step = 'done';
      else w.step = next.state === 'ready' ? 'name' : 'download';
      emit();
      pump();
    }

    return {
      state: w,
      // Step 1 -> 2: the links found on the clipboard. Returns false when a run is already going.
      start(urls) {
        if (w.step !== 'paste' || !urls || !urls.length) return false;
        try { if (discard) discard(); } catch (e) { /* nothing staged */ }
        w.items = urls.map((url, i) => ({ id: i + 1, url, state: 'waiting', path: '', name: '', error: '' }));
        w.index = 0;
        w.message = '';
        w.step = 'download';
        emit();
        pump();
        return true;
      },
      // A message on the first step (nothing usable on the clipboard, ...).
      setMessage(text) {
        if (w.step !== 'paste') return;
        w.message = text || '';
        emit();
      },
      // The native side answers here.
      report(id, status, message) {
        const job = jobs[id];
        if (!job || status === 'running') return;
        delete jobs[id];
        const ok = status === 'done';
        if (job.kind === 'stage') return ok ? stageDone(job.item, message) : stageFailed(job.item, message);
        if (job.item !== current()) return;
        return ok ? placeDone(job.item, message) : placeFailed(message);
      },
      retryDownload() {
        const cur = current();
        if (w.step !== 'download' || !cur || cur.state !== 'failed') return;
        cur.state = 'waiting';
        cur.error = '';
        emit();
        pump();
      },
      // Give up on this song and move on to the next. (Nothing was downloaded, so nothing to delete.)
      skip() {
        const cur = current();
        if (w.step !== 'download' || !cur || cur.state !== 'failed') return;
        cur.state = 'skipped';
        advance();
      },
      // "Don't keep this one" (it turned out to be a duplicate): deletes just this downloaded song, not
      // the next one that is downloading in the background, and moves on.
      dropCurrent() {
        const cur = current();
        if (!cur || cur.state !== 'ready' || (w.step !== 'name' && w.step !== 'playlist' && w.step !== 'newplaylist')) return false;
        try { if (discardOne && cur.path) discardOne(cur.path); } catch (e) { /* nothing to delete */ }
        cur.state = 'dropped';
        advance();
        return true;
      },
      // The name being typed (no redraw: the user is typing in the field).
      rename(text) {
        const cur = current();
        if (w.step === 'name' && cur) cur.name = String(text == null ? '' : text);
      },
      // Step 3 -> 4. An emptied name keeps the song's own.
      save() {
        const cur = current();
        if (w.step !== 'name' || !cur) return;
        cur.name = cleanSongName(cur.name) || cleanSongName(stemOf(cur.path));
        w.step = 'playlist';
        emit();
      },
      // The "New playlist" tile.
      chooseNew() {
        if (w.step !== 'playlist') return;
        w.step = 'newplaylist';
        emit();
      },
      // Back from "New playlist" to the tiles.
      backToPlaylists() {
        if (w.step !== 'newplaylist') return;
        w.step = 'playlist';
        emit();
      },
      // Step 4 -> 5. [folder] "" = no playlist. A name that cleans to nothing is refused.
      choose(folder) {
        const cur = current();
        if (!cur || cur.state !== 'ready' || (w.step !== 'playlist' && w.step !== 'newplaylist')) return false;
        const cleaned = cleanFolderName(folder);
        if (String(folder == null ? '' : folder).trim() !== '' && !cleaned) return false;
        w.folder = cleaned;
        startPlace(cur);
        return true;
      },
      // A failed placement: try the same again, or go back and change the name.
      retryPlace() {
        const cur = current();
        if (w.step === 'placefail' && cur) startPlace(cur);
      },
      backToName() {
        if (w.step !== 'placefail') return;
        w.step = 'name';
        emit();
      },
      // The ✕, another tab or closing the panel: stop everything and delete what was staged.
      leave() {
        const active = w.step !== 'paste' && w.step !== 'done';
        Object.keys(jobs).forEach((id) => { delete jobs[id]; });
        if (active) {
          try { if (cancel) cancel(); } catch (e) { /* the jobs end by themselves */ }
          try { if (discard) discard(); } catch (e) { /* nothing to delete */ }
        }
        reset();
        emit();
      },
      // After "All done": back to the first step.
      again() {
        if (w.step !== 'done') return;
        reset();
        emit();
      },
      current,
    };
  }

  const api = { parseLinks, cleanFolderName, cleanSongName, createWizard, shortLink, stemOf };
  // The square frame: `size` is its side as a fraction of the picture's SHORTER side (0.3..1); (cx, cy) is where
  // its centre is wanted, in picture pixels. The frame is kept inside the picture. x, y, size go to the app.
  function cropRect(iw, ih, size, cx, cy) {
    const shorter = Math.min(iw, ih);
    const frac = Math.max(0.3, Math.min(1, Number(size) || 1));
    const side = Math.max(1, shorter * frac);
    const left = Math.min(iw - side, Math.max(0, cx - side / 2));
    const top = Math.min(ih - side, Math.max(0, cy - side / 2));
    return { left: left, top: top, side: side, x: left / iw, y: top / ih, size: side / shorter };
  }
  api.cropRect = cropRect;

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined' || !document.getElementById) return;

  /* =======================================================================
     The tab
     ======================================================================= */

  const $ = (id) => document.getElementById(id);
  const view = $('sp-view-download');
  const stageEl = $('dl-stage');
  if (!view || !stageEl) return;
  const panel = $('audio-panel');

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ico');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#' + name);
    svg.appendChild(use);
    return svg;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(label, className, onClick) {
    const b = el('button', className, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  const bridge = () => root.AndroidBridge;

  function needBridge(method) {
    const b = bridge();
    if (!b || typeof b[method] !== 'function') throw new Error('Not connected to the app yet');
    return b;
  }

  const playlists = () => {
    try { return (root.NovelAudio && root.NovelAudio.getPlaylists && root.NovelAudio.getPlaylists()) || []; }
    catch (e) { return []; }
  };

  function playlistCover(name) {
    try { return (root.SpotifyUI && root.SpotifyUI.getCover && root.SpotifyUI.getCover(name)) || ''; }
    catch (e) { return ''; }
  }

  // A cover like the ones on Home: the picture when there is one, otherwise the theme-coloured mosaic.
  function coverNode(url, tone, iconName, extraClass) {
    const cover = el('span', 'sp-cover' + (extraClass ? ' ' + extraClass : ''));
    cover.setAttribute('data-tone', String(tone % 4));
    cover.appendChild(icon(iconName || 'i-moon-music'));
    if (url) {
      cover.style.setProperty('--sp-cover', 'url("' + url + '")');
      cover.setAttribute('data-sp-cover', '1');
    }
    return cover;
  }


  /* ---- Choosing which part of the thumbnail becomes the cover ------------------------------------------
     YouTube thumbnails are wide (16:9) but a cover is square. In the naming step the picture is tappable: it opens
     a window with the whole thumbnail and a square frame you drag (and zoom with the slider). On Done the page
     shows the cut-out as the preview and tells the app (AndroidBridge.songStageCrop(path, x, y, size): the
     frame's top-left corner and side as fractions of the picture); the app cuts it from the song's own embedded
     picture when the song is saved and writes it in as the cover. Cancel or Reset keeps the whole thumbnail, the
     way it was before this existed. */


  let cropLayer = null;

  function closeCrop() {
    if (!cropLayer) return false;
    if (cropLayer.parentNode) cropLayer.parentNode.removeChild(cropLayer);
    cropLayer = null;
    return true;
  }

  function openCrop(item) {
    if (!item || !item.fullArt || cropLayer) return;
    const b = bridge();
    const layer = el('div', 'dl-crop');
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'true');
    layer.setAttribute('aria-label', 'Choose the cover');
    const box = el('div', 'dl-crop-box');
    box.appendChild(el('h3', null, 'Choose the cover'));
    box.appendChild(el('p', 'dl-hint', 'Drag the square to pick the part of the picture that becomes the cover.'));
    const stage = el('div', 'dl-crop-stage');
    const img = el('img');
    img.alt = '';
    img.src = item.fullArt;
    const frame = el('div', 'dl-crop-frame');
    stage.appendChild(img);
    stage.appendChild(frame);
    box.appendChild(stage);

    const zoomRow = el('label', 'dl-crop-zoom');
    zoomRow.appendChild(el('span', null, 'Zoom'));
    const zoom = el('input');
    zoom.type = 'range';
    zoom.min = '30';
    zoom.max = '100';
    zoom.value = String(Math.round(((item.crop && item.crop.size) || 1) * 100));
    zoom.setAttribute('aria-label', 'Zoom');
    zoomRow.appendChild(zoom);
    box.appendChild(zoomRow);

    let iw = 0;
    let ih = 0;
    let cx = 0;
    let cy = 0;
    const current = () => cropRect(iw, ih, Number(zoom.value) / 100, cx, cy);
    const draw = () => {
      if (!iw) return;
      const r = current();
      frame.style.left = (r.left / iw * 100) + '%';
      frame.style.top = (r.top / ih * 100) + '%';
      frame.style.width = (r.side / iw * 100) + '%';
      frame.style.height = (r.side / ih * 100) + '%';
    };
    img.addEventListener('load', () => {
      iw = img.naturalWidth || 0;
      ih = img.naturalHeight || 0;
      if (!iw || !ih) return;
      const had = item.crop;
      cx = had ? (had.x * iw + (had.size * Math.min(iw, ih)) / 2) : iw / 2;
      cy = had ? (had.y * ih + (had.size * Math.min(iw, ih)) / 2) : ih / 2;
      draw();
    });

    // Dragging: the frame follows the finger (its centre goes where you touch).
    let dragging = false;
    const move = (e) => {
      if (!iw) return;
      const rect = stage.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      cx = (e.clientX - rect.left) / rect.width * iw;
      cy = (e.clientY - rect.top) / rect.height * ih;
      draw();
    };
    stage.addEventListener('pointerdown', (e) => {
      dragging = true;
      if (stage.setPointerCapture && e.pointerId !== undefined) { try { stage.setPointerCapture(e.pointerId); } catch (err) { /* fine */ } }
      move(e);
    });
    stage.addEventListener('pointermove', (e) => { if (dragging) move(e); });
    ['pointerup', 'pointercancel'].forEach((t) => stage.addEventListener(t, () => { dragging = false; }));
    zoom.addEventListener('input', draw);

    const actions = el('div', 'dl-crop-actions');
    actions.appendChild(button('Cancel', 'dl-secondary', closeCrop));
    actions.appendChild(button('Whole picture', 'dl-secondary', () => {
      // Back to the thumbnail as downloaded (the app forgets any cut-out).
      try { if (b && b.songStageCrop) b.songStageCrop(item.path, 0, 0, -1); } catch (err) { /* nothing to undo */ }
      item.crop = null;
      item.art = item.fullArt;
      closeCrop();
      render();
    }));
    actions.appendChild(button('Done', 'dl-primary', () => {
      if (!iw) { closeCrop(); return; }
      const r = current();
      let ok = false;
      try { ok = !!(b && b.songStageCrop && b.songStageCrop(item.path, r.x, r.y, r.size)); } catch (err) { ok = false; }
      if (ok) {
        // The preview shown in the naming step is the cut-out itself.
        try {
          const canvas = document.createElement('canvas');
          const px = Math.max(1, Math.min(512, Math.round(r.side)));
          canvas.width = px;
          canvas.height = px;
          canvas.getContext('2d').drawImage(img, r.left, r.top, r.side, r.side, 0, 0, px, px);
          item.art = canvas.toDataURL('image/jpeg', 0.9);
        } catch (err) { /* the old preview stays; the cut-out is still applied when the song is saved */ }
        item.crop = { x: r.x, y: r.y, size: r.size };
      }
      closeCrop();
      render();
    }));
    box.appendChild(actions);
    layer.appendChild(box);
    layer.addEventListener('click', (e) => { if (e.target === layer) closeCrop(); });
    cropLayer = layer;
    document.body.appendChild(layer);
  }

  const wizard = createWizard({
    stage(id, url) { return needBridge('stageSong').stageSong(id, url); },
    place(id, path, name, folder) { return needBridge('placeSong').placeSong(id, path, name, folder); },
    cancel() { const b = bridge(); if (b && typeof b.cancelSongDownload === 'function') b.cancelSongDownload(); },
    discard() { const b = bridge(); if (b && typeof b.discardStagedSongs === 'function') b.discardStagedSongs(); },
    discardOne(path) { const b = bridge(); if (b && typeof b.discardStagedSong === 'function') b.discardStagedSong(path); },
    onPlaced(item, finalPath, folder) {
      if (root.SongMemory) root.SongMemory.recordDownload({ url: item.url, name: item.name, playlist: folder, path: finalPath });
    },
    play(path, folder) {
      const audio = root.NovelAudio;
      if (audio && typeof audio.playAfterRescan === 'function') {
        const done = audio.playAfterRescan(path, folder);
        if (done && typeof done.catch === 'function') done.catch(() => {});
      }
    },
    onChange() { render(); },
  });

  // The native side calls this.
  root.onSongDownloadStatus = function (jobId, status, message) { wizard.report(jobId, status, message); };

  /* ---- step 1 ---------------------------------------------------------- */

  /* Links already downloaded before (downloads.txt, any form of the same link) are not downloaded again
     unless asked: the user sees which ones they are and what they were saved as. dupes = { fresh: [url],
     known: [{ url, entry, present, again }] } while that choice is on screen. */
  let dupes = null;

  function reviewLinks(links) {
    const memory = root.SongMemory;
    if (!memory) { wizard.start(links); return; }
    const seen = new Set();
    const fresh = [];
    const known = [];
    links.forEach((url) => {
      const key = memory.normalizeUrl(url);
      if (seen.has(key)) return;               // the same song twice in one paste
      seen.add(key);
      const entry = memory.findDownloaded(url);
      if (!entry) { fresh.push(url); return; }
      const present = memory.isPresent(entry);
      // The file is gone (deleted since): downloading it again is probably what is wanted.
      known.push({ url, entry, present, again: !present });
    });
    if (!known.length) { wizard.start(fresh); return; }
    dupes = { fresh, known };
    render();
  }

  function isPlaylistUrl(url) {
    return /youtube\.com\/(playlist|watch)\?[^#]*list=/.test(url) ||
           /youtu\.be\/[^?]+\?[^#]*list=/.test(url) ||
           /open\.spotify\.com\/(playlist|album|user\/[^/]+\/playlist)\//.test(url);
  }

  function takeClipboardText(text) {
    const parsed = parseLinks(text);
    if (!parsed.links.length) {
      wizard.setMessage('No song link on the clipboard. Copy a link, then tap again.');
      return;
    }
    if (parsed.links.length === 1 && isPlaylistUrl(parsed.links[0])) {
      startPlaylistFlow(parsed.links[0]);
      return;
    }
    reviewLinks(parsed.links);
  }

  function pasteFromClipboard() {
    const b = bridge();
    if (b && typeof b.readClipboard === 'function') {
      let text = '';
      try { text = b.readClipboard() || ''; } catch (e) { text = ''; }
      return takeClipboardText(text);
    }
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        return navigator.clipboard.readText().then(takeClipboardText, () => wizard.setMessage('Could not read the clipboard.'));
      }
    } catch (e) { /* fall through */ }
    wizard.setMessage('This device does not let the app read the clipboard.');
  }

  /* ---- the steps ------------------------------------------------------- */

  function dupeCount(d) { return d.fresh.length + d.known.filter((k) => k.again).length; }

  function buildDupes() {
    const d = dupes;
    const box = el('div', 'dl-step dl-dupes');
    const mark = el('span', 'dl-mark dl-mark-warn');
    mark.appendChild(icon('i-info'));
    box.appendChild(mark);
    box.appendChild(el('h2', 'dl-title', d.known.length === 1 ? 'Already downloaded' : d.known.length + ' links already downloaded'));
    box.appendChild(el('p', 'dl-hint', d.fresh.length
      ? 'These were downloaded before. The ' + d.fresh.length + ' new link' + (d.fresh.length === 1 ? '' : 's') + ' will download as usual.'
      : 'These were downloaded before. Switch on any you want again.'));

    const list = el('div', 'dl-dupe-list');
    d.known.forEach((k) => {
      const item = el('div', 'dl-dupe');
      const text = el('span', 'dl-dupe-text');
      text.appendChild(el('span', 'dl-dupe-name', k.entry.name || shortLink(k.url)));
      const bits = [];
      if (k.entry.playlist) bits.push(k.entry.playlist);
      if (k.entry.t && root.SongMemoryPure) bits.push(root.SongMemoryPure.formatDate(k.entry.t).slice(0, 10));
      text.appendChild(el('span', 'dl-dupe-sub', bits.join(' • ')));
      text.appendChild(el('span', 'dl-dupe-state' + (k.present ? '' : ' gone'), k.present ? 'Still on your phone' : 'No longer on your phone'));
      item.appendChild(text);
      const label = el('label', 'dl-again');
      const box2 = el('input');
      box2.type = 'checkbox';
      box2.checked = k.again;
      box2.setAttribute('aria-label', 'Download “' + (k.entry.name || shortLink(k.url)) + '” again');
      box2.addEventListener('change', () => { k.again = box2.checked; go.textContent = goLabel(); });
      label.appendChild(box2);
      label.appendChild(el('span', null, 'Again'));
      item.appendChild(label);
      list.appendChild(item);
    });
    box.appendChild(list);

    const goLabel = () => {
      const n = dupeCount(d);
      return n ? 'Download ' + n + (n === 1 ? ' song' : ' songs') : 'Skip them all';
    };
    const row = el('div', 'dl-row dl-row-end');
    row.appendChild(button('Cancel', 'dl-secondary', () => { dupes = null; render(); }));
    const go = button(goLabel(), 'dl-primary', () => {
      const urls = d.fresh.concat(d.known.filter((k) => k.again).map((k) => k.url));
      dupes = null;
      if (urls.length) wizard.start(urls);
      else { wizard.setMessage('Nothing new to download: those songs are already there.'); render(); }
    });
    row.appendChild(go);
    box.appendChild(row);
    return box;
  }

  function buildPaste(s) {
    if (dupes) return buildDupes();
    const box = el('div', 'dl-step');
    box.appendChild(button('Click to paste', 'dl-primary dl-big', pasteFromClipboard));
    if (s.message) box.appendChild(el('p', 'dl-msg', s.message));
    return box;
  }

  function buildDownload(s) {
    const item = wizard.current();
    const box = el('div', 'dl-step');
    if (item && item.state === 'failed') {
      const mark = el('span', 'dl-mark dl-mark-bad');
      mark.appendChild(icon('i-close'));
      box.appendChild(mark);
      box.appendChild(el('h2', 'dl-title', 'Download failed'));
      box.appendChild(el('p', 'dl-msg dl-err', item.error));
      // YouTube's bot check: the way out is in Settings (YouTube sign-in), then Retry.
      if (/not a bot|sign in to confirm/i.test(String(item.error || ''))) {
        box.appendChild(button('Open Settings', 'dl-secondary', () => { if (root.SettingsMenu && root.SettingsMenu.open) root.SettingsMenu.open(); }));
      }
      const row = el('div', 'dl-row');
      row.appendChild(button('Retry', 'dl-primary', () => wizard.retryDownload()));
      row.appendChild(button('Skip', 'dl-secondary', () => wizard.skip()));
      box.appendChild(row);
      return box;
    }
    box.appendChild(el('span', 'dl-spinner'));
    box.appendChild(el('h2', 'dl-title', 'Downloading…'));
    const bar = el('span', 'dl-bar');
    bar.appendChild(el('i'));
    box.appendChild(bar);
    if (item) box.appendChild(el('p', 'dl-sub', shortLink(item.url)));
    return box;
  }

  function nameHint(text) {
    const cleaned = cleanSongName(text);
    if (!cleaned) return 'Empty: the song keeps its own name.';
    if (cleaned !== String(text).trim()) return 'Will be saved as “' + cleaned + '”.';
    return '';
  }

  function buildName(s) {
    const item = wizard.current();
    const box = el('div', 'dl-step');
    if (item.art === undefined) {
      let art = '';
      try { art = (bridge() && bridge().getArtwork && bridge().getArtwork(item.path)) || ''; } catch (e) { art = ''; }
      item.art = art;
      item.fullArt = art;                      // the whole thumbnail as downloaded, kept for choosing a cover from it
    }
    const thumb = coverNode(item.art, 0, 'i-moon-music', 'dl-thumb');
    const b0 = bridge();
    const croppable = !!(item.fullArt && b0 && typeof b0.songStageCrop === 'function');
    if (croppable) {
      thumb.setAttribute('role', 'button');
      thumb.tabIndex = 0;
      thumb.setAttribute('aria-label', 'Choose which part of the picture is the cover');
      thumb.setAttribute('data-dl-crop', '1');
      thumb.addEventListener('click', () => openCrop(item));
      thumb.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCrop(item); } });
    }
    box.appendChild(thumb);
    if (croppable) box.appendChild(el('p', 'dl-hint', 'Tap the picture to choose which part becomes the cover.'));

    const input = el('input', 'dl-input');
    input.type = 'text';
    input.value = item.name;
    input.maxLength = 120;
    input.placeholder = 'Song name';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Song name');
    input.setAttribute('enterkeyhint', 'done');
    input.setAttribute('data-keep', 'name');
    const hint = el('p', 'dl-hint', nameHint(item.name));
    input.addEventListener('input', () => { wizard.rename(input.value); hint.textContent = nameHint(input.value); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { input.blur(); wizard.save(); } });
    box.appendChild(input);
    box.appendChild(hint);

    // Songs already on the phone (or downloaded before) with a similar name, updated as the name is typed.
    const similar = el('div', 'dl-similar');
    similar.setAttribute('aria-live', 'polite');
    box.appendChild(similar);
    let similarTimer = 0;
    const refreshSimilar = () => showSimilar(similar, input.value);
    input.addEventListener('input', () => { clearTimeout(similarTimer); similarTimer = setTimeout(refreshSimilar, 120); });
    refreshSimilar();

    const row = el('div', 'dl-row dl-row-end');
    row.appendChild(button('Save', 'dl-primary', () => wizard.save()));
    box.appendChild(row);
    return box;
  }

  function showSimilar(host, name) {
    host.textContent = '';
    const memory = root.SongMemory;
    if (!memory) return;
    const found = memory.similarTo(name, { limit: 4 });
    if (!found.length) return;
    const exact = found.find((f) => f.exact);
    if (exact) {
      const where = exact.source === 'log'
        ? 'was downloaded before' + (exact.playlist ? ' into ' + exact.playlist : '') + ' (the file is gone)'
        : exact.playlist ? 'is already in ' + exact.playlist : 'is already on your phone';
      host.appendChild(el('p', 'dl-warn', '“' + (exact.title || name) + '” ' + where + '. Saving adds another copy.'));
    } else {
      host.appendChild(el('p', 'dl-similar-title', 'Similar songs already here'));
    }
    const list = el('div', 'dl-similar-list');
    found.forEach((f) => {
      const r = el('div', 'dl-similar-row');
      const text = el('span', 'dl-similar-text');
      text.appendChild(el('span', 'dl-similar-name', f.title));
      const sub = [f.artist, f.playlist, f.source === 'log' ? 'file gone' : ''].filter(Boolean).join(' • ');
      if (sub) text.appendChild(el('span', 'dl-similar-sub', sub));
      r.appendChild(text);
      r.appendChild(el('span', 'dl-badge' + (f.exact ? ' same' : ''), f.exact ? 'Same song' : 'Similar'));
      list.appendChild(r);
    });
    host.appendChild(list);
    host.appendChild(button('Don’t keep this song', 'dl-secondary dl-drop', () => wizard.dropCurrent()));
  }

  function tile(title, sub, cover, onClick, extraClass) {
    const t = el('button', 'dl-tile' + (extraClass ? ' ' + extraClass : ''));
    t.type = 'button';
    t.appendChild(cover);
    t.appendChild(el('span', 'dl-tile-name', title));
    if (sub) t.appendChild(el('span', 'dl-tile-sub', sub));
    t.addEventListener('click', onClick);
    return t;
  }

  function buildPlaylist(s) {
    const box = el('div', 'dl-step dl-wide');
    box.appendChild(el('h2', 'dl-title dl-left', 'Choose playlist'));
    const grid = el('div', 'dl-grid');
    grid.appendChild(tile('New playlist', '', coverNode('', 0, 'i-plus', 'dl-new'), () => wizard.chooseNew(), 'dl-tile-new'));
    playlists().forEach((name, i) => {
      grid.appendChild(tile(name, '', coverNode(playlistCover(name), i, 'i-moon-music'), () => wizard.choose(name)));
    });
    grid.appendChild(tile('No playlist', 'All songs', coverNode('', playlists().length, 'i-moon-music'), () => wizard.choose('')));
    box.appendChild(grid);
    return box;
  }

  function buildNewPlaylist(s) {
    const box = el('div', 'dl-step dl-wide');
    box.appendChild(el('h2', 'dl-title dl-left', 'New playlist'));
    const input = el('input', 'dl-input');
    input.type = 'text';
    input.maxLength = 60;
    input.placeholder = 'Playlist name';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Playlist name');
    input.setAttribute('enterkeyhint', 'done');
    input.setAttribute('data-keep', 'newname');
    const hint = el('p', 'dl-hint', '');
    const create = button('Create', 'dl-primary', () => wizard.choose(input.value));
    create.disabled = true;
    const update = () => {
      const typed = input.value.trim();
      const cleaned = cleanFolderName(typed);
      create.disabled = !cleaned;
      if (!typed) hint.textContent = 'Letters, numbers and spaces.';
      else if (!cleaned) hint.textContent = 'Use letters, numbers and spaces.';
      else if (playlists().some((n) => n.toLowerCase() === cleaned.toLowerCase())) hint.textContent = 'That playlist already exists: the song will go in it.';
      else if (cleaned !== typed) hint.textContent = 'Will be saved as “' + cleaned + '”.';
      else hint.textContent = '';
    };
    update();
    input.addEventListener('input', update);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !create.disabled) { input.blur(); wizard.choose(input.value); } });
    box.appendChild(input);
    box.appendChild(hint);
    const row = el('div', 'dl-row dl-row-end');
    row.appendChild(button('Back', 'dl-secondary', () => wizard.backToPlaylists()));
    row.appendChild(create);
    box.appendChild(row);
    return box;
  }

  function buildPlacing(s) {
    const box = el('div', 'dl-step');
    box.appendChild(el('span', 'dl-spinner'));
    box.appendChild(el('h2', 'dl-title', 'Adding song…'));
    box.appendChild(el('p', 'dl-sub', s.folder ? 'To ' + s.folder : 'To All songs'));
    return box;
  }

  function buildPlaceFail(s) {
    const box = el('div', 'dl-step');
    const mark = el('span', 'dl-mark dl-mark-bad');
    mark.appendChild(icon('i-close'));
    box.appendChild(mark);
    box.appendChild(el('h2', 'dl-title', 'Couldn’t add the song'));
    box.appendChild(el('p', 'dl-msg dl-err', s.error));
    const row = el('div', 'dl-row');
    row.appendChild(button('Try again', 'dl-primary', () => wizard.retryPlace()));
    row.appendChild(button('Change name', 'dl-secondary', () => wizard.backToName()));
    box.appendChild(row);
    return box;
  }

  function buildDone(s) {
    const placed = s.items.filter((i) => i.state === 'placed').length;
    const box = el('div', 'dl-step');
    const mark = el('span', 'dl-mark');
    mark.appendChild(icon('i-check'));
    box.appendChild(mark);
    box.appendChild(el('h2', 'dl-title', placed ? 'All done' : 'No songs were added'));
    box.appendChild(button('Paste more', 'dl-primary', () => wizard.again()));
    return box;
  }

  /* =========================================================================
     Playlist download flow  (separate from the per-song wizard)
     =========================================================================
     Steps:
       pl-resolving   spinner while yt-dlp fetches the track list
       pl-confirm     show track count + title; user confirms or cancels
       pl-downloading progress bar + per-song status list; notification running
       pl-edit        all done; per-song name field + tappable cover crop
       pl-saving      placing songs one by one into the library
  ========================================================================= */

  let pl = null;   // null when no playlist flow is active

  function startPlaylistFlow(url) {
    pl = { url, step: 'pl-resolving', title: '', tracks: [], items: [], done: 0, failed: 0 };
    render();
    const jobId = 'pl-resolve-' + Date.now().toString(36);
    const b = bridge();
    if (!b || typeof b.fetchPlaylistInfo !== 'function') {
      pl = { url, step: 'pl-error', error: 'Not connected to the app yet.' };
      render(); return;
    }
    root.onPlaylistInfo = function (id, json) {
      if (id !== jobId) return;
      let data;
      try { data = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { data = { error: 'Bad response.' }; }
      if (data.error) { pl.step = 'pl-error'; pl.error = data.error; render(); return; }
      pl.title  = data.title  || 'Playlist';
      pl.tracks = Array.isArray(data.tracks) ? data.tracks : [];
      pl.step   = 'pl-confirm';
      render();
    };
    b.fetchPlaylistInfo(jobId, url);
  }

  // Max parallel yt-dlp processes for a playlist batch. More than 3 gives no speed benefit
  // (yt-dlp is CPU + network bound) and causes the library to re-init Python per extra fork.
  const PL_CONCURRENCY = 3;

  function startPlaylistDownloads() {
    pl.step       = 'pl-downloading';
    pl.queueIndex = 0;      // next item in pl.items to kick off
    pl.items = pl.tracks.map((url) => ({
      url, jobId: '', name: '', path: '', fullArt: '', art: '', crop: null,
      status: 'queued', error: '',
    }));
    render();
    // Start up to PL_CONCURRENCY jobs immediately; onPlSongStatus drains the queue.
    const slots = Math.min(PL_CONCURRENCY, pl.items.length);
    for (let s = 0; s < slots; s++) plStartNext();
    plNotify();
  }

  /** Kick off the next queued item (if any). */
  function plStartNext() {
    if (!pl || pl.step !== 'pl-downloading') return;
    const idx = pl.queueIndex;
    if (idx >= pl.items.length) return;
    pl.queueIndex++;
    const item = pl.items[idx];
    const jobId = 'pl-dl-' + idx + '-' + Date.now().toString(36);
    item.jobId = jobId;
    const b = bridge();
    if (!b || typeof b.stageSong !== 'function') {
      item.status = 'failed'; item.error = 'Not connected.'; pl.failed++;
      plCheckDone(); return;
    }
    item.status = 'dl';
    b.stageSong(jobId, item.url);
  }

  function plCheckDone() {
    if (!pl || pl.step !== 'pl-downloading') return;
    plNotify(); render();
    if (pl.done + pl.failed >= pl.items.length) { pl.step = 'pl-edit'; plNotify(); render(); }
  }

  function onPlSongStatus(jobId, status, message) {
    if (!pl || pl.step !== 'pl-downloading') return false;
    const item = pl.items.find((it) => it.jobId === jobId);
    if (!item) return false;
    if (status === 'running') return true;   // suppress from the wizard
    if (status === 'done') {
      item.path = message;
      item.status = 'done';
      pl.done++;
      const b = bridge();
      if (b && typeof b.getArtwork === 'function') {
        try { const a = b.getArtwork(item.path); item.fullArt = a || ''; item.art = item.fullArt; } catch (e) {}
      }
      item.name = stemOf(item.path);
    } else if (status === 'failed') {
      item.status = 'failed'; item.error = message; pl.failed++;
    }
    // A slot freed — start the next queued item (concurrency pump).
    plStartNext();
    plCheckDone();
    return true;
  }

  function onPlPlaceDone(jobId, ok) {
    if (!pl || pl.step !== 'pl-saving') return false;
    const item = (pl.saving || [])[pl.saveIndex];
    if (!item || item.placeJobId !== jobId) return false;
    pl.saveIndex++;
    placeSaved();
    return true;
  }

  function plNotify() {
    const b = bridge();
    if (!b || typeof b.notifyPlaylistProgress !== 'function') return;
    const total = pl.items.length;
    const done  = pl.done + pl.failed;
    try { b.notifyPlaylistProgress(pl.title, done, total); } catch (e) {}
  }

  function savePlSongs() {
    // Items the user deselected (keep=false): discard their staged files via placeSong with empty
    // folder AND empty name, which the bridge treats as "just delete the staged file".
    // For simplicity we cancel them on the JS side — the staged files stay in .staging (they will
    // be cleaned up on the next app start, same as an interrupted single-song download).
    const toPlace = pl.items.filter((it) => it.status === 'done' && it.keep !== false);
    if (!toPlace.length) { pl = null; render(); return; }
    pl.saving    = toPlace;
    pl.saveIndex = 0;
    pl.step      = 'pl-saving';
    render();
    placeSaved();
  }

  function placeSaved() {
    if (!pl || pl.step !== 'pl-saving') return;
    const item = (pl.saving || [])[pl.saveIndex];
    if (!item) { pl = null; render(); return; }
    const b = bridge();
    if (!b || typeof b.placeSong !== 'function') { pl = null; render(); return; }
    const jobId = 'pl-place-' + pl.saveIndex + '-' + Date.now().toString(36);
    item.placeJobId = jobId;
    b.placeSong(jobId, item.path, cleanSongName(item.name), cleanFolderName(pl.title));
  }

  // ---- BUILDERS for playlist steps ----------------------------------------

  function buildPlResolving() {
    const box = el('div', 'dl-step dl-pl-step');
    const mark = el('span', 'dl-mark'); mark.appendChild(icon('i-moon')); box.appendChild(mark);
    box.appendChild(el('h2', 'dl-title', 'Reading playlist\u2026'));
    box.appendChild(el('p', 'dl-hint', 'Fetching the track list. This takes a moment.'));
    return box;
  }

  function buildPlError() {
    const box = el('div', 'dl-step dl-pl-step');
    const mark = el('span', 'dl-mark dl-mark-warn'); mark.appendChild(icon('i-info')); box.appendChild(mark);
    box.appendChild(el('h2', 'dl-title', 'Could not read playlist'));
    box.appendChild(el('p', 'dl-hint', pl.error || 'Unknown error.'));
    box.appendChild(button('Back', 'dl-primary', () => { pl = null; render(); }));
    return box;
  }

  function buildPlConfirm() {
    const box = el('div', 'dl-step dl-pl-step');
    const mark = el('span', 'dl-mark'); mark.appendChild(icon('i-moon-music')); box.appendChild(mark);
    box.appendChild(el('h2', 'dl-title', pl.title));
    const n = pl.tracks.length;
    box.appendChild(el('p', 'dl-hint', n + ' song' + (n === 1 ? '' : 's') +
      ' will download in the background. Rename songs and re-crop covers once they\u2019re done.'));
    const row = el('div', 'dl-actions');
    row.appendChild(button('Download all', 'dl-primary', startPlaylistDownloads));
    row.appendChild(button('Cancel', 'dl-secondary', () => { pl = null; render(); }));
    box.appendChild(row);
    return box;
  }

  function buildPlDownloading() {
    const done  = pl.done + pl.failed;
    const total = pl.items.length;
    const pct   = total ? Math.round(done / total * 100) : 0;

    const box = el('div', 'dl-step dl-pl-step');

    // Header
    const hdr = el('div', 'dl-pl-hdr');
    const titleEl = el('h2', 'dl-title', '\u201c' + pl.title + '\u201d');
    const prog = el('span', 'dl-pl-prog', done + ' / ' + total);
    hdr.appendChild(titleEl); hdr.appendChild(prog);
    box.appendChild(hdr);

    // Progress bar
    const barWrap = el('div', 'dl-pl-bar-wrap');
    const barFill = el('div', 'dl-pl-bar-fill');
    barFill.style.width = pct + '%';
    barWrap.appendChild(barFill);
    box.appendChild(barWrap);

    // Song list — Spotify-style rows
    const list = el('div', 'dl-pl-sp-list');
    pl.items.forEach((item, i) => {
      const row = el('div', 'dl-pl-sp-row dl-pl-sp-' + item.status);

      // Cover thumbnail (shown when done; skeleton otherwise)
      const cover = el('div', 'dl-pl-sp-cover sp-cover');
      if (item.art) {
        cover.style.setProperty('--sp-cover', 'url("' + item.art + '")');
        cover.setAttribute('data-sp-cover', '1');
      } else {
        cover.appendChild(icon('i-moon-music'));
      }
      row.appendChild(cover);

      // Text block
      const text = el('div', 'dl-pl-sp-text');
      const nameEl = el('div', 'dl-pl-sp-name');
      if (item.name) {
        nameEl.textContent = item.name;
      } else if (item.status === 'dl') {
        // Animated skeleton bar while actively downloading
        nameEl.appendChild(el('span', 'dl-pl-sp-skel', ''));
      } else {
        // Queued — show track number
        nameEl.textContent = 'Track ' + (i + 1);
      }
      text.appendChild(nameEl);
      row.appendChild(text);

      // Status pill
      const pill = el('span', 'dl-pl-sp-pill');
      if (item.status === 'done') {
        pill.textContent = '\u2713';
        pill.classList.add('dl-pl-sp-pill-done');
      } else if (item.status === 'failed') {
        pill.textContent = '\u2717';
        pill.classList.add('dl-pl-sp-pill-fail');
        // Show truncated error on second line
        if (item.error) {
          const errEl = el('div', 'dl-pl-sp-err', item.error.split('\n')[0].slice(0, 60));
          text.appendChild(errEl);
        }
      } else if (item.status === 'dl') {
        pill.textContent = '\u2026';
        pill.classList.add('dl-pl-sp-pill-dl');
      }
      // queued: no pill
      row.appendChild(pill);

      list.appendChild(row);
    });
    box.appendChild(list);
    return box;
  }

  function buildPlEdit() {
    const successItems = pl.items.filter((it) => it.status === 'done');
    // Initialise the keep flag once (default: all selected).
    successItems.forEach((item) => { if (item.keep === undefined) item.keep = true; });

    const box = el('div', 'dl-step dl-pl-step');
    box.appendChild(el('h2', 'dl-title', '\u201c' + pl.title + '\u201d \u2014 ' + pl.done + ' song' + (pl.done === 1 ? '' : 's')));
    if (pl.failed) box.appendChild(el('p', 'dl-hint dl-pl-warn', pl.failed + ' failed to download.'));
    box.appendChild(el('p', 'dl-hint', 'Uncheck songs you don\u2019t want. Tap a cover to re-crop. Edit names, then save.'));

    // Select-all / deselect-all row
    const selRow = el('div', 'dl-pl-sel-row');
    const allChecked = () => successItems.every((it) => it.keep);
    const selBtn = el('button', 'dl-secondary dl-pl-sel-btn');
    selBtn.type = 'button';
    const updateSelBtn = () => { selBtn.textContent = allChecked() ? 'Deselect all' : 'Select all'; };
    updateSelBtn();
    selBtn.addEventListener('click', () => {
      const next = !allChecked();
      successItems.forEach((it) => { it.keep = next; });
      render();
    });
    selRow.appendChild(selBtn);
    const countSpan = el('span', 'dl-pl-sel-count',
      successItems.filter((it) => it.keep).length + ' of ' + successItems.length + ' selected');
    selRow.appendChild(countSpan);
    box.appendChild(selRow);

    const list = el('div', 'dl-pl-edit-list');
    pl.items.forEach((item, i) => {
      if (item.status !== 'done') return;

      const card = el('div', 'dl-pl-edit-card' + (item.keep ? '' : ' dl-pl-card-skip'));

      // Checkbox
      const chkWrap = el('label', 'dl-pl-chk-wrap');
      chkWrap.setAttribute('aria-label', item.keep ? 'Keep this song' : 'Skip this song');
      const chk = el('input');
      chk.type = 'checkbox';
      chk.className = 'dl-pl-chk';
      chk.checked = !!item.keep;
      chk.addEventListener('change', () => {
        item.keep = chk.checked;
        card.classList.toggle('dl-pl-card-skip', !item.keep);
        updateSelBtn();
        countSpan.textContent = successItems.filter((it) => it.keep).length + ' of ' + successItems.length + ' selected';
      });
      chkWrap.appendChild(chk);
      card.appendChild(chkWrap);

      // Cover — tappable, re-uses the existing openCrop(item)
      const coverBtn = el('button', 'dl-pl-edit-cover sp-cover');
      coverBtn.type = 'button';
      coverBtn.setAttribute('aria-label', 'Re-crop cover');
      if (item.art) coverBtn.style.setProperty('--sp-cover', 'url("' + item.art + '")');
      coverBtn.appendChild(icon('i-moon-music'));
      coverBtn.addEventListener('click', () => openCrop(item));
      card.appendChild(coverBtn);

      // Name field
      const nameInput = el('input');
      nameInput.type  = 'text';
      nameInput.className = 'dl-name-input';
      nameInput.value = item.name;
      nameInput.setAttribute('aria-label', 'Song name');
      nameInput.setAttribute('data-keep', 'pl-name-' + i);
      nameInput.addEventListener('input', () => { item.name = cleanSongName(nameInput.value); });
      card.appendChild(nameInput);

      list.appendChild(card);
    });
    box.appendChild(list);

    const keptCount = successItems.filter((it) => it.keep).length;
    const saveBtn = button(
      'Save ' + keptCount + ' song' + (keptCount === 1 ? '' : 's') + ' to \u201c' + pl.title + '\u201d',
      'dl-primary', savePlSongs
    );
    box.appendChild(saveBtn);
    return box;
  }

  function buildPlSaving() {
    const done  = pl.saveIndex || 0;
    const total = (pl.saving || []).length;
    const box = el('div', 'dl-step dl-pl-step');
    const mark = el('span', 'dl-mark'); mark.appendChild(icon('i-moon-music')); box.appendChild(mark);
    box.appendChild(el('h2', 'dl-title', 'Saving to \u201c' + pl.title + '\u201d\u2026'));
    box.appendChild(el('p', 'dl-hint', done + ' of ' + total + ' saved'));
    const barWrap = el('div', 'dl-pl-bar-wrap');
    const barFill = el('div', 'dl-pl-bar-fill');
    barFill.style.width = (total ? Math.round(done / total * 100) : 0) + '%';
    barWrap.appendChild(barFill); box.appendChild(barWrap);
    return box;
  }

  // Hook onSongDownloadStatus to intercept pl- jobs before the wizard sees them.
  const _prevStatus = root.onSongDownloadStatus;
  root.onSongDownloadStatus = function (jobId, status, message) {
    if (typeof jobId === 'string') {
      if (jobId.startsWith('pl-dl-')    && onPlSongStatus(jobId, status, message)) return;
      if (jobId.startsWith('pl-place-') && onPlPlaceDone(jobId, status === 'done')) return;
    }
    if (typeof _prevStatus === 'function') _prevStatus(jobId, status, message);
  };

  const BUILDERS = {
    paste: buildPaste, download: buildDownload, name: buildName, playlist: buildPlaylist,
    newplaylist: buildNewPlaylist, placing: buildPlacing, placefail: buildPlaceFail, done: buildDone,
    'pl-resolving': buildPlResolving, 'pl-error': buildPlError, 'pl-confirm': buildPlConfirm,
    'pl-downloading': buildPlDownloading, 'pl-edit': buildPlEdit, 'pl-saving': buildPlSaving,
  };

  function render() {
    const s = wizard.state;
    // A step that is redrawn because something happened in the background (the next song finished
    // downloading) must not take the keyboard away from a field being typed in.
    const active = document.activeElement;
    const keep = active && active.getAttribute ? active.getAttribute('data-keep') : null;
    const selStart = keep ? active.selectionStart : 0;
    const selEnd = keep ? active.selectionEnd : 0;

    stageEl.textContent = '';
    const step = pl ? pl.step : s.step;
    stageEl.setAttribute('data-step', step);
    stageEl.appendChild((BUILDERS[step] || BUILDERS['paste'])(s));

    if (keep) {
      const again = stageEl.querySelector('[data-keep="' + keep + '"]');
      if (again) {
        again.focus();
        try { again.setSelectionRange(selStart, selEnd); } catch (e) { /* not essential */ }
      }
    }
  }

  const isShown = () => !!panel && panel.getAttribute('data-view') === 'download' && !panel.classList.contains('hidden');
  const openTab = () => {
    if (root.SpotifyUI && root.SpotifyUI.setView) root.SpotifyUI.setView('download');
    else render();
  };
  const closeTab = () => {
    if (isShown() && root.SpotifyUI && root.SpotifyUI.setView) root.SpotifyUI.setView('library');
  };

  // Leaving the tab (another tab, the ✕, the panel closing) ends a run that is not finished.
  // The playlists and covers are re-read each time the tab comes into view.
  let wasShown = isShown();
  if (panel && typeof MutationObserver === 'function') {
    new MutationObserver(() => {
      const shown = isShown();
      if (shown && !wasShown) render();
      if (!shown && wasShown) { dupes = null; wizard.leave(); }
      wasShown = shown;
    }).observe(panel, { attributes: true, attributeFilter: ['data-view', 'class'] });
  }
  render();

  root.SongDownload = Object.assign({}, api, {
    open: openTab,
    close: closeTab,
    isOpen: isShown,
    wizard,
    closeCrop,
  });
})(typeof window !== 'undefined' ? window : this);
