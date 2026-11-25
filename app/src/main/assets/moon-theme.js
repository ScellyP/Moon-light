/* Moon & space theme glue:
   1. Fills every [data-moon] badge with today's real moon phase.
   2. Generates randomized star patterns so the starfield avoids predictable repetition.
   3. Spawns occasional natural comets drifting across the sky background.
   4. Halts all visual effect loops/timers when disabled in Settings or when hidden. */
(function (root) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';

  /* ---- Moon phase rendering ---- */
  const MOON_CHECK_INTERVAL_MS = 3600000;
  const MOON_CHECK_STORAGE_KEY = 'moonlight.lastMoonPhaseCheckAt';

  function paintMoonBadges() {
    const ml = (typeof window !== 'undefined' ? window.NovelMoonLock : null) || (typeof global !== 'undefined' ? global.NovelMoonLock : null) || root.NovelMoonLock;
    if (!ml || !ml.moonPhaseInfo || !ml.moonPhasePath || typeof document === 'undefined') return;
    const phase = ml.moonPhaseInfo(new Date());
    const label = phase.name;
    const tilt = (-10 + 20 * (typeof phase.fraction === 'number' ? phase.fraction : 0)).toFixed(1);
    document.querySelectorAll('[data-moon-label]').forEach(function (el) { el.textContent = label; });
    document.querySelectorAll('[data-moon]').forEach(function (el) {
      el.textContent = '';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('shape-rendering', 'geometricPrecision');
      if (svg.style) svg.style.transform = 'rotate(' + tilt + 'deg)';
      const disc = document.createElementNS(NS, 'circle');
      disc.setAttribute('cx', '12'); disc.setAttribute('cy', '12'); disc.setAttribute('r', '12');
      disc.setAttribute('fill', 'currentColor'); disc.setAttribute('fill-opacity', '.14');
      const lit = document.createElementNS(NS, 'path');
      lit.setAttribute('d', ml.moonPhasePath(phase.fraction, 12, 12, 12));
      lit.setAttribute('fill', 'currentColor');
      svg.appendChild(disc); svg.appendChild(lit);
      el.appendChild(svg);
      el.setAttribute('title', label);
      el.setAttribute('role', 'img');
      el.setAttribute('aria-label', label);
    });
  }

  function createMoonPhaseScheduler(opts) {
    const o = opts || {};
    const fnSetInterval = o.setInterval || setInterval;
    const fnClearInterval = o.clearInterval || clearInterval;
    const fnNow = o.now || (() => Date.now());
    const fnPaint = o.onPaint || paintMoonBadges;
    const isHidden = o.isHidden || (() => (typeof document !== 'undefined' ? (!!document.hidden || document.visibilityState === 'hidden') : false));
    const storage = o.storage !== undefined ? o.storage : (typeof localStorage !== 'undefined' ? localStorage : null);

    let lastMoonPhaseCheckAt = 0;
    let timer = null;

    function readStoredTimestamp() {
      if (!storage || !storage.getItem) return 0;
      try {
        const parsed = Number(storage.getItem(MOON_CHECK_STORAGE_KEY));
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
      } catch (e) {
        return 0;
      }
    }

    function saveTimestamp(ts) {
      lastMoonPhaseCheckAt = ts;
      if (!storage || !storage.setItem) return;
      try {
        storage.setItem(MOON_CHECK_STORAGE_KEY, String(ts));
      } catch (e) {}
    }

    function checkAndPaint(forceInitial) {
      if (!lastMoonPhaseCheckAt) lastMoonPhaseCheckAt = readStoredTimestamp();
      const current = fnNow();
      const elapsed = current - lastMoonPhaseCheckAt;
      if (!lastMoonPhaseCheckAt || elapsed < 0 || elapsed >= MOON_CHECK_INTERVAL_MS) {
        fnPaint();
        saveTimestamp(current);
        return true;
      }
      if (forceInitial) {
        fnPaint();
        return true;
      }
      return false;
    }

    function stopTimer() {
      if (timer !== null) {
        fnClearInterval(timer);
        timer = null;
      }
    }

    function startTimer() {
      if (timer !== null || isHidden()) return;
      timer = fnSetInterval(function () {
        if (!isHidden()) checkAndPaint(false);
      }, MOON_CHECK_INTERVAL_MS);
    }

    function onVisibilityChange() {
      if (!isHidden()) {
        checkAndPaint(false);
        startTimer();
      } else {
        stopTimer();
      }
    }

    function init() {
      checkAndPaint(true);
      if (!isHidden()) startTimer();
    }

    return {
      init,
      checkAndPaint,
      startTimer,
      stopTimer,
      onVisibilityChange,
      getLastCheckAt: () => lastMoonPhaseCheckAt,
    };
  }

  /* ---- 6.1 Random star pattern generation ---- */
  function generateStarGradient(count, minRadius, maxRadius) {
    const stars = [];
    for (let i = 0; i < count; i++) {
      const x = (Math.random() * 96 + 2).toFixed(1);
      const y = (Math.random() * 96 + 2).toFixed(1);
      const r = (minRadius + Math.random() * (maxRadius - minRadius)).toFixed(1);
      const fade = (parseFloat(r) + 0.7).toFixed(1);
      stars.push(`radial-gradient(circle at ${x}% ${y}%, var(--text) 0, var(--text) ${r}px, transparent ${fade}px)`);
    }
    return stars.join(',');
  }

  function generateSkyLayers() {
    return {
      layer1: generateStarGradient(30, 0.6, 1.1),
      layer2: generateStarGradient(18, 1.1, 1.7),
    };
  }

  function applyRandomStars() {
    if (typeof document === 'undefined') return;
    const layers = generateSkyLayers();
    document.querySelectorAll('.sky').forEach((sky) => {
      sky.style.setProperty('--sky-stars-1', layers.layer1);
      sky.style.setProperty('--sky-stars-2', layers.layer2);
    });
  }

  /* ---- 6.2 Random comets ---- */
  function generateCometParams() {
    return {
      startX: 45 + Math.random() * 50,       // 45% to 95%
      startY: 2 + Math.random() * 25,        // 2% to 27%
      angle: -30 - Math.random() * 14,       // -30deg to -44deg
      length: 80 + Math.random() * 70,       // 80px to 150px
      duration: 1100 + Math.random() * 700,  // 1.1s to 1.8s
      travelX: -260 - Math.random() * 140,   // moves -260px to -400px
      travelY: 160 + Math.random() * 110,    // moves 160px to 270px
    };
  }

  function createCometManager(opts) {
    const o = opts || {};
    const fnSetTimeout = o.setTimeout || setTimeout;
    const fnClearTimeout = o.clearTimeout || clearTimeout;
    const isEnabled = o.isEnabled || (() => {
      const a = root.NovelAudio || (typeof window !== 'undefined' ? window.NovelAudio : null);
      if (a && a.getSetting) return a.getSetting('randomComets') !== false;
      return true;
    });
    const isHidden = o.isHidden || (() => (typeof document !== 'undefined' ? document.hidden : false));

    let timer = null;
    let currentElement = null;

    function stop() {
      fnClearTimeout(timer);
      timer = null;
      if (currentElement && currentElement.parentNode) {
        currentElement.parentNode.removeChild(currentElement);
        currentElement = null;
      }
    }

    function schedule() {
      fnClearTimeout(timer);
      timer = null;
      if (!isEnabled() || isHidden()) return;
      const delay = 8000 + Math.random() * 14000; // 8s to 22s
      timer = fnSetTimeout(spawn, delay);
    }

    function spawn() {
      timer = null;
      if (!isEnabled() || isHidden() || typeof document === 'undefined') return;

      const sky = document.querySelector('.sky');
      if (!sky) { schedule(); return; }

      const p = generateCometParams();
      const comet = document.createElement('div');
      comet.className = 'comet';
      comet.setAttribute('aria-hidden', 'true');
      comet.style.cssText =
        'position: absolute;' +
        'top:' + p.startY.toFixed(1) + '%;' +
        'left:' + p.startX.toFixed(1) + '%;' +
        'width:' + p.length.toFixed(0) + 'px;' +
        'height: 1.5px;' +
        'border-radius: 99px;' +
        'pointer-events: none;' +
        'z-index: 0;' +
        'opacity: 0;' +
        'transform: translate3d(0, 0, 0) rotate(' + p.angle.toFixed(1) + 'deg);' +
        'background: linear-gradient(270deg, transparent, color-mix(in srgb, var(--text) 88%, var(--accent)));' +
        'box-shadow: 0 0 6px var(--accent-line, rgba(255,255,255,0.4));' +
        'transition: transform ' + p.duration.toFixed(0) + 'ms cubic-bezier(0.25, 0.1, 0.25, 1), opacity ' + p.duration.toFixed(0) + 'ms ease-out;';

      sky.appendChild(comet);
      currentElement = comet;

      if (typeof requestAnimationFrame !== 'undefined') {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (!comet.parentNode) return;
            comet.style.opacity = '0.9';
            comet.style.transform =
              'translate3d(' + p.travelX.toFixed(0) + 'px, ' + p.travelY.toFixed(0) + 'px, 0) rotate(' + p.angle.toFixed(1) + 'deg)';

            fnSetTimeout(() => {
              if (comet.parentNode) comet.style.opacity = '0';
            }, p.duration * 0.65);

            fnSetTimeout(() => {
              if (comet.parentNode) comet.parentNode.removeChild(comet);
              if (currentElement === comet) currentElement = null;
              schedule();
            }, p.duration + 60);
          });
        });
      }
    }

    return { schedule, stop, spawn };
  }

  const cometManager = createCometManager();
  const moonPhaseScheduler = createMoonPhaseScheduler();

  const api = {
    MOON_CHECK_INTERVAL_MS,
    paintMoonBadges,
    createMoonPhaseScheduler,
    generateStarGradient,
    generateSkyLayers,
    applyRandomStars,
    generateCometParams,
    createCometManager,
    updateStars: function (enabled) {
      if (typeof document !== 'undefined') {
        document.body.classList.toggle('no-stars', !enabled);
        if (enabled) applyRandomStars();
      }
    },
    updateComets: function (enabled) {
      if (typeof document !== 'undefined') {
        document.body.classList.toggle('no-comets', !enabled);
      }
      if (enabled) cometManager.schedule();
      else cometManager.stop();
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.MoonSky = api;
    if (typeof document !== 'undefined') {
      moonPhaseScheduler.init();
      applyRandomStars();
      cometManager.schedule();
      document.addEventListener('visibilitychange', function () {
        moonPhaseScheduler.onVisibilityChange();
        if (!document.hidden && document.visibilityState !== 'hidden') {
          cometManager.schedule();
        } else {
          cometManager.stop();
        }
      });
    }
  }
})(typeof window !== 'undefined' ? window : this);
