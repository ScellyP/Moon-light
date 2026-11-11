// Run with: node tests/rickroll.test.js
// The Rickroll Easter egg (rickroll.js): detection, opening the link, the hidden download, the dialog on return.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createNode, findAll } = require('./fake-dom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app/src/main/assets/rickroll.js'), 'utf8');
const LINK = 'https://youtu.be/gDjMZvYWUdo';
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('ok -', name); }
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function load(opts) {
  const o = opts || {};
  const store = o.store || new Map();
  const timers = [], calls = [], docListeners = {}, winListeners = {};
  const body = createNode('body');
  const doc = { body, hidden: false, createElement: createNode, addEventListener: (t, f) => { (docListeners[t] = docListeners[t] || []).push(f); } };
  let hidden = o.hasSong ? { id: '/m/Songs/Never Gonna Give You Up.mp3' } : null;
  const win = {
    document: doc,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; },
    addEventListener: (t, f) => { (winListeners[t] = winListeners[t] || []).push(f); }, open: (u) => calls.push(['open', u]),
    onSongDownloadStatus: (id, st, msg) => calls.push(['other', id, st, msg]),
    AndroidBridge: o.noBridge ? undefined : {
      openExternalLink: (u) => { calls.push(['link', u]); return o.linkFails ? false : true; },
      stageSong: (id, u) => { calls.push(['stage', id, u]); return true; },
      placeSong: (id, p, n, f) => { calls.push(['place', id, p, n, f]); return true; },
    },
    NovelAudio: {
      getHiddenTrack: () => hidden,
      rescanThen: () => { calls.push(['rescan']); hidden = { id: '/m/Songs/Never Gonna Give You Up.mp3' }; return Promise.resolve(); },
      injectIntoPlaylists: (id, n) => { calls.push(['inject', id, n]); return []; },
      playHiddenTrack: () => { calls.push(['play']); return true; },
    },
    SpotifyUI: { syncTint() {} },
  };
  new Function('window', SRC.replace("})(typeof window !== 'undefined' ? window : this);", '})(window);'))(win);
  const dialogs = () => findAll(body, (n) => n.id === 'rr-dialog');
  const dialogText = () => (dialogs()[0] ? dialogs()[0].textContent : '');
  const count = (kind) => calls.filter((c) => c[0] === kind).length;
  const runTimers = (ms) => { timers.filter((t) => t.ms >= ms).forEach((t) => t.f()); };
  const finishDownload = async () => {
    win.onSongDownloadStatus('rr-stage', 'done', '/staged/x.mp3'); await settle();
    win.onSongDownloadStatus('rr-place', 'done', '/m/Songs/Never Gonna Give You Up.mp3'); await settle();
  };
  const fire = (type) => (docListeners[type] || []).slice().forEach((f) => f({}));
  const fireWin = (type) => (winListeners[type] || []).slice().forEach((f) => f({}));
  return { win, doc, calls, store, timers, dialogs, dialogText, count, runTimers, finishDownload, body, fire, fireWin };
}

(async () => {
  await check('detects Rick Astley, rickrolling, the song title and the video id, with misspellings and other scripts', () => {
    const { looksLikeRickroll: yes } = load().win.Rickroll;
    ['Rick Astley', 'rick astley - never gonna give you up', 'rickroll', 'Rick Roll', 'rick-rolled', 'RICKROLLING ME', 'rik roll', 'Rickrol',
      'rick astly', 'rick asley', 'Ric Astley', 'never gonna give you up', 'Never Gona Give U Up', 'nevr gonna give you up', 'NEVERGONNAGIVEYOUUP',
      'gonna give you up', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ?t=1', 'Astley', 'リックロール', 'リック・アストリー',
    ].forEach((t) => assert.strictEqual(yes(t), true, t));
  });

  await check('ordinary titles, links and empty text are not taken for one', () => {
    const { looksLikeRickroll: yes } = load().win.Rickroll;
    ['Bohemian Rhapsody', 'Rick and Morty theme', 'Brick Road', 'Rock and Roll', 'Never Gonna Stop', 'Give You Up', 'Astleys Pizza', 'https://youtu.be/abc123',
      'Hello - Adele', '', '   ', null, undefined,
    ].forEach((t) => assert.strictEqual(yes(t), false, String(t)));
  });

  await check('a Rickroll attempt opens the link, starts the hidden download, and is not handled further', async () => {
    const a = load();
    assert.strictEqual(a.win.Rickroll.check('rick astley'), true);
    assert.deepStrictEqual(a.calls.filter((c) => c[0] === 'link'), [['link', LINK]]);
    assert.deepStrictEqual(a.calls.find((c) => c[0] === 'stage'), ['stage', 'rr-stage', LINK]);
    assert.strictEqual(a.dialogs().length, 0);                                        // nothing on screen while away
    assert.strictEqual(a.win.Rickroll.check('Hello - Adele'), false);                 // anything else goes on as usual
    assert.strictEqual(a.count('link'), 1);
  });

  await check('the download goes stage -> place (fixed name, no playlist folder) -> rescan -> up to two playlist appearances, once', async () => {
    const a = load();
    a.win.Rickroll.check('rickroll');
    await a.finishDownload();
    assert.deepStrictEqual(a.calls.find((c) => c[0] === 'place'), ['place', 'rr-place', '/staged/x.mp3', 'Never Gonna Give You Up', '']);
    assert.strictEqual(a.count('rescan'), 1);
    assert.deepStrictEqual(a.calls.filter((c) => c[0] === 'inject'), [['inject', '/m/Songs/Never Gonna Give You Up.mp3', 2]]);
  });

  await check('status messages of the normal downloads still reach the Download tab', () => {
    const a = load();
    a.win.onSongDownloadStatus(7, 'done', '/staged/y.mp3');
    assert.deepStrictEqual(a.calls.find((c) => c[0] === 'other'), ['other', 7, 'done', '/staged/y.mp3']);
  });

  await check('back in the app: the dialog shows once, the song plays, and leaving/entering again does not repeat it', async () => {
    const a = load();
    a.win.Rickroll.check('rick astley');
    await a.finishDownload();
    assert.strictEqual(a.dialogs().length, 0);
    a.win.onAppResume();                                                              // resume without having left: nothing
    assert.strictEqual(a.dialogs().length, 0);
    a.win.onAppPause();                                                               // the link opened
    a.win.onAppResume();                                                              // and the user is back
    assert.strictEqual(a.dialogs().length, 1);
    assert.ok(/Nice try/.test(a.dialogText()));
    assert.ok(/dyn-colours/.test(a.dialogs()[0].className));
    await settle();
    assert.strictEqual(a.count('play'), 1);
    a.win.onAppPause(); a.win.onAppResume();
    assert.strictEqual(a.dialogs().length, 1);                                        // still the one dialog
    assert.strictEqual(a.count('play'), 1);
    a.win.Rickroll.dismiss();
    a.win.onAppPause(); a.win.onAppResume();
    assert.strictEqual(a.dialogs().length, 0);                                        // nothing more for that attempt
    assert.strictEqual(a.store.has('moonlight_rr_attempt'), false);
  });

  await check('switching apps (visibilitychange / focus) works as well as the app\'s own pause/resume', async () => {
    const a = load();
    a.win.Rickroll.check('never gonna give you up');
    await a.finishDownload();
    a.fire('visibilitychange');                                                       // still visible: nothing
    assert.strictEqual(a.dialogs().length, 0);
    a.doc.hidden = true; a.fire('visibilitychange');                                  // the user went to the browser / YouTube
    assert.strictEqual(a.dialogs().length, 0);
    a.doc.hidden = false; a.fire('visibilitychange');                                 // ... and back through the app switcher
    assert.strictEqual(a.dialogs().length, 1);
    await settle();
    assert.strictEqual(a.count('play'), 1);
    const b = load();
    b.win.Rickroll.check('rickroll');
    b.doc.hidden = true; b.fire('visibilitychange');
    b.fireWin('focus');                                                               // some phones only deliver focus
    assert.strictEqual(b.dialogs().length, 1);
  });

  await check('a return before the song finished downloading still shows the dialog now and plays as soon as it is there', async () => {
    const a = load();
    a.win.Rickroll.check('rick astley');
    a.win.onAppPause(); a.win.onAppResume();
    assert.strictEqual(a.dialogs().length, 1);
    assert.strictEqual(a.count('play'), 0);                                           // not there yet
    await a.finishDownload();
    assert.strictEqual(a.count('play'), 1);
  });

  await check('the second attempt reuses the file: no second download, but its own appearances', async () => {
    const a = load({ hasSong: true });
    a.win.Rickroll.check('rickroll');
    await settle();
    assert.strictEqual(a.count('stage'), 0);
    assert.strictEqual(a.count('inject'), 1);
    a.win.onAppPause(); a.win.onAppResume();
    a.win.Rickroll.dismiss();
    a.win.Rickroll.check('rick astley');
    await settle();
    assert.strictEqual(a.count('stage'), 0);
    assert.strictEqual(a.count('inject'), 2);                                         // two attempts = up to 2 + 2
    assert.ok(a.calls.filter((c) => c[0] === 'inject').every((c) => c[2] === 2));      // never more than two per attempt
  });

  await check('two attempts while the song is still downloading share one download', async () => {
    const a = load();
    a.win.Rickroll.check('rickroll'); a.win.Rickroll.check('rick astley');
    assert.strictEqual(a.count('stage'), 1);
    await a.finishDownload();
    assert.strictEqual(a.calls.filter((c) => c[0] === 'inject').length, 2);          // one payment per attempt owed
  });

  await check('if the link cannot be opened the attempt still ends with the dialog', async () => {
    const a = load({ linkFails: true, hasSong: true });
    a.win.Rickroll.check('rickroll');
    assert.ok(a.calls.some((c) => c[0] === 'open' && c[1] === LINK));                 // tried the browser way
    assert.strictEqual(a.dialogs().length, 0);
    a.runTimers(15000);                                                               // never left
    assert.strictEqual(a.dialogs().length, 1);
  });

  await check('the app was closed while the user was away: the next start shows the dialog once', async () => {
    const first = load();
    first.win.Rickroll.check('rick astley');
    const second = load({ store: first.store, hasSong: true });                       // a new run of the app, same storage
    assert.strictEqual(second.dialogs().length, 0);
    second.runTimers(900);
    assert.strictEqual(second.dialogs().length, 1);
    await settle();
    assert.strictEqual(second.count('play'), 1);
    const third = load({ store: first.store, hasSong: true });
    third.runTimers(900);
    assert.strictEqual(third.dialogs().length, 0);                                    // not again
  });

  await check('the appearances owed when the app was closed mid-download are paid on the next start', async () => {
    const first = load();
    first.win.Rickroll.check('rickroll');                                             // downloading ... app closed
    const second = load({ store: first.store, hasSong: true });
    second.runTimers(5000);
    await settle();
    assert.deepStrictEqual(second.calls.filter((c) => c[0] === 'inject').length, 1);
    const third = load({ store: first.store, hasSong: true });
    third.runTimers(5000);
    await settle();
    assert.strictEqual(third.count('inject'), 0);                                     // paid once
  });

  await check('wiring: the Download tab checks pasted text and the saved name; the app reports leaving and returning; the link opens only as http(s)', () => {
    const dir = path.join(__dirname, '..', 'app/src/main');
    const rd = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
    const dl = rd('assets/song-download.js');
    assert.ok(/function takeClipboardText\(text\) \{\s*if \(root\.Rickroll && root\.Rickroll\.check\(text\)\) return;/.test(dl));
    assert.ok(/root\.Rickroll\.check\(input\.value\)\) \{ wizard\.leave\(\); return; \}/.test(dl));      // a song named like that is discarded, not kept
    assert.ok(/button\('Save', 'dl-primary', trySave\)/.test(dl));
    const html = rd('assets/index.html');
    assert.ok(html.indexOf('song-download.js"></script>') < html.indexOf('rickroll.js"></script>'));       // it wraps the status callback song-download.js sets
    const kt = rd('java/com/scell/moonlight/MainActivity.kt');
    assert.ok(/callPage\("onAppPause"\)/.test(kt) && /callPage\("onAppResume"\)/.test(kt));
    const open = kt.slice(kt.indexOf('fun openExternalLink'), kt.indexOf('fun openExternalLink') + 500);
    assert.ok(/u\.scheme != "https" && u\.scheme != "http"\) return false/.test(open) && /openInExternalBrowser\(u\)/.test(open));
    assert.ok(/\.Rickroll\.isOpen\(\)/.test(rd('assets/player-app.js')));                                  // Android Back closes the dialog
  });

  console.log(passed + ' checks passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
