/* =========================================================================
   Moonlight — the Settings menu (a drawer that slides in from the left).

   Open it by swiping right on Home (or tapping the sliders button in the top bar); close it by
   swiping left, tapping the dark area, tapping the X, or pressing Back.

   The gesture follows the usual drawer recipe (the same one use-gesture, Vaul and Android's
   DrawerLayout use), nothing new invented:
     1. Pointer Events, with `touch-action: pan-y` on the swipe area, so the browser keeps vertical
        scrolling to itself and hands us the sideways moves.
     2. Wait for a small "slop" (10 px) and lock to the horizontal axis only when the move is clearly
        sideways, so scrolling the page and dragging sliders keep working.
     3. While the finger is down, the drawer follows it 1:1. Only `transform` (drawer) and `opacity`
        (dark scrim) change, written once per animation frame, so the GPU does the work.
     4. On release the settle direction comes from the FLICK VELOCITY over the last ~100 ms; with no
        flick it goes to whichever side is nearer (past half-way = open). The settle is a CSS
        transition whose length follows the remaining distance and speed, so a quick flick snaps and
        a slow drag eases.
     5. Grabbing the drawer while it is still settling picks it up where it is (no jump).

   The switches (Bluetooth start, twinkling stars, cover colours) are stored by audio-player.js
   (NovelAudio.getSetting / setSetting). Crossfade, Normalise and the update controls live in this
   menu's markup too; their own scripts find them by id.
   ========================================================================= */
(function (root) {
  'use strict';

  /* ---- Pure helpers (no DOM; the tests run these) ---- */
  var SLOP = 10;              // px of movement before we decide what the gesture is
  var AXIS_RATIO = 1.3;       // |dx| must beat |dy| by this much to count as sideways
  var FLICK = 0.3;            // px per ms: faster than this and the direction of the flick decides
  var VELOCITY_WINDOW = 100;  // ms of recent movement used for the velocity
  var SCRIM_MAX = 0.6;        // how dark the scrim gets when fully open
  var EASE = 'cubic-bezier(.22, 1, .36, 1)';   // fast start, soft landing

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* samples: [{x, t}] in time order. Velocity in px/ms over the last `windowMs` (positive = rightwards). */
  function velocityOf(samples, windowMs) {
    if (!samples || samples.length < 2) return 0;
    var last = samples[samples.length - 1];
    var first = samples[0];
    for (var i = samples.length - 2; i >= 0; i--) {
      if (last.t - samples[i].t > (windowMs || VELOCITY_WINDOW)) break;
      first = samples[i];
    }
    var dt = last.t - first.t;
    return dt > 0 ? (last.x - first.x) / dt : 0;
  }

  /* Which way a finger that is still undecided is going: 'x' (sideways), 'y' (vertical) or null (not far enough yet). */
  function lockAxis(dx, dy) {
    var ax = Math.abs(dx), ay = Math.abs(dy);
    if (ax < SLOP && ay < SLOP) return null;
    return ax > ay * AXIS_RATIO ? 'x' : 'y';
  }

  /* After the finger lifts: should the drawer end up open? A real flick decides by its direction,
     otherwise past half-way means open. */
  function shouldOpen(progress, velocity) {
    if (Math.abs(velocity) >= FLICK) return velocity > 0;
    return progress >= 0.5;
  }

  /* How long (ms) the settle animation takes: the remaining distance at the release speed, kept
     between 140 and 380 ms so it never feels abrupt or lazy. */
  function settleMs(remainingPx, velocity) {
    var speed = Math.max(Math.abs(velocity), 0.9);   // px/ms; a slow release still moves at a steady pace
    return Math.round(clamp(Math.abs(remainingPx) / speed, 140, 380));
  }

  var api = {
    velocityOf: velocityOf, lockAxis: lockAxis, shouldOpen: shouldOpen, settleMs: settleMs,
    SLOP: SLOP, FLICK: FLICK, SCRIM_MAX: SCRIM_MAX,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined') return;

  /* ---- The page half ---- */
  var layer = document.getElementById('settings-layer');
  var drawer = document.getElementById('settings-drawer');
  var scrim = document.getElementById('settings-scrim');
  var openBtn = document.getElementById('settings-btn');
  var closeBtn = document.getElementById('settings-close');
  var panel = document.getElementById('audio-panel');
  var home = document.getElementById('sp-view-library');
  if (!layer || !drawer || !scrim || !panel) return;

  var progress = 0;        // 0 = closed, 1 = open
  var settled = false;     // true once the drawer is fully open
  var closeTimer = null;
  var frame = 0, pendingProgress = null;

  var g = null;            // the gesture in progress: {id, x0, y0, baseX, baseP, W, fromOpen, mode, samples, onScrim}

  function setProgress(p) {
    progress = clamp(p, 0, 1);
    drawer.style.transform = 'translate3d(' + ((progress - 1) * 100).toFixed(3) + '%,0,0)';
    scrim.style.opacity = (progress * SCRIM_MAX).toFixed(3);
  }

  // One write per animation frame, however many pointer events arrive.
  function queueProgress(p) {
    pendingProgress = p;
    if (frame) return;
    frame = requestAnimationFrame(function () {
      frame = 0;
      if (pendingProgress !== null) setProgress(pendingProgress);
      pendingProgress = null;
    });
  }
  function flushProgress() {
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    if (pendingProgress !== null) { setProgress(pendingProgress); pendingProgress = null; }
  }

  function setTransition(ms) {
    var t = ms > 0 ? ms + 'ms ' + EASE : 'none';
    drawer.style.transition = ms > 0 ? 'transform ' + t : 'none';
    scrim.style.transition = ms > 0 ? 'opacity ' + t : 'none';
  }

  function show() {
    clearTimeout(closeTimer);
    layer.classList.add('is-open');
    layer.setAttribute('aria-hidden', 'false');
    drawer.removeAttribute('inert');
    document.body.classList.add('settings-open');
  }
  function hide() {
    layer.classList.remove('is-open');
    layer.setAttribute('aria-hidden', 'true');
    drawer.setAttribute('inert', '');
    document.body.classList.remove('settings-open');
  }

  /* Animate to open (1) or closed (0). velocity: px/ms of the release (0 for a tap). */
  function settleTo(target, velocity) {
    flushProgress();
    var W = drawer.offsetWidth || 320;
    var ms = settleMs((target - progress) * W, velocity || 0);
    if (target === 1) show();
    setTransition(ms);
    // Two frames: make sure the "from" transform is committed before the transition starts.
    requestAnimationFrame(function () {
      setProgress(target);
    });
    clearTimeout(closeTimer);
    closeTimer = setTimeout(function () {
      setTransition(0);
      settled = target === 1;
      if (target === 0) hide();
      else if (closeBtn) closeBtn.focus({ preventScroll: true });
    }, ms + 40);
  }

  function open() { if (progress < 1 || !settled) settleTo(1, 0); }
  function close() { if (progress > 0 || layer.classList.contains('is-open')) { settled = false; settleTo(0, 0); } }
  function isOpen() { return layer.classList.contains('is-open') && progress > 0; }

  /* ---- gesture ---- */
  function ownsHorizontalDrag(target) {
    for (var el = target; el && el !== document.body; el = el.parentElement) {
      if (el.matches && el.matches('input, textarea, select')) return true;
      if (el.scrollWidth > el.clientWidth + 1) {
        var ox = getComputedStyle(el).overflowX;
        if (ox === 'auto' || ox === 'scroll') return true;   // e.g. the Made for you shelf scrolls itself
      }
    }
    return false;
  }

  function onDown(e, fromOpen) {
    if (g || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (!fromOpen && (panel.getAttribute('data-view') !== 'library' || isOpen())) return;
    if (ownsHorizontalDrag(e.target)) return;
    // Picking the drawer up while it is still settling: start from where it is.
    var p = progress;
    if (layer.classList.contains('is-open')) {
      var rect = drawer.getBoundingClientRect();
      var w = drawer.offsetWidth || 320;
      p = clamp(rect.left / w + 1, 0, 1);
    }
    g = {
      id: e.pointerId, x0: e.clientX, y0: e.clientY, baseX: e.clientX, baseP: p,
      W: drawer.offsetWidth || 320, fromOpen: fromOpen || p > 0, mode: 'pending',
      samples: [{ x: e.clientX, t: e.timeStamp }], onScrim: e.target === scrim,
    };
  }

  function onMove(e) {
    if (!g || e.pointerId !== g.id) return;
    g.samples.push({ x: e.clientX, t: e.timeStamp });
    if (g.samples.length > 12) g.samples.shift();
    var dx = e.clientX - g.x0, dy = e.clientY - g.y0;

    if (g.mode === 'pending') {
      var axis = lockAxis(dx, dy);
      if (axis === null) return;
      // Closed: only a rightward sideways move opens it. Open: only a leftward one closes it.
      var wanted = g.fromOpen ? dx < 0 : dx > 0;
      if (axis !== 'x' || !wanted) { g = null; return; }   // vertical scroll, or the wrong way: not ours
      g.mode = 'drag';
      g.baseX = e.clientX;                     // continue from here, so there is no jump
      clearTimeout(closeTimer);
      setTransition(0);
      show();
    }
    if (g.mode === 'drag') {
      queueProgress(g.baseP + (e.clientX - g.baseX) / g.W);
    }
  }

  function onUp(e) {
    if (!g || e.pointerId !== g.id) return;
    var gesture = g;
    g = null;
    if (gesture.mode === 'drag') {
      var v = velocityOf(gesture.samples, VELOCITY_WINDOW);
      var target = shouldOpen(clamp(pendingProgress !== null ? pendingProgress : progress, 0, 1), v) ? 1 : 0;
      if (target === 0) settled = false;
      settleTo(target, v);
    } else if (gesture.onScrim && gesture.mode === 'pending') {
      close();                                  // a tap on the dark area
    }
  }

  function onCancel(e) {
    if (!g || e.pointerId !== g.id) return;
    var gesture = g;
    g = null;
    if (gesture.mode === 'drag') settleTo(progress >= 0.5 ? 1 : 0, 0);
  }

  var swipeArea = home || panel;
  swipeArea.addEventListener('pointerdown', function (e) { onDown(e, false); }, { passive: true });
  layer.addEventListener('pointerdown', function (e) { onDown(e, true); }, { passive: true });
  document.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerup', onUp, { passive: true });
  document.addEventListener('pointercancel', onCancel, { passive: true });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && isOpen()) close(); });

  if (openBtn) openBtn.addEventListener('click', open);
  if (closeBtn) closeBtn.addEventListener('click', close);

  /* ---- the switches ---- */
  function audio() { return root.NovelAudio || null; }
  function bindSwitch(id, name, apply) {
    var box = document.getElementById(id);
    if (!box) return;
    var a = audio();
    var value = a && a.getSetting ? a.getSetting(name) : undefined;
    box.checked = value === undefined ? true : !!value;
    if (apply) apply(box.checked);
    box.addEventListener('change', function () {
      var b = audio();
      if (b && b.setSetting) b.setSetting(name, !!box.checked);
      if (apply) apply(!!box.checked);
    });
  }
  bindSwitch('set-bt', 'btAutoStart', null);
  bindSwitch('set-sky', 'animatedSky', function (on) { document.body.classList.toggle('no-sky-motion', !on); });
  bindSwitch('set-tint', 'coverTint', function () {
    if (root.SpotifyUI && root.SpotifyUI.refreshTint) root.SpotifyUI.refreshTint();
  });

  setProgress(0);
  root.SettingsMenu = { open: open, close: close, isOpen: isOpen };
})(typeof window !== 'undefined' ? window : this);
