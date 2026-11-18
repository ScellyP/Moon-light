// Run with: node tests/moon-sky.test.js
// Tests random star generation, random comets, and background visual settings (Item 6):
// - 6.1 Random star generation (varied, unpredictable star positions and patterns)
// - 6.2 Random comets (occasional natural comets across the background)
// - 6.3 Settings controls (star pattern and random comets switches halt work when off)

const assert = require('assert');
global.document = {
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener: () => {},
  visibilityState: 'visible',
};

const MoonSky = require('../app/src/main/assets/moon-theme');

(() => {
  // 1. Random star pattern generation: generates valid CSS radial gradient strings
  {
    const gradient = MoonSky.generateStarGradient(20, 0.6, 1.2);
    assert.ok(typeof gradient === 'string', 'gradient is a string');
    assert.ok(gradient.includes('radial-gradient('), 'contains radial gradients');
    const matches = gradient.match(/radial-gradient\(/g);
    assert.strictEqual(matches.length, 20, 'generates exactly requested count of stars');
    console.log('ok - generateStarGradient generates valid radial gradients');
  }

  // 2. Varied and randomized star positions: successive calls produce different patterns
  {
    const g1 = MoonSky.generateStarGradient(25, 0.6, 1.5);
    const g2 = MoonSky.generateStarGradient(25, 0.6, 1.5);
    assert.notStrictEqual(g1, g2, 'successive generations produce varied, non-identical star layouts');
    console.log('ok - star generation is truly random and avoids predictable static positions');
  }

  // 3. Star layer generator produces two distinct layers
  {
    const layers = MoonSky.generateSkyLayers();
    assert.ok(layers.layer1 && layers.layer2, 'returns both layer1 and layer2');
    assert.notStrictEqual(layers.layer1, layers.layer2, 'layer 1 and layer 2 have different star arrangements');
    assert.ok(layers.layer1.split('radial-gradient').length > 15, 'layer 1 has ample distant stars');
    assert.ok(layers.layer2.split('radial-gradient').length > 10, 'layer 2 has brighter nearer stars');
    console.log('ok - generates two rich distinct starfield layers');
  }

  // 4. Comet parameter generation: realistic angles, lengths, trajectories
  {
    const p = MoonSky.generateCometParams();
    assert.ok(p.startX >= 40 && p.startX <= 100, 'comet startX in upper right (40..100%), was ' + p.startX);
    assert.ok(p.startY >= 0 && p.startY <= 40, 'comet startY near top (0..40%), was ' + p.startY);
    assert.ok(p.angle < 0 && p.angle >= -60, 'comet angle moves diagonally down-left, was ' + p.angle);
    assert.ok(p.duration >= 900 && p.duration <= 2500, 'duration is smooth (0.9s to 2.5s), was ' + p.duration);
    console.log('ok - comet trajectories and angles are natural and randomized');
  }

  // 5. Comet scheduler: respects enabled / disabled state
  {
    let active = true;
    let timerSet = false;
    let cleared = false;
    const fakeSetTimeout = (fn, ms) => {
      timerSet = true;
      return 123;
    };
    const fakeClearTimeout = (id) => {
      cleared = true;
    };

    const manager = MoonSky.createCometManager({
      setTimeout: fakeSetTimeout,
      clearTimeout: fakeClearTimeout,
      isEnabled: () => active,
      isHidden: () => false,
    });

    manager.schedule();
    assert.strictEqual(timerSet, true, 'timer scheduled when comets enabled');

    active = false;
    manager.stop();
    assert.strictEqual(cleared, true, 'timer cleared when comets stopped');
    console.log('ok - comet scheduler starts and stops cleanly based on enabled state');
  }

  // 6. When comets are disabled, scheduling is prevented
  {
    let timerSet = false;
    const manager = MoonSky.createCometManager({
      setTimeout: () => { timerSet = true; return 1; },
      clearTimeout: () => {},
      isEnabled: () => false,
      isHidden: () => false,
    });
    manager.schedule();
    assert.strictEqual(timerSet, false, 'no timer scheduled when comets are disabled');
    console.log('ok - disabled comets perform zero timer or background work');
  }

  // 7. Moon-icon asset removal
  {
    const fs = require('fs');
    const path = require('path');
    const iconPath = path.join(__dirname, '../app/src/main/assets/moon-icon.webp');
    assert.strictEqual(fs.existsSync(iconPath), false, 'moon-icon.webp asset is removed');
    console.log('ok - moon-icon.webp is completely removed');
  }

  // 8. Fatter crescent path generation (fuller middle section)
  {
    const MoonPhase = require('../app/src/main/assets/moon-phase');
    const pathCrescent = MoonPhase.moonPhasePath(0.15, 12, 12, 10);
    assert.ok(pathCrescent.startsWith('M 12 2 A 10 10'), 'starts at top and sweeps outer arc');
    assert.ok(pathCrescent.includes('A 1.73 10'), 'crescent inner arc has reduced rx for a fuller, fatter middle');
    console.log('ok - moonPhasePath generates fatter, fuller crescent in the middle');
  }

  // 9. Moon badge vector SVG rendering
  {
    const elements = [];
    const labels = [];
    const fakeDoc = {
      querySelectorAll: (sel) => {
        if (sel === '[data-moon]') return elements;
        if (sel === '[data-moon-label]') return labels;
        return [];
      },
      createElementNS: (ns, tag) => {
        const attrs = {};
        const children = [];
        return {
          tagName: tag.toUpperCase(),
          setAttribute: (k, v) => { attrs[k] = v; },
          getAttribute: (k) => attrs[k],
          appendChild: (c) => children.push(c),
          children,
        };
      },
    };

    const badgeEl = {
      children: [],
      appendChild: function (child) { this.children.push(child); },
      setAttribute: function (k, v) { this[k] = v; },
      textContent: 'old',
    };
    elements.push(badgeEl);

    const labelEl = { textContent: '' };
    labels.push(labelEl);

    global.NovelMoonLock = {
      moonPhaseInfo: () => ({ name: 'Waxing Crescent', fraction: 0.15, waxing: true }),
      moonPhasePath: () => 'M 12 2 A 10 10 0 0 1 12 22 A 1.73 10 0 0 0 12 2 Z',
    };

    const savedDoc = global.document;
    global.document = fakeDoc;
    try {
      MoonSky.paintMoonBadges();
      assert.strictEqual(labelEl.textContent, 'Waxing Crescent', 'sets label text');
      assert.strictEqual(badgeEl.children.length, 1, 'adds 1 SVG element');
      const svg = badgeEl.children[0];
      assert.strictEqual(svg.tagName, 'SVG', 'child is SVG vector');
      assert.strictEqual(svg.children.length, 2, 'contains disc circle and lit crescent path');
      assert.strictEqual(svg.children[0].tagName, 'CIRCLE', 'first child is circle disc');
      assert.strictEqual(svg.children[1].tagName, 'PATH', 'second child is lit crescent path');
    } finally {
      global.document = savedDoc;
    }
    console.log('ok - paintMoonBadges renders vector SVG moon with disc and lit crescent');
  }

  // 10. index.html symbols have tilted bold crescent paths matching target design
  {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/index.html'), 'utf8');
    assert.ok(html.includes('id="i-moon"'), 'defines i-moon symbol');
    assert.ok(html.includes('id="i-moon-music"'), 'defines i-moon-music symbol');
    assert.ok(html.includes('<symbol id="i-moon-music" viewBox="0 0 24 24"><path d="M20 14.6A8 8 0 0 1 9.4 4a8 8 0 1 0 10.6 10.6Z"/></symbol>'), 'i-moon-music uses tilted bold crescent');
    assert.ok(html.includes('<symbol id="i-moon" viewBox="0 0 24 24"><path d="M20 14.6A8 8 0 0 1 9.4 4a8 8 0 1 0 10.6 10.6Z"/></symbol>'), 'i-moon uses tilted bold crescent');
    assert.strictEqual(html.includes('d="M17 5.5v8.2"'), false, 'music note path removed from moon symbols');
    assert.strictEqual(html.includes('moon-corner-badge'), false, 'moon-corner-badge is removed');
    console.log('ok - index.html defines bold SVG symbols with tilted crescent');
  }

  console.log('\nAll 10 background visual effects and moon icon tests passed cleanly!');
})();
