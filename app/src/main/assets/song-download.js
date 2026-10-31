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

  /* ---- YouTube sign-in -------------------------------------------------------------------------
     YouTube sometimes refuses downloads with "Sign in to confirm you're not a bot". Signing in once inside the
     app (native side: YouTubeSignIn.kt) saves the login cookies in the app's private storage, and every
     download then uses them. The login page is Google's own: the app never sees the password.
       native -> window.onYouTubeSignIn(status, message)   status "signed-in" | "signed-out"
     Outside the Android app (or in an older build) there is no bridge and no line is shown. */
  let ytNote = '';
  root.onYouTubeSignIn = function (status, message) { ytNote = message || ''; render(); };

  function ytStatus() {
    const b = bridge();
    try { return b && typeof b.youtubeSignInStatus === 'function' ? String(b.youtubeSignInStatus()) : ''; } catch (e) { return ''; }
  }

  // "YouTube: signed in [Sign out]" / "YouTube: not signed in [Sign in]"; `prominent` makes Sign in the main button.
  function buildYouTubeLine(prominent) {
    const status = ytStatus();
    if (!status) return null;
    const signedIn = status === 'signed-in';
    const wrap = el('div', 'dl-yt-wrap');
    const row = el('div', 'dl-yt');
    row.appendChild(el('span', 'dl-yt-text', signedIn ? 'YouTube: signed in' : 'YouTube: not signed in'));
    row.appendChild(button(signedIn ? 'Sign out' : 'Sign in', (prominent && !signedIn ? 'dl-primary' : 'dl-secondary') + ' dl-yt-btn', () => {
      const b = bridge();
      try { if (signedIn) b.youtubeSignOut(); else b.youtubeSignIn(); } catch (e) { /* no bridge: nothing to do */ }
      if (signedIn) render();      // signing in reports back through onYouTubeSignIn
    }));
    wrap.appendChild(row);
    if (ytNote) { wrap.appendChild(el('p', 'dl-hint', ytNote)); ytNote = ''; }
    return wrap;
  }

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

  function takeClipboardText(text) {
    const parsed = parseLinks(text);
    if (!parsed.links.length) wizard.setMessage('No song link on the clipboard. Copy a link, then tap again.');
    else reviewLinks(parsed.links);
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
    const yt = buildYouTubeLine(false);
    if (yt) box.appendChild(yt);
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
      // YouTube's bot check: the way out is right here, then Retry.
      const yt = /not a bot|sign in to confirm/i.test(String(item.error || '')) ? buildYouTubeLine(true) : null;
      if (yt) box.appendChild(yt);
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
    }
    box.appendChild(coverNode(item.art, 0, 'i-moon-music', 'dl-thumb'));

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

  const BUILDERS = {
    paste: buildPaste, download: buildDownload, name: buildName, playlist: buildPlaylist,
    newplaylist: buildNewPlaylist, placing: buildPlacing, placefail: buildPlaceFail, done: buildDone,
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
    stageEl.setAttribute('data-step', s.step);
    stageEl.appendChild(BUILDERS[s.step](s));

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
  });
})(typeof window !== 'undefined' ? window : this);
