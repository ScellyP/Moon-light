// Run with: node tests/theme-extraction.test.js
// Tests theme colour extraction and conversion (Item 5.1):
// - dominant colour extraction from cover art (including lighter colours, pastels, grey shades)
// - converting overly bright colours into darker, usable shades in dark theme
// - sleek monochromatic / slate palette for greyscale covers (no unwanted red tint)
// - WCAG contrast and readability of all generated theme CSS variables

const assert = require('assert');
global.document = { getElementById: () => null };
const {
  dominantRgb, computeTintVars, rgbToHsl, hslToRgb, luminance, toCssRgb
} = require('../app/src/main/assets/spotify-ui');

// Mock canvas & image for dominantRgb testing
function createMockCanvas(pixelGenerator, size = 32) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const [r, g, b, a = 255] = pixelGenerator(i % size, Math.floor(i / size), i);
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }
  const canvas = {
    width: size,
    height: size,
    getContext: () => ({
      drawImage: () => {},
      getImageData: () => ({ data }),
    }),
  };
  const mockDoc = {
    createElement: (tag) => (tag === 'canvas' ? canvas : {}),
  };
  return { canvas, mockDoc };
}

// Contrast ratio calculation per WCAG 2.1 specs
function contrastRatio(rgb1, rgb2) {
  const l1 = luminance(rgb1[0], rgb1[1], rgb1[2]);
  const l2 = luminance(rgb2[0], rgb2[1], rgb2[2]);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function parseCssRgb(cssStr) {
  const m = cssStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) throw new Error('Cannot parse CSS colour: ' + cssStr);
  return [+m[1], +m[2], +m[3]];
}

(() => {
  // 1. Basic colour maths round-tripping
  {
    const red = [255, 0, 0];
    const [h, s, l] = rgbToHsl(red[0], red[1], red[2]);
    assert.strictEqual(h, 0);
    assert.strictEqual(s, 1);
    assert.strictEqual(l, 0.5);
    const roundTrip = hslToRgb(h, s, l);
    assert.deepStrictEqual(roundTrip, red);
    console.log('ok - rgbToHsl and hslToRgb round-trip correctly');
  }

  // 2. Dominant colour extraction: Saturated chromatic cover (e.g. Royal Blue)
  {
    const { mockDoc } = createMockCanvas(() => [30, 80, 220, 255]);
    const extracted = dominantRgb({}, mockDoc);
    assert.ok(extracted, 'extracted colour should not be null');
    assert.ok(extracted[2] > 200 && extracted[0] < 50, 'extracted blue dominance');
    console.log('ok - vibrant chromatic cover correctly extracted');
  }

  // 3. Dominant colour extraction: Lighter colour / pastel cover (e.g. pastel yellow / cream)
  {
    // High lightness, moderate saturation (e.g. pastel yellow [245, 235, 160])
    const { mockDoc } = createMockCanvas(() => [245, 235, 160, 255]);
    const extracted = dominantRgb({}, mockDoc);
    assert.ok(extracted, 'lighter pastel colour must not be rejected with null');
    const [h, s, l] = rgbToHsl(extracted[0], extracted[1], extracted[2]);
    assert.ok(l > 0.7, 'retains high lightness of pastel cover');
    assert.ok(h >= 0.12 && h <= 0.18, 'retains warm yellow hue');
    console.log('ok - lighter pastel colours are not ignored or rejected');
  }

  // 4. Dominant colour extraction: Greyscale / monochrome / silver cover
  {
    // Pure neutral grey [180, 180, 180]
    const { mockDoc } = createMockCanvas(() => [180, 180, 180, 255]);
    const extracted = dominantRgb({}, mockDoc);
    assert.ok(extracted, 'greyscale cover must not be rejected with null');
    assert.strictEqual(Math.round(extracted[0]), 180);
    assert.strictEqual(Math.round(extracted[1]), 180);
    assert.strictEqual(Math.round(extracted[2]), 180);
    console.log('ok - greyscale and monochrome covers return accurate neutral shade instead of null');
  }

  // 5. Dominant colour extraction: Black-and-white high-contrast cover
  {
    // Half black [20, 20, 20], half white [240, 240, 240]
    const { mockDoc } = createMockCanvas((x, y, i) => (i % 2 === 0 ? [20, 20, 20, 255] : [240, 240, 240, 255]));
    const extracted = dominantRgb({}, mockDoc);
    assert.ok(extracted, 'high contrast B&W cover must not be null');
    assert.ok(extracted[0] >= 120 && extracted[0] <= 140, 'averages to neutral mid-tone');
    console.log('ok - black-and-white cover correctly handled without rejection');
  }

  // 6. Dominant colour extraction: 100% transparent cover -> returns null
  {
    const { mockDoc } = createMockCanvas(() => [0, 0, 0, 0]);
    const extracted = dominantRgb({}, mockDoc);
    assert.strictEqual(extracted, null, 'completely transparent cover returns null');
    console.log('ok - transparent cover safely returns null');
  }

  // 7. Theme generation (Dark Theme): Overly bright yellow converted to darker, usable amber
  {
    const brightYellow = [255, 238, 100]; // lightness ~0.70, hue ~0.14
    const vars = computeTintVars(brightYellow, true);
    assert.ok(vars, 'tintVars generated');

    const accentRgb = parseCssRgb(vars['--accent']);
    const bgRgb = parseCssRgb(vars['--bg']);
    const textRgb = parseCssRgb(vars['--text']);
    const mutedRgb = parseCssRgb(vars['--muted']);
    const inkRgb = parseCssRgb(vars['--accent-ink']);

    const [accH, accS, accL] = rgbToHsl(accentRgb[0], accentRgb[1], accentRgb[2]);
    // Overly bright yellow must be converted to a darker, usable shade
    assert.ok(accL <= 0.58, 'accent lightness is converted to darker usable range (<= 0.58), was ' + accL);
    assert.ok(accL >= 0.45, 'accent lightness is usable and visible (>= 0.45), was ' + accL);

    // Contrast checks
    const textBgContrast = contrastRatio(textRgb, bgRgb);
    assert.ok(textBgContrast >= 7.0, 'text on background WCAG AAA contrast (>= 7:1), was ' + textBgContrast.toFixed(2));

    const mutedBgContrast = contrastRatio(mutedRgb, bgRgb);
    assert.ok(mutedBgContrast >= 4.5, 'muted on background WCAG AA contrast (>= 4.5:1), was ' + mutedBgContrast.toFixed(2));

    const inkAccContrast = contrastRatio(inkRgb, accentRgb);
    assert.ok(inkAccContrast >= 4.5, 'accent-ink on accent contrast (>= 4.5:1), was ' + inkAccContrast.toFixed(2));

    console.log('ok - overly bright yellow converted to rich, darker usable shade with AAA readability');
  }

  // 8. Theme generation (Dark Theme): Overly bright sky blue / pastel cyan
  {
    const skyBlue = [160, 225, 255]; // lightness ~0.81, hue ~0.55
    const vars = computeTintVars(skyBlue, true);

    const accentRgb = parseCssRgb(vars['--accent']);
    const bgRgb = parseCssRgb(vars['--bg']);
    const textRgb = parseCssRgb(vars['--text']);

    const [accH, accS, accL] = rgbToHsl(accentRgb[0], accentRgb[1], accentRgb[2]);
    assert.ok(accL <= 0.62, 'sky blue converted to darker usable shade (<= 0.62), was ' + accL);
    assert.ok(accL >= 0.50, 'accent is vivid and legible (>= 0.50), was ' + accL);

    const textBgContrast = contrastRatio(textRgb, bgRgb);
    assert.ok(textBgContrast >= 7.0, 'text on bg >= 7:1, was ' + textBgContrast.toFixed(2));

    console.log('ok - overly bright sky blue converted to darker usable sapphire shade');
  }

  // 9. Theme generation (Dark Theme): Greyscale / silver cover produces sleek slate/silver palette (NO RED)
  {
    const grey = [180, 180, 180];
    const vars = computeTintVars(grey, true);

    const bgRgb = parseCssRgb(vars['--bg']);
    const accentRgb = parseCssRgb(vars['--accent']);
    const textRgb = parseCssRgb(vars['--text']);

    const [bgH, bgS, bgL] = rgbToHsl(bgRgb[0], bgRgb[1], bgRgb[2]);
    const [accH, accS, accL] = rgbToHsl(accentRgb[0], accentRgb[1], accentRgb[2]);

    // Must NOT be turned into red! Saturation must remain low/neutral
    assert.ok(bgS <= 0.12, 'background does not have forced red saturation, was ' + bgS);
    assert.ok(accS <= 0.15, 'accent retains neutral silver/slate character, was ' + accS);
    assert.ok(accL >= 0.70, 'silver accent is crisp and light against dark bg, was ' + accL);

    const textBgContrast = contrastRatio(textRgb, bgRgb);
    assert.ok(textBgContrast >= 7.0, 'text on neutral bg >= 7:1, was ' + textBgContrast.toFixed(2));

    const accBgContrast = contrastRatio(accentRgb, bgRgb);
    assert.ok(accBgContrast >= 4.5, 'silver accent on dark bg >= 4.5:1, was ' + accBgContrast.toFixed(2));

    console.log('ok - greyscale cover generates sleek silver/slate theme with NO unwanted red tint');
  }

  // 10. Theme generation (Light Theme): Produces clean light surface with dark text
  {
    const royalBlue = [40, 100, 220];
    const vars = computeTintVars(royalBlue, false);

    const bgRgb = parseCssRgb(vars['--bg']);
    const textRgb = parseCssRgb(vars['--text']);
    const accentRgb = parseCssRgb(vars['--accent']);

    const [, , bgL] = rgbToHsl(bgRgb[0], bgRgb[1], bgRgb[2]);
    const [, , textL] = rgbToHsl(textRgb[0], textRgb[1], textRgb[2]);

    assert.ok(bgL >= 0.90, 'light theme background is light (>= 0.90), was ' + bgL);
    assert.ok(textL <= 0.20, 'light theme text is dark (<= 0.20), was ' + textL);

    const textBgContrast = contrastRatio(textRgb, bgRgb);
    assert.ok(textBgContrast >= 7.0, 'light theme text contrast >= 7:1, was ' + textBgContrast.toFixed(2));

    console.log('ok - light theme generates clean light surface with dark high-contrast text');
  }

  // 11. All 8 CSS tint variables are present in every generated theme
  {
    const vars = computeTintVars([120, 200, 80], true);
    const expected = [
      '--bg', '--text', '--muted', '--accent', '--accent-strong', '--accent-ink', '--accent-soft', '--accent-line'
    ];
    for (const key of expected) {
      assert.ok(vars[key], 'variable ' + key + ' is present in generated vars');
    }
    console.log('ok - all 8 theme CSS variables are consistently populated');
  }

  console.log('\nAll 11 theme colour extraction checks passed cleanly!');
})();
