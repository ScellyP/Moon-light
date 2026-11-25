// Run with: node tests/whats-new.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createNode } = require('./fake-dom');
const WN = require('../app/src/main/assets/whats-new.js');

let n = 0;
function check(name, fn) { fn(); n++; console.log('ok -', name); }

check('parseWhatsNew parses Markdown headings, bullets, paragraphs, and ignores // comments', () => {
  const sample = [
    '// Comment line',
    '',
    '## Highlights',
    '  - **First** feature',
    '* Second feature',
    '• Third feature',
    'Plain note',
    '### Details',
    '  -   ',
  ].join('\n');
  assert.deepStrictEqual(WN.parseWhatsNew(sample), [
    { type: 'heading', level: 2, text: 'Highlights' },
    { type: 'list', items: ['**First** feature', 'Second feature', 'Third feature'] },
    { type: 'paragraph', text: 'Plain note' },
    { type: 'heading', level: 3, text: 'Details' },
  ]);
  assert.deepStrictEqual(WN.parseWhatsNew(''), []);
});

check('parseInline parses bold, italic, and code tokens', () => {
  assert.deepStrictEqual(WN.parseInline('**Bold** and *italic* and `code`!'), [
    { type: 'bold', text: 'Bold' },
    { type: 'text', text: ' and ' },
    { type: 'italic', text: 'italic' },
    { type: 'text', text: ' and ' },
    { type: 'code', text: 'code' },
    { type: 'text', text: '!' },
  ]);
});

check('shouldShowWhatsNew only triggers once per new version', () => {
  assert.strictEqual(WN.shouldShowWhatsNew('v1.19.08', ''), true);
  assert.strictEqual(WN.shouldShowWhatsNew('v1.19.08', 'v1.19.07'), true);
  assert.strictEqual(WN.shouldShowWhatsNew('v1.19.08', 'v1.19.08'), false);
  assert.strictEqual(WN.shouldShowWhatsNew('', ''), false);
});

check('bundled whats-new.txt parses to non-empty release blocks', () => {
  const txt = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/whats-new.txt'), 'utf8');
  const blocks = WN.parseWhatsNew(txt);
  assert.ok(blocks.length >= 2, 'whats-new.txt has headings and items');
});

check('checkAndShow fetches whats-new.txt, renders Markdown once, and persists seen version', async () => {
  const layer = createNode('div');
  layer.classList.add('hidden');
  const versionEl = createNode('span');
  const listEl = createNode('div');
  const okBtn = createNode('button');
  const store = {};
  const fetchCalls = [];
  const sampleTxt = '// Header\n## New\n- **Added** A\n- Added `B`';

  function runSession() {
    const win = {
      APP_VERSION: 'v1.19.08',
      localStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
      },
      fetch: (url) => {
        fetchCalls.push(url);
        return Promise.resolve({ ok: true, text: () => Promise.resolve(sampleTxt) });
      },
      document: {
        createElement: (tag) => createNode(tag),
        createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
        getElementById: (id) => {
          if (id === 'whatsnew-dialog-layer') return layer;
          if (id === 'whatsnew-dialog-version') return versionEl;
          if (id === 'whatsnew-dialog-list') return listEl;
          if (id === 'whatsnew-dialog-ok') return okBtn;
          return null;
        },
        addEventListener: () => {},
      },
    };
    win.window = win;
    const code = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/whats-new.js'), 'utf8');
    vm.runInContext(code, vm.createContext(win));
    return win;
  }

  const w1 = runSession();
  const shown1 = await w1.WhatsNew.checkAndShow();
  assert.strictEqual(shown1, true);
  assert.strictEqual(w1.WhatsNew.isOpen(), true);
  assert.strictEqual(layer.classList.contains('hidden'), false);
  assert.strictEqual(versionEl.textContent, 'v1.19.08');
  assert.strictEqual(listEl.children.length, 2); // h5 + ul
  assert.strictEqual(listEl.children[0].tag, 'h5');
  assert.strictEqual(listEl.children[1].tag, 'ul');
  assert.strictEqual(listEl.children[1].children.length, 2);
  assert.strictEqual(store[WN.SEEN_KEY], 'v1.19.08');
  assert.strictEqual(fetchCalls.length, 1);

  // Second launch on same version does not fetch or show again
  layer.classList.add('hidden');
  const w2 = runSession();
  const shown2 = await w2.WhatsNew.checkAndShow();
  assert.strictEqual(shown2, false);
  assert.strictEqual(w2.WhatsNew.isOpen(), false);
  assert.strictEqual(fetchCalls.length, 1);
});

setTimeout(() => { console.log(n + ' checks passed'); }, 50);
