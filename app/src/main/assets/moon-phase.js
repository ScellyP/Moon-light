/* Real moon phase for the Home screen's badge (moon-theme.js reads it).
   Copied from the reader app's moon-lock.js, which has the same two functions; the lock itself
   (puzzles, glass) is not part of this app. Low-precision sun/moon longitudes (Meeus-style,
   good to about a degree), so the badge shows the phase you would see in the sky. */
(function () {
  'use strict';
  const PHASE_NAMES = ['New Moon','Waxing Crescent','First Quarter','Waxing Gibbous','Full Moon','Waning Gibbous','Last Quarter','Waning Crescent'];
  function moonPhaseInfo(date) {
    const d = ((date ? date.getTime() : Date.now()) - Date.UTC(2000, 0, 1, 12)) / 86400000;
    const rad = Math.PI / 180, wrap = x => ((x % 360) + 360) % 360;
    const moonLon = 218.316 + 13.176396 * d + 6.289 * Math.sin(rad * wrap(134.963 + 13.064993 * d));
    const g = rad * wrap(357.528 + 0.9856003 * d);
    const sunLon = 280.460 + 0.9856474 * d + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g);
    const elongation = wrap(moonLon - sunLon);       // 0 new, 90 first quarter, 180 full, 270 last quarter
    const fraction = elongation / 360;                // 0..1 through the cycle
    const illumination = (1 - Math.cos(rad * elongation)) / 2;
    const index = Math.floor(fraction * 8 + 0.5) % 8;
    return {fraction, illumination, index, name: PHASE_NAMES[index], waxing: fraction < .5};
  }
  // Lit part of the moon for any point in the cycle (not just the 8 steps).
  function moonPhasePath(fraction, cx, cy, r) {
    const theta = 2 * Math.PI * fraction, c = Math.cos(theta), illum = (1 - c) / 2;
    if (illum < .015) return '';
    if (illum > .985) return `M ${cx-r} ${cy} A ${r} ${r} 0 1 1 ${cx+r} ${cy} A ${r} ${r} 0 1 1 ${cx-r} ${cy} Z`;
    const waxing = fraction < .5, top = `${cx} ${cy-r}`, bottom = `${cx} ${cy+r}`;
    const limbSweep = waxing ? 1 : 0, rx = r * Math.abs(c);
    const termSweep = waxing ? (c > 0 ? 0 : 1) : (c > 0 ? 1 : 0);
    const term = rx < .5 ? `L ${top}` : `A ${rx} ${r} 0 0 ${termSweep} ${top}`;
    return `M ${top} A ${r} ${r} 0 0 ${limbSweep} ${bottom} ${term} Z`;
  }
  var api = { moonPhaseInfo: moonPhaseInfo, moonPhasePath: moonPhasePath };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.NovelMoonLock = api; // the name moon-theme.js looks for
})();
