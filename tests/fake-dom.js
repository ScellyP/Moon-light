// A very small fake page for tests: elements with children, classes, attributes, events and text.
// Enough for the music panel scripts to build their screens and for a test to find and click things.
function createNode(tag) {
  const n = {
    tag, children: [], attrs: {}, listeners: {}, parent: null, _text: '', className: '', hidden: false, value: '', tabIndex: 0, disabled: false,
    style: { props: {}, setProperty(k, v) { this.props[k] = v; } },
    classList: {
      add: (c) => { const s = new Set(n.className.split(/\s+/).filter(Boolean)); s.add(c); n.className = [...s].join(' '); },
      remove: (c) => { n.className = n.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
      toggle: (c, f) => (f ? n.classList.add(c) : n.classList.remove(c)),
      contains: (c) => n.className.split(/\s+/).includes(c),
    },
    appendChild(c) { c.parent = n; n.children.push(c); return c; },
    replaceChildren(...cs) { n.children = []; cs.forEach((c) => n.appendChild(c)); },
    setAttribute(k, v) { n.attrs[k] = String(v); if (k === 'class') n.className = String(v); },
    getAttribute(k) { return k in n.attrs ? n.attrs[k] : null; },
    addEventListener(t, f) { (n.listeners[t] = n.listeners[t] || []).push(f); },
    focus() { n.focused = true; }, blur() { n.blurred = true; },
    setSelectionRange() {},
    matchesAttr(sel) { const m = /^\[([\w-]+)\]$/.exec(sel); return !!m && m[1] in n.attrs; },
    closest(sel) { for (let e = n; e; e = e.parent) if (e.matchesAttr(sel)) return e; return null; },
    querySelectorAll(sel) { const out = []; (function walk(e) { e.children.forEach((c) => { if (c.matchesAttr(sel)) out.push(c); walk(c); }); })(n); return out; },
    querySelector(sel) { return n.querySelectorAll(sel)[0] || null; },
    get textContent() { return n._text + n.children.map((c) => c.textContent).join(''); },
    set textContent(v) { n._text = String(v); n.children = []; },
  };
  return n;
}

// Every descendant of [root] that passes [pred].
function findAll(root, pred, out = []) { root.children.forEach((c) => { if (pred(c)) out.push(c); findAll(c, pred, out); }); return out; }
const hasClass = (cls) => (c) => c.classList.contains(cls);

// A click reaches the element and then its parents, unless a handler stops it (like the real thing).
function click(nd) {
  let stopped = false;
  const ev = { stopPropagation() { stopped = true; }, target: nd };
  for (let e = nd; e && !stopped; e = e.parent) (e.listeners.click || []).forEach((f) => f(ev));
}

module.exports = { createNode, findAll, hasClass, click };
