/* =========================================================================
   Moonlight — song memory

   Three plain text files in /storage/emulated/0/Moonlight/ (next to settings.txt) that survive
   reinstalling, clearing the app's data or moving to a new phone (copy the folder across):

     downloads.txt   every song downloaded from a link: when, the name it was saved as, its playlist,
                     the link and the file's path. Used to say "you already downloaded this" when the
                     same link is pasted again (even in another form, e.g. youtu.be/x vs
                     youtube.com/watch?v=x).
     favorites.txt   the liked songs with their details (title, artist, album, playlist, length, path)
     recents.txt     the recently played songs (newest first, up to 100), same details

   All three are tab separated, one song per line, with a short comment header (lines that start with #),
   so they open in any text editor or spreadsheet. The app rewrites favorites.txt / recents.txt whenever
   the liked or played songs change, and brings them back at start-up if the app's own copy is empty
   (a fresh install). It also answers "is there already a song with a similar name?" while a
   downloaded song is being named.

   The first half of this file is pure (no page, no phone): the tests in tests/song-memory.test.js
   run it. The second half is the page glue.
   ========================================================================= */
(function (root) {
  'use strict';

  /* ======================================================================
     Pure helpers
     ====================================================================== */

  // Lower case, accents removed, anything that is not a letter or digit (in any language) becomes a
  // single space.
  function normalizeText(s) {
    return String(s == null ? '' : s)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  // Words that say nothing about WHICH song it is (video titles are full of them).
  const NOISE = new Set(['official', 'video', 'videos', 'audio', 'lyrics', 'lyric', 'hd', 'hq', '4k', 'mv',
    'visualizer', 'visualiser', 'remastered', 'explicit', 'ft', 'feat', 'featuring', 'prod', 'topic', 'vevo']);

  function coreWords(s) {
    return normalizeText(s).split(' ').filter((w) => w && !NOISE.has(w));
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = new Array(b.length + 1);
    let cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      cur[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      const t = prev; prev = cur; cur = t;
    }
    return prev[b.length];
  }

  // A name worked out once (its words without noise): comparing many names to one reuses these.
  function coreOf(s) {
    const words = coreWords(s);
    return { words: words, joined: words.join(' '), set: new Set(words), bi: null };
  }

  // Pairs of neighbouring letters, worked out when first needed: a cheap way to tell that two names have
  // nothing in common before the (slower) spelling distance is calculated.
  function bigrams(core) {
    if (!core.bi) {
      const set = new Set();
      for (let i = 0; i + 1 < core.joined.length; i++) set.add(core.joined.substr(i, 2));
      core.bi = set;
    }
    return core.bi;
  }

  function dice(A, B) {
    const a = bigrams(A), b = bigrams(B);
    if (!a.size || !b.size) return 0;
    let common = 0;
    a.forEach((x) => { if (b.has(x)) common++; });
    return (2 * common) / (a.size + b.size);
  }

  function similarityCore(A, B) {
    if (!A.words.length || !B.words.length) return 0;
    const sa = A.joined, sb = B.joined;
    if (sa === sb) return 1;

    const shortS = sa.length <= sb.length ? sa : sb;
    const longS = sa.length <= sb.length ? sb : sa;
    let contain = 0;
    if (shortS.length >= 4 && (' ' + longS + ' ').indexOf(' ' + shortS + ' ') !== -1) {
      contain = 0.7 + 0.3 * (shortS.length / longS.length);
    }

    let inter = 0;
    A.set.forEach((w) => { if (B.set.has(w)) inter++; });
    const union = A.set.size + B.set.size - inter;
    const jaccard = union ? inter / union : 0;
    // The same words in another order ("Artist Song" vs "Song Artist") is the same song.
    const sameSet = A.set.size === B.set.size && inter === A.set.size;

    // Spelling distance only counts as a typo when it is a couple of letters (or ~15%) at most, in a name of
    // reasonable length: "Run"/"Sun" and "Gone Song"/"Here Song" are different songs, not typos.
    const maxLen = Math.max(sa.length, sb.length);
    const allowed = Math.max(2, Math.floor(maxLen * 0.15));
    let edit = 0;
    // Only names of a similar length that share most of their letter pairs can be typos of each other: skip the slow part otherwise.
    if (maxLen >= 6 && Math.abs(sa.length - sb.length) <= allowed && dice(A, B) >= 0.5) {
      const dist = levenshtein(sa, sb);
      if (dist <= allowed) edit = 1 - dist / maxLen;
    }
    return Math.min(0.99, Math.max(contain, jaccard, edit, sameSet ? 0.97 : 0));
  }

  /* How alike two song names are, 0..1. 1 = the same song name (ignoring case, accents, punctuation,
     "(Official Video)" style noise and word order). Takes the best of: one name sitting whole inside
     the other, the share of words in common, and the spelling distance (typos). */
  function similarity(a, b) { return similarityCore(coreOf(a), coreOf(b)); }

  // The names a song can be compared by: its title, "artist title" and "title artist".
  function coresOfSong(title, artist) {
    const cores = [coreOf(title)];
    if (artist) cores.push(coreOf(artist + ' ' + title), coreOf(title + ' ' + artist));
    return cores;
  }

  /* Songs with a name like [name]. candidates: [{ title, artist, playlist, path, source }]; each is
     compared by its title, "artist title" and "title artist" (a candidate may carry those already worked
     out in _cores, which keeps a big library quick). Returns the best matches first:
     { ...candidate, score, exact } where exact means "the same song name" (score >= 0.95). */
  function findSimilar(name, candidates, opts) {
    const threshold = opts && opts.threshold != null ? opts.threshold : 0.6;
    const limit = opts && opts.limit != null ? opts.limit : 5;
    if (!normalizeText(name)) return [];
    const target = coreOf(name);
    const out = [];
    (candidates || []).forEach((c) => {
      const cores = c._cores || coresOfSong(String(c.title || ''), String(c.artist || ''));
      let score = 0;
      for (let i = 0; i < cores.length; i++) score = Math.max(score, similarityCore(target, cores[i]));
      if (score >= threshold) {
        const copy = Object.assign({}, c, { score: score, exact: score >= 0.95 });
        delete copy._cores;
        out.push(copy);
      }
    });
    out.sort((x, y) => (y.score - x.score) || ((x.source === 'log' ? 1 : 0) - (y.source === 'log' ? 1 : 0)));
    return out.slice(0, limit);
  }

  const TRACKING_PARAMS = /^(utm_[a-z]+|si|feature|fbclid|gclid|igshid|pp|ref|ref_src|source|context|app|sp_cid)$/i;

  /* One key per song, however its link is written. YouTube links (youtu.be/x, youtube.com/watch?v=x,
     music.youtube.com, /shorts/x, /embed/x ...) all become "youtube:x"; other sites keep host + path
     (+ the query minus tracking parameters). Used to spot a link that was downloaded before. */
  function normalizeUrl(url) {
    const raw = String(url == null ? '' : url).trim();
    let u;
    try { u = new URL(raw); } catch (e) { return raw.toLowerCase(); }
    const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
    const path = u.pathname.replace(/\/+$/, '');

    let id = '';
    if (host === 'youtu.be') id = path.split('/')[1] || '';
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      id = u.searchParams.get('v') || '';
      if (!id) {
        const m = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(u.pathname);
        if (m) id = m[1];
      }
    }
    if (id) return 'youtube:' + id;

    if (host === 'open.spotify.com') {
      const m = /\/(track|album|playlist|episode)\/([A-Za-z0-9]+)/.exec(u.pathname);
      if (m) return 'spotify:' + m[1] + ':' + m[2];
    }

    const keep = [];
    u.searchParams.forEach((value, key) => { if (!TRACKING_PARAMS.test(key)) keep.push(key + '=' + value); });
    keep.sort();
    return host + path + (keep.length ? '?' + keep.join('&') : '');
  }

  /* ---- the text files ---- */

  const pad = (n) => (n < 10 ? '0' : '') + n;

  function formatDate(ms) {
    const d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function parseDate(text) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/.exec(String(text || '').trim());
    if (!m) return 0;
    return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)).getTime();
  }

  // One field of a line: tabs and line breaks would break the format.
  function cleanField(s) {
    return String(s == null ? '' : s).replace(/[\t\r\n\u0000-\u001f]+/g, ' ').trim();
  }

  function lengthText(sec) {
    const total = Math.round(Number(sec) || 0);
    if (total <= 0) return '';
    return Math.floor(total / 60) + ':' + pad(total % 60);
  }

  const DOWNLOADS_HEADER = [
    '# Moonlight download log. One song per line, separated by tabs:',
    '# date <TAB> name it was saved as <TAB> playlist <TAB> link <TAB> file path',
    '# Moonlight reads this to tell you when a link was downloaded before. Safe to edit or delete lines.',
  ];

  // entries: [{ t, name, playlist, url, path }] in the order they were downloaded.
  function formatDownloadLog(entries) {
    const lines = DOWNLOADS_HEADER.slice();
    (entries || []).forEach((e) => {
      lines.push([formatDate(e.t), cleanField(e.name), cleanField(e.playlist), cleanField(e.url), cleanField(e.path)].join('\t'));
    });
    return lines.join('\n') + '\n';
  }

  function parseDownloadLog(text) {
    const entries = [];
    String(text || '').split(/\r?\n/).forEach((line) => {
      if (!line.trim() || line.charAt(0) === '#') return;
      const f = line.split('\t');
      if (f.length < 4) return;
      const url = f[3].trim();
      if (!/^https?:\/\//i.test(url)) return;
      entries.push({
        t: parseDate(f[0]), name: f[1].trim(), playlist: f[2].trim(), url: url,
        path: (f[4] || '').trim(), key: normalizeUrl(url),
      });
    });
    return entries;
  }

  const LIST_KINDS = {
    favorites: [
      '# Moonlight favourites: the songs you liked. One song per line, separated by tabs:',
      '# date liked <TAB> title <TAB> artist <TAB> album <TAB> playlist <TAB> length <TAB> file path',
    ],
    recents: [
      '# Moonlight recently played songs, newest first (up to 100). One song per line, separated by tabs:',
      '# date last played <TAB> title <TAB> artist <TAB> album <TAB> playlist <TAB> length <TAB> file path',
    ],
  };

  // rows: [{ t, title, artist, album, playlist, length, path }]
  function formatSongList(kind, rows) {
    const lines = (LIST_KINDS[kind] || LIST_KINDS.favorites).slice();
    (rows || []).forEach((r) => {
      lines.push([formatDate(r.t), cleanField(r.title), cleanField(r.artist), cleanField(r.album),
        cleanField(r.playlist), cleanField(r.length), cleanField(r.path)].join('\t'));
    });
    return lines.join('\n') + '\n';
  }

  function parseSongList(text) {
    const rows = [];
    String(text || '').split(/\r?\n/).forEach((line) => {
      if (!line.trim() || line.charAt(0) === '#') return;
      const f = line.split('\t');
      if (f.length < 7) return;
      const path = f.slice(6).join('\t').trim();
      if (!path) return;
      rows.push({ t: parseDate(f[0]), title: f[1].trim(), artist: f[2].trim(), album: f[3].trim(),
        playlist: f[4].trim(), length: f[5].trim(), path: path });
    });
    return rows;
  }

  const api = {
    normalizeText: normalizeText, levenshtein: levenshtein, similarity: similarity, findSimilar: findSimilar, normalizeUrl: normalizeUrl,
    formatDate: formatDate, parseDate: parseDate, cleanField: cleanField, lengthText: lengthText,
    formatDownloadLog: formatDownloadLog, parseDownloadLog: parseDownloadLog,
    formatSongList: formatSongList, parseSongList: parseSongList,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window === 'undefined' && !root.document) return;

  /* ======================================================================
     Page glue
     ====================================================================== */

  const FILE_DOWNLOADS = 'downloads.txt';
  const FILE_FAVORITES = 'favorites.txt';
  const FILE_RECENTS = 'recents.txt';
  const TIMES_KEY = 'moonlight_songTimes';       // when each song was liked / last played (for the date column)
  const WRITE_DELAY_MS = 600;

  const bridge = () => root.AndroidBridge;
  const audio = () => root.NovelAudio || null;

  /* The files go through the native bridge. In a plain browser (tests, desktop) the same text is kept
     in localStorage instead, so the feature still works there. Returns null when the phone's storage is
     not accessible yet (permission not granted), '' when there is no such file yet. */
  const store = {
    read(name) {
      const b = bridge();
      if (b && typeof b.readDataFile === 'function') {
        try { const text = b.readDataFile(name); return text === undefined ? null : text; } catch (e) { return null; }
      }
      try { return root.localStorage.getItem('moonlight_file_' + name) || ''; } catch (e) { return null; }
    },
    write(name, text) {
      const b = bridge();
      if (b && typeof b.writeDataFile === 'function') {
        try { return !!b.writeDataFile(name, text); } catch (e) { return false; }
      }
      try { root.localStorage.setItem('moonlight_file_' + name, text); return true; } catch (e) { return false; }
    },
  };

  /* ---- downloads.txt ---- */

  let log = null;            // parsed entries once the file has been read
  let pendingLog = [];       // entries made before the file could be read (no storage access yet)

  function ensureLog() {
    if (log) return log;
    const text = store.read(FILE_DOWNLOADS);
    if (text === null) return null;
    log = parseDownloadLog(text);
    if (pendingLog.length) { log = log.concat(pendingLog); pendingLog = []; writeLog(); }
    return log;
  }

  function writeLog() {
    if (!log) return false;
    return store.write(FILE_DOWNLOADS, formatDownloadLog(log));
  }

  function downloadLog() { return (ensureLog() || []).concat(pendingLog); }

  // The entry for a link downloaded before (in any form of the same link), or null.
  function findDownloaded(url) {
    const key = normalizeUrl(url);
    const all = downloadLog();
    for (let i = all.length - 1; i >= 0; i--) if (all[i].key === key) return all[i];
    return null;
  }

  // A song was downloaded and placed: remember its link and the name it was saved under.
  function recordDownload(info) {
    if (!info || !/^https?:\/\//i.test(String(info.url || ''))) return false;
    const entry = {
      t: info.t || Date.now(), name: cleanField(info.name), playlist: cleanField(info.playlist),
      url: cleanField(info.url), path: cleanField(info.path), key: normalizeUrl(info.url),
    };
    const list = ensureLog();
    if (!list) { pendingLog.push(entry); return false; }
    // The same link downloaded again on purpose: update its line instead of listing it twice.
    const i = list.findIndex((e) => e.key === entry.key && e.path === entry.path);
    if (i >= 0) list[i] = entry; else list.push(entry);
    return writeLog();
  }

  // Is that downloaded file still among the songs on the phone?
  function isPresent(entry) {
    const a = audio();
    if (!entry || !entry.path || !a || !a.getTrackInfo) return false;
    return !!a.getTrackInfo(entry.path);
  }

  /* ---- similar names ---- */

  const coreCache = new WeakMap();   // track -> its names worked out once, so naming stays quick with thousands of songs

  // Songs a new name could duplicate: the library, plus songs downloaded before whose file is gone
  // (deleted since, but the name is still known).
  function similarTo(name, opts) {
    const a = audio();
    const out = [];
    const seen = new Set();
    const tracks = a && a.getTracks ? a.getTracks() : [];
    tracks.forEach((t) => {
      seen.add(t.id);
      let cores = coreCache.get(t);
      if (!cores) { cores = coresOfSong(t.title || '', t.artist || ''); coreCache.set(t, cores); }
      out.push({ title: t.title || '', artist: t.artist || '', playlist: t.playlist || '', path: t.id, source: 'library', _cores: cores });
    });
    downloadLog().forEach((e) => {
      if (e.path && seen.has(e.path)) return;
      out.push({ title: e.name, artist: '', playlist: e.playlist, path: e.path, source: 'log', t: e.t });
    });
    return findSimilar(name, out, opts);
  }

  /* ---- favorites.txt and recents.txt ---- */

  let times = { liked: {}, played: {} };
  try {
    const saved = JSON.parse(root.localStorage.getItem(TIMES_KEY) || 'null');
    if (saved && typeof saved === 'object') times = { liked: saved.liked || {}, played: saved.played || {} };
  } catch (e) { /* start with none */ }
  function saveTimes() { try { root.localStorage.setItem(TIMES_KEY, JSON.stringify(times)); } catch (e) { /* non-fatal */ } }

  let meta = {};              // details read back from the files, for songs no longer in the library
  let restored = false;       // the files have been read once (until then nothing is ever written)
  let lastSig = '';
  let lastLiked = [];
  let lastPlayed = [];
  let timer = 0;

  function stemOf(path) { return String(path).split(/[\\/]/).pop().replace(/\.[^.]*$/, ''); }

  function rowFor(id, t) {
    const a = audio();
    const info = a && a.getTrackInfo ? a.getTrackInfo(id) : null;
    const old = meta[id] || {};
    if (info) {
      return { t: t, title: info.title || stemOf(id), artist: info.artist || '', album: info.album || '',
        playlist: info.playlist || '', length: lengthText(info.durationSec), path: id };
    }
    // Not in the library right now (file moved or deleted, or the scan is not done): keep what was known.
    return { t: t, title: old.title || stemOf(id), artist: old.artist || '', album: old.album || '',
      playlist: old.playlist || '', length: old.length || '', path: id };
  }

  function snapshot() {
    const a = audio();
    if (!a || !a.getLikedIds || !a.getHistoryIds) return null;
    return { liked: a.getLikedIds(), played: a.getHistoryIds() };
  }

  function writeLists() {
    timer = 0;
    const s = snapshot();
    if (!s) return;
    const now = Date.now();
    const fav = s.liked.map((id) => rowFor(id, times.liked[id] || now));
    const rec = s.played.map((id) => rowFor(id, times.played[id] || now));
    store.write(FILE_FAVORITES, formatSongList('favorites', fav));
    store.write(FILE_RECENTS, formatSongList('recents', rec));
    fav.concat(rec).forEach((r) => { meta[r.path] = r; });
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(writeLists, WRITE_DELAY_MS);
  }

  function flush() { if (timer) { clearTimeout(timer); writeLists(); } }

  // Called whenever the player saves its preferences: did the liked or played songs change?
  function changed() {
    if (!restored) return;                 // never overwrite the files before they were read once
    const s = snapshot();
    if (!s) return;
    const sig = s.liked.join('\n') + '\u0001' + s.played.join('\n');
    if (sig === lastSig) return;
    const now = Date.now();
    s.liked.forEach((id) => { if (lastLiked.indexOf(id) === -1) times.liked[id] = now; });
    Object.keys(times.liked).forEach((id) => { if (s.liked.indexOf(id) === -1) delete times.liked[id]; });
    if (s.played[0] && s.played[0] !== lastPlayed[0]) times.played[s.played[0]] = now;
    Object.keys(times.played).forEach((id) => { if (s.played.indexOf(id) === -1) delete times.played[id]; });
    lastSig = sig; lastLiked = s.liked; lastPlayed = s.played;
    saveTimes();
    schedule();
  }

  /* After a library scan: read favorites.txt / recents.txt once. If the app's own liked / recent list
     is empty (a fresh install, or its data was cleared) the file's songs are put back. Otherwise the
     app's list wins and the files are simply rewritten from it. */
  function restore() {
    ensureLog();     // also reads downloads.txt, and writes any entry made while storage was not accessible
    if (restored) return;
    const a = audio();
    if (!a || !a.getLikedIds) return;
    const favText = store.read(FILE_FAVORITES);
    const recText = store.read(FILE_RECENTS);
    if (favText === null && recText === null) return;     // storage not accessible yet: try after the next scan
    const fav = parseSongList(favText || '');
    const rec = parseSongList(recText || '');
    fav.concat(rec).forEach((r) => { meta[r.path] = r; });
    fav.forEach((r) => { if (r.t) times.liked[r.path] = r.t; });
    rec.forEach((r) => { if (r.t) times.played[r.path] = r.t; });
    if (!a.getLikedIds().length && fav.length && a.setLikedIds) a.setLikedIds(fav.map((r) => r.path));
    if (!a.getHistoryIds().length && rec.length && a.setHistoryIds) a.setHistoryIds(rec.map((r) => r.path));
    restored = true;
    const s = snapshot() || { liked: [], played: [] };
    lastLiked = s.liked; lastPlayed = s.played;
    lastSig = s.liked.join('\n') + '\u0001' + s.played.join('\n');
    saveTimes();
    schedule();     // makes the files exist from the first launch on
  }

  if (root.document && root.document.addEventListener) {
    root.document.addEventListener('visibilitychange', () => { if (root.document.hidden) flush(); });
    if (root.addEventListener) root.addEventListener('pagehide', flush);
  }

  root.SongMemoryPure = api;      // the pure helpers, for song-search.js
  root.SongMemory = {
    findDownloaded: findDownloaded, recordDownload: recordDownload, downloadLog: downloadLog,
    isPresent: isPresent, similarTo: similarTo, normalizeUrl: normalizeUrl,
    changed: changed, restore: restore, flush: flush,
    _isRestored: () => restored,
  };
})(typeof window !== 'undefined' ? window : this);
