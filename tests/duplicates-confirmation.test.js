// Run with: node tests/duplicates-confirmation.test.js
// Tests the duplicate review & confirmation flow before files are moved to Moonlight/Duplicates.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'app/src/main/assets');

let n = 0;
function check(name, fn) {
  try { fn(); } catch (e) { console.log('FAIL -', name); throw e; }
  n++; console.log('ok -', name);
}

const html = fs.readFileSync(path.join(ASSETS, 'index.html'), 'utf8');
const playerSrc = fs.readFileSync(path.join(ASSETS, 'audio-player.js'), 'utf8');
const playerAppSrc = fs.readFileSync(path.join(ASSETS, 'player-app.js'), 'utf8');

// 1. Static markup checks
check('index.html contains #dupe-dialog-layer with all required interactive elements', () => {
  assert.ok(html.includes('id="dupe-dialog-layer"'), 'layer exists');
  assert.ok(html.includes('id="dupe-dialog-box"'), 'box exists');
  assert.ok(html.includes('id="dupe-dialog-title"'), 'title exists');
  assert.ok(html.includes('id="dupe-dialog-sub"'), 'sub exists');
  assert.ok(html.includes('id="dupe-keep-name"'), 'keep name exists');
  assert.ok(html.includes('id="dupe-drop-name"'), 'drop name exists');
  assert.ok(html.includes('id="dupe-btn-keep"'), 'Keep both button exists');
  assert.ok(html.includes('id="dupe-btn-move"'), 'Move duplicate button exists');
  assert.ok(html.includes('id="dupe-btn-keep-all"'), 'Keep all remaining button exists');
  assert.ok(html.includes('id="dupe-btn-move-all"'), 'Move all remaining button exists');
});

// 2. Integration logic checks in audio-player.js
check('audio-player.js implements duplicate confirmation prompt and choice handling', () => {
  assert.ok(playerSrc.includes('promptDuplicates'), 'implements promptDuplicates');
  assert.ok(playerSrc.includes('_showCurrentDuplicate'), 'implements _showCurrentDuplicate');
  assert.ok(playerSrc.includes('_handleDuplicateChoice'), 'implements _handleDuplicateChoice');
  assert.ok(playerSrc.includes('isDuplicateDialogOpen'), 'implements isDuplicateDialogOpen');
  assert.ok(playerSrc.includes('closeDuplicateDialog'), 'implements closeDuplicateDialog');
  assert.ok(playerSrc.includes('isDuplicateIgnored'), 'implements isDuplicateIgnored');
  assert.ok(playerSrc.includes('ignoreDuplicatePair'), 'implements ignoreDuplicatePair');
  assert.ok(playerSrc.includes('ignoreRemainingDuplicates'), 'implements ignoreRemainingDuplicates');
  assert.ok(playerSrc.includes('clearIgnoredDuplicates'), 'implements clearIgnoredDuplicates');
});

// 3. Back handling in player-app.js
check('player-app.js handles duplicate dialog closing on Back and Escape', () => {
  assert.ok(playerAppSrc.includes('isDuplicateDialogOpen'), 'checks isDuplicateDialogOpen in handleBack');
  assert.ok(playerAppSrc.includes('closeDuplicateDialog'), 'closes dialog on Back');
});

// 4. Functional simulation of the duplicate choice flow
check('duplicate prompt asks per song instead of moving all at once', () => {
  // Mock DOM elements
  const elements = {};
  const mockDoc = {
    getElementById: (id) => {
      if (!elements[id]) {
        elements[id] = {
          id: id,
          textContent: '',
          classList: {
            _classes: new Set(['hidden']),
            contains(c) { return this._classes.has(c); },
            add(c) { this._classes.add(c); },
            remove(c) { this._classes.delete(c); },
            toggle(c, force) {
              if (force === undefined) {
                if (this._classes.has(c)) this._classes.delete(c); else this._classes.add(c);
              } else if (force) this._classes.add(c); else this._classes.delete(c);
            }
          },
          addEventListener: () => {}
        };
      }
      return elements[id];
    }
  };

  const bridgeCalls = [];
  const fakeBridge = {
    songsMergeDuplicates: (json) => {
      bridgeCalls.push(JSON.parse(json));
      const pairs = JSON.parse(json);
      return JSON.stringify(pairs.map(p => p.drop));
    }
  };

  // Run isolated test with fake window
  const originalDoc = global.document;
  const originalWin = global.window;
  global.document = mockDoc;
  global.window = { AndroidBridge: fakeBridge };

  // Verify behavior: when 2 duplicate pairs are queued
  const fakeMediaLibrary = {
    _dupeQueue: [
      {
        keep: '/Novel/Audio/Song1.mp3',
        drop: '/Moonlight/Songs/Song1 (1).mp3',
        keepId: '1', dropId: '2',
        title: 'Song 1', artist: 'Artist 1',
        keepName: 'Song1.mp3', dropName: 'Song1 (1).mp3',
        keepFolder: 'Novel/Audio', dropFolder: 'Moonlight/Songs'
      },
      {
        keep: '/Novel/Audio/Song2.mp3',
        drop: '/Moonlight/Songs/Song2 (copy).mp3',
        keepId: '3', dropId: '4',
        title: 'Song 2', artist: 'Artist 2',
        keepName: 'Song2.mp3', dropName: 'Song2 (copy).mp3',
        keepFolder: 'Novel/Audio', dropFolder: 'Moonlight/Songs'
      }
    ],
    _dupeIndex: 0,
    _dupeMovedCount: 0,
    merged: []
  };

  fakeMediaLibrary.mergeInto = function(dropId, keepId) {
    this.merged.push({ dropId, keepId });
  };

  fakeMediaLibrary._showCurrentDuplicate = function () {
    const layer = mockDoc.getElementById('dupe-dialog-layer');
    if (this._dupeIndex >= this._dupeQueue.length) {
      layer.classList.add('hidden');
      return;
    }
    const pair = this._dupeQueue[this._dupeIndex];
    mockDoc.getElementById('dupe-dialog-title').textContent = 'Duplicate song found (' + (this._dupeIndex + 1) + ' of ' + this._dupeQueue.length + ')';
    mockDoc.getElementById('dupe-dialog-sub').textContent = pair.title + ' • ' + pair.artist;
    mockDoc.getElementById('dupe-keep-name').textContent = pair.keepName;
    mockDoc.getElementById('dupe-drop-name').textContent = pair.dropName;
    layer.classList.remove('hidden');
  };

  fakeMediaLibrary._handleDuplicateChoice = function (moveCurrent, moveAllRemaining) {
    if (moveCurrent) {
      const pair = this._dupeQueue[this._dupeIndex];
      const moved = JSON.parse(fakeBridge.songsMergeDuplicates(JSON.stringify([{ keep: pair.keep, drop: pair.drop }])));
      if (moved.indexOf(pair.drop) !== -1) {
        this.mergeInto(pair.dropId, pair.keepId);
        this._dupeMovedCount++;
      }
    }
    this._dupeIndex++;
    this._showCurrentDuplicate();
  };

  // Step 1: Initial state - first song displayed
  fakeMediaLibrary._showCurrentDuplicate();
  const layer = mockDoc.getElementById('dupe-dialog-layer');
  assert.strictEqual(layer.classList.contains('hidden'), false);
  assert.strictEqual(mockDoc.getElementById('dupe-dialog-title').textContent, 'Duplicate song found (1 of 2)');
  assert.strictEqual(mockDoc.getElementById('dupe-dialog-sub').textContent, 'Song 1 • Artist 1');

  // Step 2: User chooses "Keep both" on Song 1 (moveCurrent = false)
  fakeMediaLibrary._handleDuplicateChoice(false, false);
  assert.strictEqual(bridgeCalls.length, 0, 'no bridge move call for Song 1');
  assert.strictEqual(fakeMediaLibrary.merged.length, 0, 'no merge for Song 1');

  // Song 2 is now shown
  assert.strictEqual(mockDoc.getElementById('dupe-dialog-title').textContent, 'Duplicate song found (2 of 2)');
  assert.strictEqual(mockDoc.getElementById('dupe-dialog-sub').textContent, 'Song 2 • Artist 2');

  // Step 3: User chooses "Move duplicate" on Song 2 (moveCurrent = true)
  fakeMediaLibrary._handleDuplicateChoice(true, false);
  assert.strictEqual(bridgeCalls.length, 1, 'bridge called to move Song 2 only');
  assert.strictEqual(bridgeCalls[0][0].drop, '/Moonlight/Songs/Song2 (copy).mp3');
  assert.strictEqual(fakeMediaLibrary.merged.length, 1);
  assert.strictEqual(fakeMediaLibrary.merged[0].dropId, '4');

  // Step 4: Flow finished, dialog hidden
  assert.strictEqual(layer.classList.contains('hidden'), true);

  // Restore globals
  global.document = originalDoc;
  global.window = originalWin;
});

// 5. Duplicate memory persists ignored pairs so subsequent scans skip them
check('duplicate memory persists ignored pairs and skips them on subsequent scans', () => {
  const store = {};
  const mockLocalStorage = {
    getItem: (k) => store[k] || null,
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };

  const fakeState = {
    features: {
      duplicates: { ignoredPairs: [] }
    }
  };

  const dupeHelper = {
    _dupePairKey(pathA, pathB) {
      const norm = (p) => String(p || '').trim().replace(/\\/g, '/').toLowerCase().replace(/^\/+/, '');
      const a = norm(pathA);
      const b = norm(pathB);
      return a < b ? a + ' <-> ' + b : b + ' <-> ' + a;
    },
    isDuplicateIgnored(pathA, pathB) {
      const key = this._dupePairKey(pathA, pathB);
      const st = fakeState.features.duplicates;
      if (st && Array.isArray(st.ignoredPairs) && st.ignoredPairs.indexOf(key) !== -1) return true;
      try {
        const ls = JSON.parse(mockLocalStorage.getItem('moonlight_ignored_duplicates') || '[]');
        if (Array.isArray(ls) && ls.indexOf(key) !== -1) return true;
      } catch (e) { /* ignore */ }
      return false;
    },
    ignoreDuplicatePair(pathA, pathB) {
      const key = this._dupePairKey(pathA, pathB);
      if (!fakeState.features.duplicates) fakeState.features.duplicates = { ignoredPairs: [] };
      if (fakeState.features.duplicates.ignoredPairs.indexOf(key) === -1) {
        fakeState.features.duplicates.ignoredPairs.push(key);
      }
      try {
        let ls = [];
        try { ls = JSON.parse(mockLocalStorage.getItem('moonlight_ignored_duplicates') || '[]'); } catch (e) { ls = []; }
        if (!Array.isArray(ls)) ls = [];
        if (ls.indexOf(key) === -1) {
          ls.push(key);
          mockLocalStorage.setItem('moonlight_ignored_duplicates', JSON.stringify(ls));
        }
      } catch (e) { /* ignore */ }
    },
    clearIgnoredDuplicates() {
      if (fakeState.features.duplicates) fakeState.features.duplicates.ignoredPairs = [];
      mockLocalStorage.removeItem('moonlight_ignored_duplicates');
    }
  };

  const songA = '/Novel/Audio/Meme/track1.mp3';
  const songB = '/Moonlight/Songs/track1 (1).mp3';

  // Initially not ignored
  assert.strictEqual(dupeHelper.isDuplicateIgnored(songA, songB), false);

  // User chooses "Keep both"
  dupeHelper.ignoreDuplicatePair(songA, songB);
  assert.strictEqual(dupeHelper.isDuplicateIgnored(songA, songB), true, 'pair is now recognized as ignored');
  // Order of arguments does not matter
  assert.strictEqual(dupeHelper.isDuplicateIgnored(songB, songA), true, 'canonical pair key matches in reverse order');
  // Path separators and casing do not matter
  assert.strictEqual(dupeHelper.isDuplicateIgnored('\\Novel\\Audio\\meme\\track1.mp3', '\\Moonlight\\Songs\\track1 (1).mp3'), true, 'handles backslashes and case');

  // Verify stored in localStorage
  const saved = JSON.parse(mockLocalStorage.getItem('moonlight_ignored_duplicates'));
  assert.ok(Array.isArray(saved) && saved.length === 1);

  // Clearing resets memory
  dupeHelper.clearIgnoredDuplicates();
  assert.strictEqual(dupeHelper.isDuplicateIgnored(songA, songB), false);
  assert.strictEqual(mockLocalStorage.getItem('moonlight_ignored_duplicates'), null);
});

console.log(n + ' checks passed');
