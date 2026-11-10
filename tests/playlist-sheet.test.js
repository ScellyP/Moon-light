// Run with: node tests/playlist-sheet.test.js
// The playlist sheets in song-menu.js: create, edit (name, description, order) and delete with a confirmation.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createNode, findAll, hasClass } = require('./fake-dom');
const { check, finish } = require('./audio-harness');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app/src/main/assets/song-menu.js'), 'utf8');

function sheet(overrides, bridgeOverrides) {
  const calls = [];
  const body = createNode('body');
  const doc = { body, createElement: createNode, createElementNS: (ns, t) => createNode(t), addEventListener() {} };
  let songs = [{ id: 'a', title: 'Alpha', artist: 'X' }, { id: 'b', title: 'Beta', artist: 'Y' }, { id: 'c', title: 'Gamma', artist: 'Z' }];
  let info = { key: 'name:Mix', name: 'Mix', description: 'Old', kind: 'file', canEdit: true, canRename: true, canDelete: true, maxDescription: 500 };
  const audio = Object.assign({
    getPlaylistInfo: () => info, getPlaylistOrder: () => songs,
    editPlaylist: (k, p) => { calls.push(['edit', k, p]); return { ok: true, key: k, name: p.name }; },
    movePlaylistSong: (k, id, d) => { calls.push(['move', k, id, d]); const i = songs.findIndex(s => s.id === id), j = i + d; const t = songs[i]; songs[i] = songs[j]; songs[j] = t; return true; },
    deletePlaylist: (k) => { calls.push(['delete', k]); return { ok: true }; },
    createPlaylist: (n, d) => { calls.push(['create', n, d]); return { ok: true, key: 'name:' + n.trim(), name: n.trim() }; },
  }, overrides || {});
  const win = {
    document: doc, setTimeout: (f) => { f(); return 1; }, clearTimeout() {}, NovelAudio: audio,
    SpotifyUI: { openPlaylist: (n) => calls.push(['open', n]), setView: (v) => calls.push(['view', v]), coverChanged: (n) => calls.push(['coverChanged', n]) },
    AndroidBridge: Object.assign({
      playlistCoverPick: (k) => calls.push(['pick', k]),
      playlistCoverGet: (k) => (k === '@draft:new' ? 'data:image/jpeg;base64,DRAFT' : ''),
      playlistCoverSave: (k, u) => { calls.push(['coverSave', k, u]); return true; },
      playlistCoverClear: (k) => calls.push(['coverClear', k]),
      playlistCreate: () => true,
    }, bridgeOverrides || {}),
  };
  new Function('window', 'document', SRC.replace("})(typeof window !== 'undefined' ? window : this);", '})(window);'))(win, doc);
  const layer = () => body.children.find((c) => c.classList.contains('sm-layer'));
  const submit = (form) => (form.listeners.submit || []).forEach((f) => f({ preventDefault() {} }));
  const tapNode = (n) => (n.listeners.click || []).forEach((f) => f({ stopPropagation() {}, target: n }));
  const byLabel = (txt) => findAll(layer(), (n) => n.tag === 'button' && n.textContent === txt)[0];
  const rowLabel = (txt) => findAll(layer(), (n) => n.className.indexOf('sm-row') !== -1 && n.textContent.indexOf(txt) !== -1)[0];
  const field = (name) => findAll(layer(), (n) => n.attrs['data-sm-field'] === name)[0];
  const tapScrim = () => layer().listeners.click.forEach((f) => f({ target: layer().children[0] }));
  const toast = () => (body.children.find((c) => c.classList.contains('sm-toast')) || { textContent: '' }).textContent;
  return { rowLabel, win, calls, layer, submit, tapNode, byLabel, field, tapScrim, toast, setInfo: (i) => { info = i; }, songs: () => songs };
}

check('Name & details: Cancel / title / Save, the name, the description, Reorder, Delete', () => {
  const s = sheet();
  assert.strictEqual(s.win.SongMenu.openEdit('name:Mix', 'Mix'), true);
  assert.ok(/Name & details/.test(s.layer().textContent));
  assert.ok(s.byLabel('Cancel') && s.byLabel('Save'));
  assert.strictEqual(s.field('name').value, 'Mix');
  assert.strictEqual(s.field('description').value, 'Old');
  assert.ok(s.rowLabel('Reorder songs') && s.rowLabel('Delete playlist'));
  s.tapNode(s.rowLabel('Reorder songs'));
  const titles = findAll(s.layer(), hasClass('sm-ord-title')).map((n) => n.textContent);
  assert.deepStrictEqual(titles, ['Alpha', 'Beta', 'Gamma']);
});

check('Save sends the typed name and description; a refused name keeps the sheet open with a message', () => {
  const s = sheet();
  s.win.SongMenu.openEdit('name:Mix', 'Mix');
  s.field('name').value = '  Road trip ';
  s.field('description').value = 'For the car';
  s.tapNode(s.byLabel('Save'));
  assert.deepStrictEqual(s.calls[0], ['edit', 'name:Mix', { name: '  Road trip ', description: 'For the car' }]);
  assert.ok(s.layer().classList.contains('hidden'));
  const t = sheet({ editPlaylist: () => ({ ok: false, error: 'taken' }) });
  t.win.SongMenu.openEdit('name:Mix', 'Mix');
  t.field('name').value = 'Rock';
  t.tapNode(t.byLabel('Save'));
  assert.ok(!t.layer().classList.contains('hidden'));
  assert.ok(/already have a playlist/.test(t.toast()));
});

check('a trip to Reorder keeps what was typed', () => {
  const s = sheet();
  s.win.SongMenu.openEdit('name:Mix', 'Mix');
  s.field('description').value = 'Typed';
  s.tapNode(s.rowLabel('Reorder songs'));
  s.tapNode(s.byLabel('Back'));
  assert.strictEqual(s.field('description').value, 'Typed');
  s.tapNode(s.byLabel('Save'));
  assert.deepStrictEqual(s.calls[0], ['edit', 'name:Mix', { name: 'Mix', description: 'Typed' }]);
});

check('unsaved changes are not lost by a stray tap; Cancel discards them', () => {
  const s = sheet();
  s.win.SongMenu.openEdit('name:Mix', 'Mix');
  s.tapScrim();                                                   // nothing typed: closes
  assert.ok(s.layer().classList.contains('hidden'));
  s.win.SongMenu.openEdit('name:Mix', 'Mix');
  s.field('name').value = 'Changed';
  s.tapScrim(); s.win.SongMenu.close();                           // tap outside / Back: stays open, says why
  assert.ok(!s.layer().classList.contains('hidden'));
  assert.ok(/Cancel/.test(s.toast()));
  s.tapNode(s.byLabel('Cancel'));
  assert.ok(s.layer().classList.contains('hidden'));
  assert.strictEqual(s.calls.length, 0);                          // nothing was saved
});

check('move buttons: first row cannot go up, last cannot go down; a move reaches the player and redraws', () => {
  const s = sheet();
  s.win.SongMenu.openEdit('name:Mix', 'Mix');
  s.tapNode(s.rowLabel('Reorder songs'));
  const ups = findAll(s.layer(), (n) => n.className.indexOf('sm-ord-btn up') !== -1);
  const downs = findAll(s.layer(), (n) => n.className.indexOf('sm-ord-btn down') !== -1);
  assert.deepStrictEqual([ups[0].disabled, ups[1].disabled, downs[2].disabled, downs[0].disabled], [true, false, true, false]);
  s.tapNode(downs[0]);
  assert.deepStrictEqual(s.calls[0], ['move', 'name:Mix', 'a', 1]);
  assert.deepStrictEqual(findAll(s.layer(), hasClass('sm-ord-title')).map((n) => n.textContent), ['Beta', 'Alpha', 'Gamma']);
  assert.ok(findAll(s.layer(), (n) => n.getAttribute && /Move up: /.test(n.getAttribute('aria-label') || '')).length === 3);   // accessible names
});

check('Delete playlist asks first, says the songs stay, and Cancel goes back', () => {
  const s = sheet();
  s.win.SongMenu.openEdit('name:Mix', 'Mix');
  s.tapNode(s.rowLabel('Delete playlist'));
  assert.ok(/songs stay on your phone/.test(s.layer().textContent));
  assert.strictEqual(s.calls.length, 0);                          // not deleted yet
  s.tapNode(s.byLabel('Cancel'));
  assert.ok(s.field('name'));                                     // back on the edit form
  s.tapNode(s.rowLabel('Delete playlist'));
  s.tapNode(s.byLabel('Delete playlist'));
  assert.deepStrictEqual(s.calls[0], ['delete', 'name:Mix']);
  assert.deepStrictEqual(s.calls[1], ['view', 'library']);
  assert.ok(s.layer().classList.contains('hidden'));
});

check('a folder playlist: the name is locked and there is no delete row', () => {
  const s = sheet();
  s.setInfo({ key: 'name:Rock', name: 'Rock', description: '', kind: 'folder', canEdit: true, canRename: false, canDelete: false, maxDescription: 500 });
  s.win.SongMenu.openEdit('name:Rock', 'Rock');
  assert.strictEqual(s.field('name').disabled, true);
  assert.strictEqual(findAll(s.layer(), (n) => n.className.indexOf('sm-row') !== -1 && n.className.indexOf('danger') !== -1).length, 0);
});

check('New playlist: name + optional description, then its page opens', () => {
  const s = sheet();
  assert.strictEqual(s.win.SongMenu.openCreate(), true);
  assert.ok(/New playlist/.test(s.layer().textContent) && s.byLabel('Cancel') && s.byLabel('Create'));
  s.field('name').value = ' Gym ';
  s.field('description').value = 'Fast songs';
  s.submit(findAll(s.layer(), (n) => n.tag === 'form')[0]);
  const flow = s.calls.filter((c) => c[0] !== 'coverClear');        // (opening the sheet also drops any old temporary picture)
  assert.deepStrictEqual(flow[0], ['create', ' Gym ', 'Fast songs']);
  assert.deepStrictEqual(flow[1], ['open', 'Gym']);
  assert.ok(s.layer().classList.contains('hidden'));
  const t = sheet({ createPlaylist: () => ({ ok: false, error: 'taken' }) });
  t.win.SongMenu.openCreate();
  t.field('name').value = 'Mix';
  t.submit(findAll(t.layer(), (n) => n.tag === 'form')[0]);
  assert.ok(!t.layer().classList.contains('hidden'));
  assert.ok(/already have a playlist/.test(t.toast()));
});

check('index.html: a hidden entry in the ... sheet really is hidden (the sheet buttons set display)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app/src/main/assets/index.html'), 'utf8');
  assert.ok(/#sp-sheet-list button\.hidden\s*\{\s*display:\s*none/.test(html));
  assert.ok(/data-sp-act="editpl"/.test(html));
});

check('the Songs-tab ... menu is about the playlist; Now playing keeps the song actions', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app/src/main/assets/index.html'), 'utf8');
  const sheet = html.slice(html.indexOf('id="sp-sheet-list"'), html.indexOf('id="sp-sheet-close"'));
  const mark = (act) => (sheet.match(new RegExp('<button[^>]*data-sp-act="' + act + '"[^>]*>')) || [''])[0];
  ['like', 'addto', 'songmenu'].forEach((a) => assert.ok(/sp-song-only/.test(mark(a)), a + ' is a song action'));
  ['addsongs', 'editpl', 'cover', 'deletepl'].forEach((a) => assert.ok(/sp-pl-only/.test(mark(a)), a + ' is a playlist action'));
  assert.ok(!/sp-(song|pl)-only/.test(mark('sleep')) && !/sp-(song|pl)-only/.test(mark('rescan')));   // app-wide items stay in both
  assert.ok(/#sp-sheet\[data-sheet-mode="playlist"\] \.sp-song-only[^{]*\.sp-pl-only[^{]*\{\s*display:\s*none/.test(html));
  const js = fs.readFileSync(path.join(__dirname, '..', 'app/src/main/assets/spotify-ui.js'), 'utf8');
  assert.ok(/data-sheet-mode', playlistMode \? 'playlist' : 'song'/.test(js));
  ['addsongs', 'cover', 'deletepl', 'editpl'].forEach((a) => assert.ok(js.indexOf("case '" + a + "'") !== -1, a + ' has a handler'));
});

check('Delete playlist from the ... menu goes straight to the confirmation; folder playlists are refused', () => {
  const s = sheet();
  assert.strictEqual(s.win.SongMenu.openDelete('name:Mix', 'Mix'), true);
  assert.ok(/songs stay on your phone/.test(s.layer().textContent));
  assert.strictEqual(s.calls.length, 0);
  s.tapNode(s.byLabel('Delete playlist'));
  assert.deepStrictEqual(s.calls[0], ['delete', 'name:Mix']);
  const f = sheet();
  f.setInfo({ key: 'name:Rock', name: 'Rock', description: '', kind: 'folder', canEdit: true, canRename: false, canDelete: false, maxDescription: 500 });
  assert.strictEqual(f.win.SongMenu.openDelete('name:Rock', 'Rock'), false);
});

check('New playlist: Create waits for a name; the cover tile picks a gallery picture kept under a temporary key', () => {
  const s = sheet();
  s.win.SongMenu.openCreate();
  assert.strictEqual(s.byLabel('Create').disabled, true);
  s.field('name').value = 'Gym';
  (s.field('name').listeners.input || []).forEach((f) => f({}));
  assert.strictEqual(s.byLabel('Create').disabled, false);
  const tile = findAll(s.layer(), (n) => n.className.indexOf('sm-edit-cover') !== -1)[0];
  assert.ok(tile && !tile.getAttribute('data-sm-cover'));
  s.tapNode(tile);
  assert.deepStrictEqual(s.calls.filter((c) => c[0] === 'pick'), [['pick', '@draft:new']]);
  s.win.SongMenu.draftCoverPicked(true);                                   // the app says the gallery picture is ready
  assert.ok(tile.getAttribute('data-sm-cover'));
  s.tapNode(s.byLabel('Create'));
  assert.ok(s.calls.some((c) => c[0] === 'create' && c[1] === 'Gym'));
  assert.deepStrictEqual(s.calls.find((c) => c[0] === 'coverSave'), ['coverSave', 'Gym', 'data:image/jpeg;base64,DRAFT']);
  assert.ok(s.calls.some((c) => c[0] === 'coverChanged' && c[1] === 'Gym'));
  assert.ok(s.calls.filter((c) => c[0] === 'coverClear').length >= 1);      // the temporary picture is dropped
  assert.ok(s.layer().classList.contains('hidden'));
});

check('New playlist: a picked cover counts as unsaved work, and Cancel throws the temporary picture away', () => {
  const s = sheet();
  s.win.SongMenu.openCreate();
  s.win.SongMenu.draftCoverPicked(true);
  s.tapScrim();
  assert.ok(!s.layer().classList.contains('hidden'));                      // a stray tap keeps it open
  const before = s.calls.filter((c) => c[0] === 'coverClear').length;
  s.tapNode(s.byLabel('Cancel'));
  assert.ok(s.layer().classList.contains('hidden'));
  assert.ok(s.calls.filter((c) => c[0] === 'coverClear').length > before);
  assert.ok(!s.calls.some((c) => c[0] === 'create' || c[0] === 'coverSave'));
});

check('New playlist: a failed gallery answer or a missing picture changes nothing', () => {
  const s = sheet({}, { playlistCoverGet: () => '' });
  s.win.SongMenu.openCreate();
  const tile = findAll(s.layer(), (n) => n.className.indexOf('sm-edit-cover') !== -1)[0];
  s.win.SongMenu.draftCoverPicked(false);
  s.win.SongMenu.draftCoverPicked(true);
  assert.ok(!tile.getAttribute('data-sm-cover'));
});

check('the name and description boxes are roomy, full width, and the edit sheet shows them with labels', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app/src/main/assets/index.html'), 'utf8');
  // `flex: none` is what lets `height` count: the base .sm-input has flex: 1, which ignores height in a column form
  assert.ok(/\.sm-form \.sm-input[^{]*\{[^}]*flex:\s*none[^}]*width:\s*100%[^}]*height:\s*62px[^}]*font:\s*500 19px/.test(html));
  assert.ok(/\.sm-form textarea\.sm-input[^{]*\{[^}]*min-height:\s*92px/.test(html));
  assert.ok(!/\.sm-form[^{]*:focus[^{]*\{[^}]*var\(--accent\)/.test(html));       // no bright accent ring: tints of the app's own colours
  const s = sheet();
  s.win.SongMenu.openEdit('name:Mix', 'Mix');
  const labels = findAll(s.layer(), hasClass('sm-field-label')).map((n) => n.textContent);
  assert.deepStrictEqual(labels, ['Name', 'Description']);
  assert.strictEqual(s.field('description').rows, 3);
});

check('every screen outside the music panel follows the song colours (class dyn-colours + the tint is copied onto it)', () => {
  const dir = path.join(__dirname, '..', 'app/src/main/assets');
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.ok(/\.dyn-colours \{[^}]*--sp-sub: var\(--muted\)[^}]*--sp-accent: var\(--accent\)/.test(html));
  assert.ok(/id="settings-layer" class="dyn-colours"/.test(html));
  ['song-menu.js', 'playlist-picker.js'].forEach((f) => {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(/dyn-colours/.test(src), f + ' marks its screen');
    assert.ok(/SpotifyUI\.syncTint/.test(src), f + ' asks for the colours when it is built');
  });
  const ui = fs.readFileSync(path.join(dir, 'spotify-ui.js'), 'utf8');
  assert.ok(/querySelectorAll\('\.dyn-colours'\)/.test(ui) && /syncTint: \(\) => pushTint\(\)/.test(ui));
  assert.strictEqual((ui.match(/refreshTint:/g) || []).length, 1);   // Settings' own refreshTint (re-fit the song colour after a theme change) must not be overwritten
  assert.ok(/refreshTint: \(\) => updateTint\(\)/.test(ui));
  assert.ok(!/var\(--panel, var\(--bg\)\)/.test(html));           // no static fallback inside the new input styles
});

finish();
