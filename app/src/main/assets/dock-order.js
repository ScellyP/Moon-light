/* ============================================================================
   Change dock order: Settings > Appearance > Dock order > Change
   ============================================================================
     window.DockOrder.open() / .close() / .isOpen()     close() = cancel (Back does this too)
     window.DockOrder.apply()                            applies the saved order (runs once at start-up)

   A pop-up lists every item of the bottom bar by name. Rows are dragged by their handle with the same
   code as the song editor (playlist-editor.js): fixed row height, so the position is index * ROW_H, the
   row follows the finger, the list scrolls itself near the edges. Nothing changes until Done: then the order is
   saved (NovelAudio.setSetting('dockOrder'), comma separated view names) and the bottom bar and the swipe
   order are rebuilt at once (SpotifyUI.setDockOrder). Cancel, the X, the dark area or Back throw the changes away.
   ========================================================================= */
(function (root) {
  'use strict';

  const doc = root.document;
  if (!doc) return;

  const ROW_H = 56;            // px, fixed (CSS .do-row): drag positions are index * ROW_H
  const SETTING = 'dockOrder';
  let layer = null, list = null;
  let ctx = null;              // { drag }
  let openBtn = null;

  const audio = () => root.NovelAudio || null;
  const ui = () => root.SpotifyUI || null;
  const nextFrame = (f) => (typeof root.requestAnimationFrame === 'function' ? root.requestAnimationFrame(f) : root.setTimeout(f, 16));

  /* ---- pure helpers (the tests run these) ---- */
  function parse(text) {
    return String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
  }
  function serialize(names) { return names.join(','); }

  /* ---- what the dock has now: name, label and icon are read from the bottom bar itself ---- */
  function readItems() {
    const out = [];
    const nav = doc.getElementById('sp-nav');
    if (!nav || !nav.querySelectorAll) return out;
    Array.prototype.forEach.call(nav.querySelectorAll('[data-sp-view]'), (btn) => {
      const use = btn.querySelector ? btn.querySelector('use') : null;
      const label = btn.querySelector ? btn.querySelector('span') : null;
      out.push({
        name: btn.getAttribute('data-sp-view'),
        label: label ? label.textContent : btn.getAttribute('data-sp-view'),
        icon: use ? (use.getAttribute('href') || '') : '',
      });
    });
    return out;
  }

  function el(tag, cls, text) {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function makeRow(item) {
    const row = el('div', 'do-row');
    row.setAttribute('role', 'listitem');
    row.setAttribute('data-name', item.name);
    const svg = doc.createElementNS ? doc.createElementNS('http://www.w3.org/2000/svg', 'svg') : el('svg');
    svg.setAttribute('class', 'ico do-ico');
    const use = doc.createElementNS ? doc.createElementNS('http://www.w3.org/2000/svg', 'use') : el('use');
    use.setAttribute('href', item.icon);
    svg.appendChild(use);
    row.appendChild(svg);
    row.appendChild(el('div', 'do-name', item.label));
    const grip = el('button', 'do-grip');
    grip.type = 'button';
    grip.setAttribute('aria-label', 'Drag to move: ' + item.label);
    const gs = doc.createElementNS ? doc.createElementNS('http://www.w3.org/2000/svg', 'svg') : el('svg');
    gs.setAttribute('class', 'ico');
    const gu = doc.createElementNS ? doc.createElementNS('http://www.w3.org/2000/svg', 'use') : el('use');
    gu.setAttribute('href', '#i-menu');
    gs.appendChild(gu);
    grip.appendChild(gs);
    grip.addEventListener('pointerdown', (e) => startDrag(row, e));
    row.appendChild(grip);
    return row;
  }

  function fill(items) {
    endDrag();
    list.textContent = '';
    items.forEach((item) => list.appendChild(makeRow(item)));
  }

  /* ---- dragging: the song editor's code, with this list's row height ---- */
  function startDrag(row, e) {
    if (!ctx || ctx.drag) return;
    if (e.preventDefault) e.preventDefault();
    const rows = Array.prototype.slice.call(list.children);
    const idx = rows.indexOf(row);
    if (idx < 0) return;
    const grip = e.currentTarget || e.target;
    try { if (grip && grip.setPointerCapture && e.pointerId !== undefined) grip.setPointerCapture(e.pointerId); } catch (err) { /* the move listeners below still work */ }
    const drag = { row: row, startIdx: idx, curIdx: idx, startY: e.clientY, startScroll: list.scrollTop, lastY: e.clientY, grip: grip, raf: 0 };
    ctx.drag = drag;
    row.classList.add('dragging');
    drag.move = (ev) => { drag.lastY = ev.clientY; follow(); };
    drag.up = () => endDrag();
    doc.addEventListener('pointermove', drag.move);
    doc.addEventListener('pointerup', drag.up);
    doc.addEventListener('pointercancel', drag.up);
    autoScroll();
  }

  // Puts the dragged row under the finger: the DOM position follows the finger in whole rows, the transform
  // covers the rest.
  function follow() {
    const d = ctx && ctx.drag;
    if (!d) return;
    const dy = (d.lastY - d.startY) + (list.scrollTop - d.startScroll);
    const count = list.children.length;
    const want = Math.max(0, Math.min(count - 1, d.startIdx + Math.round(dy / ROW_H)));
    if (want !== d.curIdx) {
      const rows = Array.prototype.slice.call(list.children);
      list.insertBefore(d.row, want > d.curIdx ? (rows[want + 1] || null) : rows[want]);
      d.curIdx = want;
    }
    d.row.style.transform = 'translateY(' + (dy - (d.curIdx - d.startIdx) * ROW_H) + 'px)';
  }

  function autoScroll() {
    const d = ctx && ctx.drag;
    if (!d) return;
    if (list.getBoundingClientRect) {
      const r = list.getBoundingClientRect();
      if (d.lastY < r.top + 60) list.scrollTop -= 12;
      else if (d.lastY > r.bottom - 60) list.scrollTop += 12;
      follow();
    }
    d.raf = nextFrame(autoScroll);
  }

  function endDrag() {
    const d = ctx && ctx.drag;
    if (!d) return;
    ctx.drag = null;
    doc.removeEventListener('pointermove', d.move);
    doc.removeEventListener('pointerup', d.up);
    doc.removeEventListener('pointercancel', d.up);
    if (d.raf && typeof root.cancelAnimationFrame === 'function') root.cancelAnimationFrame(d.raf);
    d.row.classList.remove('dragging');
    d.row.style.transform = '';
  }

  /* ---- open, apply, close ---- */
  function currentOrder() {
    return Array.prototype.map.call(list.children, (row) => row.getAttribute('data-name'));
  }

  function isOpen() { return !!(layer && !layer.classList.contains('hidden')); }

  function open() {
    if (!layer || !list) return false;
    ctx = { drag: null };
    fill(readItems());
    layer.classList.remove('hidden');
    return true;
  }

  function close() {
    if (!layer) return;
    endDrag();
    ctx = null;
    layer.classList.add('hidden');
  }

  function toast(message) {
    if (root.SongMenu && root.SongMenu.toast) root.SongMenu.toast(message);
  }

  // Done: save the order, then rebuild the bottom bar.
  function done() {
    if (!ctx) return;
    endDrag();
    const order = currentOrder();
    const a = audio();
    const u = ui();
    const before = u && u.getDockOrder ? u.getDockOrder().join(',') : '';
    const defaults = u && u.getDefaultDockOrder ? u.getDefaultDockOrder().join(',') : '';
    const text = serialize(order);
    if (a && a.setSetting) a.setSetting(SETTING, text === defaults ? '' : text);
    if (u && u.setDockOrder) u.setDockOrder(order);
    close();
    if (text !== before) toast('Dock order updated');
  }

  // Start-up: apply what was saved. An empty or damaged value leaves the default order.
  function apply() {
    const a = audio();
    const u = ui();
    if (!a || !a.getSetting || !u || !u.setDockOrder) return false;
    const saved = parse(a.getSetting(SETTING));
    if (!saved.length) return false;
    u.setDockOrder(saved);
    return true;
  }

  layer = doc.getElementById('dock-order-layer');
  list = doc.getElementById('dock-order-list');
  openBtn = doc.getElementById('dock-order-btn');
  if (layer && list) {
    const closeBtn = doc.getElementById('dock-order-close');
    const doneBtn = doc.getElementById('dock-order-done');
    const resetBtn = doc.getElementById('dock-order-reset');
    if (openBtn) openBtn.addEventListener('click', open);
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (doneBtn) doneBtn.addEventListener('click', done);
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        const u = ui();
        const defaults = u && u.getDefaultDockOrder ? u.getDefaultDockOrder() : [];
        const items = readItems();
        fill(defaults.map((n) => items.filter((i) => i.name === n)[0]).filter(Boolean));
      });
    }
    layer.addEventListener('click', (e) => { if (e.target === layer) close(); });
    doc.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close(); });
  }

  apply();

  root.DockOrder = { open: open, close: close, isOpen: isOpen, apply: apply, parse: parse, serialize: serialize };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.DockOrder;
})(typeof window !== 'undefined' ? window : this);
