/* =========================================================================
   What's New popup — shown once on launch after an app update.
   Reads Markdown-style release notes from assets/whats-new.txt so it can
   be edited without touching any JavaScript.
   ========================================================================= */
(function (root) {
  'use strict';

  var SEEN_KEY = 'moonlight_whats_new_seen_v1';

  /**
   * Parses inline Markdown (`**bold**`, `*italic*`, `` `code` ``) into safe tokens.
   */
  function parseInline(text) {
    var tokens = [];
    var s = String(text || '');
    var re = /(\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*)/g;
    var last = 0;
    var m;
    while ((m = re.exec(s)) !== null) {
      if (m.index > last) tokens.push({ type: 'text', text: s.slice(last, m.index) });
      if (m[2] != null) tokens.push({ type: 'bold', text: m[2] });
      else if (m[3] != null) tokens.push({ type: 'code', text: m[3] });
      else if (m[4] != null) tokens.push({ type: 'italic', text: m[4] });
      last = re.lastIndex;
    }
    if (last < s.length) tokens.push({ type: 'text', text: s.slice(last) });
    return tokens;
  }

  /**
   * Parses Markdown-style release notes into structured blocks:
   * - `// ...` lines and blank lines are ignored
   * - `#` / `##` / `###` -> `{ type: 'heading', level, text }`
   * - `- ` / `* ` / `• ` -> grouped into `{ type: 'list', items: [...] }`
   * - plain text -> `{ type: 'paragraph', text }`
   */
  function parseWhatsNew(text) {
    if (!text) return [];
    var lines = String(text).split(/\r?\n/);
    var blocks = [];
    var currentList = null;

    function flushList() {
      if (currentList && currentList.items.length) {
        blocks.push(currentList);
      }
      currentList = null;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.indexOf('//') === 0) {
        flushList();
        continue;
      }
      var headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
      if (headingMatch) {
        flushList();
        blocks.push({
          type: 'heading',
          level: headingMatch[1].length,
          text: headingMatch[2].trim(),
        });
        continue;
      }
      var bulletMatch = line.match(/^[-*•]\s*(.*)$/);
      if (bulletMatch) {
        var itemText = bulletMatch[1].trim();
        if (itemText) {
          if (!currentList) currentList = { type: 'list', items: [] };
          currentList.items.push(itemText);
        }
        continue;
      }
      flushList();
      blocks.push({ type: 'paragraph', text: line });
    }
    flushList();
    return blocks;
  }

  /**
   * Returns true when [currentVersion] is non-empty and differs from [seenVersion].
   */
  function shouldShowWhatsNew(currentVersion, seenVersion) {
    var cur = String(currentVersion || '').trim();
    if (!cur) return false;
    var seen = String(seenVersion || '').trim();
    return seen !== cur;
  }

  var api = {
    SEEN_KEY: SEEN_KEY,
    parseInline: parseInline,
    parseWhatsNew: parseWhatsNew,
    shouldShowWhatsNew: shouldShowWhatsNew,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined' || !document.getElementById) return;

  var layer = document.getElementById('whatsnew-dialog-layer');
  var versionEl = document.getElementById('whatsnew-dialog-version');
  var listEl = document.getElementById('whatsnew-dialog-list');
  var okBtn = document.getElementById('whatsnew-dialog-ok');
  var isShowing = false;

  function appendInline(parent, text) {
    parseInline(text).forEach(function (tok) {
      if (tok.type === 'bold') {
        var strong = document.createElement('strong');
        strong.textContent = tok.text;
        parent.appendChild(strong);
      } else if (tok.type === 'italic') {
        var em = document.createElement('em');
        em.textContent = tok.text;
        parent.appendChild(em);
      } else if (tok.type === 'code') {
        var code = document.createElement('code');
        code.textContent = tok.text;
        parent.appendChild(code);
      } else {
        parent.appendChild(document.createTextNode(tok.text));
      }
    });
  }

  function close() {
    if (!layer || !isShowing) return false;
    layer.classList.add('hidden');
    isShowing = false;
    return true;
  }

  function open(blocks, version) {
    if (!layer || !listEl || !blocks || !blocks.length) return false;
    listEl.textContent = '';
    blocks.forEach(function (block) {
      if (block.type === 'heading') {
        var h = document.createElement(block.level === 1 ? 'h4' : 'h5');
        h.className = 'wn-heading wn-h' + block.level;
        appendInline(h, block.text);
        listEl.appendChild(h);
      } else if (block.type === 'list') {
        var ul = document.createElement('ul');
        ul.className = 'wn-ul';
        block.items.forEach(function (itemText) {
          var li = document.createElement('li');
          appendInline(li, itemText);
          ul.appendChild(li);
        });
        listEl.appendChild(ul);
      } else if (block.type === 'paragraph') {
        var p = document.createElement('p');
        p.className = 'wn-p';
        appendInline(p, block.text);
        listEl.appendChild(p);
      }
    });
    if (versionEl) {
      versionEl.textContent = version ? String(version) : '';
      versionEl.classList.toggle('hidden', !version);
    }
    layer.classList.remove('hidden');
    isShowing = true;
    if (okBtn && okBtn.focus) {
      try { okBtn.focus({ preventScroll: true }); } catch (e) {}
    }
    return true;
  }

  function isOpen() {
    return isShowing;
  }

  function markSeen(version) {
    try {
      if (typeof localStorage !== 'undefined' && version) {
        localStorage.setItem(SEEN_KEY, String(version));
      }
    } catch (e) { /* storage unavailable */ }
  }

  function checkAndShow() {
    var current = String(root.APP_VERSION || '').trim();
    var seen = '';
    try {
      if (typeof localStorage !== 'undefined') {
        seen = localStorage.getItem(SEEN_KEY) || '';
      }
    } catch (e) { seen = ''; }

    if (!shouldShowWhatsNew(current, seen)) return Promise.resolve(false);
    if (typeof fetch !== 'function') return Promise.resolve(false);

    return fetch('whats-new.txt?v=' + encodeURIComponent(current))
      .then(function (res) { return res && res.ok ? res.text() : ''; })
      .then(function (text) {
        var blocks = parseWhatsNew(text);
        if (!blocks.length) return false;
        // Prepend a dynamic "What's New in vX.XX.XX" heading using the live version.
        blocks.unshift({ type: 'heading', level: 1, text: "What\u2019s New in " + current });
        var opened = open(blocks, current);
        if (opened) markSeen(current);
        return opened;
      })
      .catch(function () { return false; });
  }

  if (okBtn) okBtn.addEventListener('click', close);
  if (layer) {
    layer.addEventListener('click', function (e) {
      if (e.target === layer) close();
    });
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isShowing) close();
  });

  root.WhatsNew = Object.assign({}, api, {
    open: open,
    close: close,
    isOpen: isOpen,
    checkAndShow: checkAndShow,
  });
})(typeof window !== 'undefined' ? window : this);
