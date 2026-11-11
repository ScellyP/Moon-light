/* ============================================================================
   Easter egg: the Rickroll
   ============================================================================
   A song title (or link) pasted into the Download tab that is about Rick Astley / rickrolling is NOT downloaded.
   The phone opens RICKROLL_LINK instead; when the user is back in the app a dialog says so once and the hidden
   copy of the song starts playing.

     * Detection:  Rickroll.looksLikeRickroll(text), Rickroll.check(text) (true = it was one, and it is handled).
       Called by song-download.js for the pasted text and for the name typed before Save.
     * Opening:    AndroidBridge.openExternalLink(url) (window.open as a fallback outside the app).
     * Returning:  the app tells the page when it is left and entered again (window.onAppPause / onAppResume from
                   MainActivity), the browser's visibilitychange / focus are used too, and the pending attempt is
                   kept in localStorage, so a phone that killed the app while the user was away still shows the
                   dialog on the next start. The dialog shows once per attempt.
     * The song:    downloaded ONCE with the app's own downloader (stageSong -> placeSong) into the Songs folder
                   under the fixed name SONG_NAME; NovelAudio hides that name from the plain All songs views
                   (MediaLibrary.isHidden). Later attempts reuse the file. Each attempt then puts the song into up to
                   two of the user's playlists at random places (NovelAudio.injectIntoPlaylists), never twice into
                   the same playlist; an injection still owed when the app is closed is paid on the next start.
   Nothing here is shown in the UI except the dialog.
   ========================================================================= */
(function (root) {
  'use strict';

  const RICKROLL_LINK = 'https://youtu.be/gDjMZvYWUdo';
  const SONG_LINK = RICKROLL_LINK;                       // where the hidden copy is downloaded from
  const SONG_NAME = 'Never Gonna Give You Up';           // file name in Songs/ (audio-player.js hides exactly this name)
  const DIALOG_TITLE = 'Nice try';
  const DIALOG_TEXT = 'Nice try, buddy.';
  const KEY_ATTEMPT = 'moonlight_rr_attempt';            // an attempt whose dialog has not been shown yet
  const KEY_OWED = 'moonlight_rr_owed';                  // attempts whose playlist appearances are still to be made
  const NEVER_LEFT_MS = 15000;                           // the link did not open: show the dialog anyway
  const JOB_TIMEOUT_MS = 10 * 60 * 1000;

  /* ---- detection (pure) ---- */
  // Letters and digits only, "ck" -> "k", doubled letters once: "Rick  Roll", "rickrolled", "Rik-Rol" all share "rikrol".
  function squash(text) {
    return String(text == null ? '' : text).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '').replace(/ck/g, 'k').replace(/(.)\1+/g, '$1');
  }

  const NEEDLES = [
    'rikrol',                                                            // rickroll, rick roll, rickrolled, rick-rolling
    'rikastle', 'rikasle', 'rikastly', 'rikasly', 'rikestle', 'ricastle', 'ricasle',   // rick astley and its misspellings
    'nevergonagiv', 'nevagonagiv', 'nevrgonagiv', 'nevergonegiv', 'gonagiveyoup',      // never gonna give you up
    'dqw4w9wgxcq',                                                       // the video's id in a link
  ];

  function looksLikeRickroll(text) {
    const raw = String(text == null ? '' : text);
    if (!raw.trim()) return false;
    if (/リック(・)?(ロール|アストリー)/.test(raw.normalize('NFKC'))) return true;
    const flat = squash(raw);
    if (NEEDLES.some((n) => flat.indexOf(n) !== -1)) return true;
    return /(^|[^a-z0-9])astley([^a-z0-9]|$)/i.test(raw);                // "Astley" as a word on its own
  }

  /* ---- the attempt, kept across restarts ---- */
  const store = {
    get(key) { try { return JSON.parse(root.localStorage.getItem(key) || 'null'); } catch (e) { return null; } },
    set(key, value) { try { if (value === null || value === undefined) root.localStorage.removeItem(key); else root.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* kept in memory only */ } },
  };

  let away = false;              // the app was left since the attempt
  let nowFor = null;             // id of the attempt whose dialog is on screen / was shown
  let dialog = null;
  let songJob = null;            // the download in flight, so a second attempt does not start a second one
  const waiting = {};            // native job id -> resolver

  /* ---- the hidden download: the app's own downloader, one job at a time ---- */
  function installStatusHook() {
    const previous = root.onSongDownloadStatus;
    root.onSongDownloadStatus = function (id, status, message) {
      if (typeof id === 'string' && id.indexOf('rr-') === 0) {
        const done = waiting[id];
        if (done && status !== 'running') { delete waiting[id]; done({ status: status, message: String(message || '') }); }
        return undefined;
      }
      return typeof previous === 'function' ? previous.apply(this, arguments) : undefined;
    };
  }

  function nativeJob(id, start) {
    return new Promise((resolve) => {
      waiting[id] = resolve;
      let started = false;
      try { started = start() !== false; } catch (e) { started = false; }
      if (!started) { delete waiting[id]; resolve({ status: 'failed', message: 'not started' }); return; }
      root.setTimeout(() => { if (waiting[id]) { delete waiting[id]; resolve({ status: 'failed', message: 'timed out' }); } }, JOB_TIMEOUT_MS);
    });
  }

  // The hidden song's track: the file already there, or downloaded now. null when that is not possible.
  function ensureSong() {
    const a = root.NovelAudio;
    if (!a || !a.getHiddenTrack) return Promise.resolve(null);
    const have = a.getHiddenTrack();
    if (have) return Promise.resolve(have);
    if (songJob) return songJob;
    const b = root.AndroidBridge;
    if (!b || typeof b.stageSong !== 'function' || typeof b.placeSong !== 'function') return Promise.resolve(null);
    songJob = nativeJob('rr-stage', () => b.stageSong('rr-stage', SONG_LINK))
      .then((r) => (r.status === 'done' ? nativeJob('rr-place', () => b.placeSong('rr-place', r.message, SONG_NAME, '')) : null))
      // "already in your Songs" = the file is there but not scanned yet: a scan finds it.
      .then((r) => (r && (r.status === 'done' || /already in your Songs/i.test(r.message)) ? a.rescanThen() : null))
      .then(() => a.getHiddenTrack())
      .catch(() => null)
      .then((track) => { songJob = null; return track; });
    return songJob;
  }

  // Pays the appearances in playlists that are owed (one attempt = up to two), once the song is on the phone.
  function payOwed(track) {
    const a = root.NovelAudio;
    if (!track || !a || !a.injectIntoPlaylists) return;
    let owed = Number(store.get(KEY_OWED)) || 0;
    if (owed <= 0) return;
    store.set(KEY_OWED, null);
    while (owed-- > 0) a.injectIntoPlaylists(track.id, 2);
  }

  /* ---- the attempt ---- */
  function trigger() {
    const attempt = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), t: Date.now() };
    store.set(KEY_ATTEMPT, attempt);
    store.set(KEY_OWED, (Number(store.get(KEY_OWED)) || 0) + 1);
    away = false;
    ensureSong().then(payOwed);                          // the user is away for a while: download meanwhile
    const b = root.AndroidBridge;
    let opened = false;
    try { opened = !!(b && typeof b.openExternalLink === 'function' && b.openExternalLink(RICKROLL_LINK)); } catch (e) { opened = false; }
    if (!opened && typeof root.open === 'function') { try { root.open(RICKROLL_LINK, '_blank'); opened = true; } catch (e) { /* no browser */ } }
    // Never left (nothing could open the link): do not leave the attempt hanging.
    root.setTimeout(() => { const p = store.get(KEY_ATTEMPT); if (p && p.id === attempt.id && !away) comeBack(); }, NEVER_LEFT_MS);
    return true;
  }

  function check(text) {
    if (!looksLikeRickroll(text)) return false;
    return trigger();
  }

  /* ---- coming back ---- */
  function comeBack() {
    const attempt = store.get(KEY_ATTEMPT);
    if (!attempt || nowFor === attempt.id) return;
    nowFor = attempt.id;
    store.set(KEY_ATTEMPT, null);                        // once per attempt, whatever happens next
    away = false;
    showDialog();
    ensureSong().then((track) => {
      payOwed(track);
      if (track && root.NovelAudio && root.NovelAudio.playHiddenTrack) root.NovelAudio.playHiddenTrack();
    });
  }

  function showDialog() {
    const doc = root.document;
    if (!doc || dialog) return;
    dialog = doc.createElement('div');
    dialog.id = 'rr-dialog';
    dialog.className = 'dyn-colours';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'rr-title');
    const card = doc.createElement('div');
    card.className = 'rr-card';
    const title = doc.createElement('h2');
    title.id = 'rr-title';
    title.textContent = DIALOG_TITLE;
    const text = doc.createElement('p');
    text.textContent = DIALOG_TEXT;
    const ok = doc.createElement('button');
    ok.type = 'button';
    ok.textContent = 'OK';
    ok.addEventListener('click', dismiss);
    card.appendChild(title);
    card.appendChild(text);
    card.appendChild(ok);
    dialog.appendChild(card);
    doc.body.appendChild(dialog);
    if (root.SpotifyUI && root.SpotifyUI.syncTint) root.SpotifyUI.syncTint();
    try { ok.focus(); } catch (e) { /* no focus */ }
  }

  function dismiss() {
    if (!dialog) return;
    if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
    dialog = null;
  }

  function isOpen() { return !!dialog; }

  /* ---- start-up ---- */
  function init() {
    installStatusHook();
    root.onAppPause = function () { away = true; };
    root.onAppResume = function () { if (away) comeBack(); };
    if (root.document && root.document.addEventListener) {
      root.document.addEventListener('visibilitychange', () => { if (root.document.hidden) away = true; else if (away) comeBack(); });
    }
    if (root.addEventListener) root.addEventListener('focus', () => { if (away) comeBack(); });
    // The app was closed while the user was away: this start is the return.
    if (store.get(KEY_ATTEMPT)) root.setTimeout(comeBack, 900);
    // An appearance in playlists still owed from before (the app was closed while the song downloaded).
    if (Number(store.get(KEY_OWED)) > 0) root.setTimeout(() => { ensureSong().then(payOwed); }, 5000);
  }

  root.Rickroll = { looksLikeRickroll: looksLikeRickroll, squash: squash, check: check, trigger: trigger, isOpen: isOpen, dismiss: dismiss, init: init };
  init();
})(typeof window !== 'undefined' ? window : this);
