// Run with: node tests/update-script.test.js
// tools/update-moonlight.sh (the Termux updater) run for real with a pretend GitHub, curl, installer
// and Shizuku/root, to check what it downloads, verifies, installs and says.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '../tools/update-moonlight.sh');
const APK_BYTES = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('pretend moonlight apk '.repeat(50))]);
const SHA = crypto.createHash('sha256').update(APK_BYTES).digest('hex');

let n = 0;
function check(name, fn) { try { fn(); } catch (e) { console.log('FAIL -', name); throw e; } n++; console.log('ok -', name); }

const releaseJson = (tag, { digest = SHA, apk = true } = {}) => `{
  "url": "https://api.github.com/repos/ScellyP/Moon-light/releases/1",
  "tag_name": "${tag}",
  "name": "Moonlight ${tag}",
  "draft": false,
  "assets": [
    {
      "url": "https://api.github.com/repos/ScellyP/Moon-light/releases/assets/1",
      "name": "notes.txt",
      "uploader": { "login": "github-actions[bot]", "id": 41898282 },
      "size": 12,
      "digest": "sha256:${'0'.repeat(64)}",
      "browser_download_url": "https://github.com/ScellyP/Moon-light/releases/download/${tag}/notes.txt"
    }${apk ? `,
    {
      "url": "https://api.github.com/repos/ScellyP/Moon-light/releases/assets/2",
      "name": "moonlight-${tag}.apk",
      "label": null,
      "uploader": { "login": "github-actions[bot]", "id": 41898282 },
      "content_type": "application/vnd.android.package-archive",
      "state": "uploaded",
      "size": ${APK_BYTES.length},
      "digest": "sha256:${digest}",
      "download_count": 0,
      "browser_download_url": "https://github.com/ScellyP/Moon-light/releases/download/${tag}/moonlight-${tag}.apk"
    }` : ''}
  ]
}`;

function run(args, { tag = 'v1.03.00', http = 200, json, digest, apk = true, extraMocks = {}, home } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlt-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const homeDir = home || path.join(dir, 'home'); fs.mkdirSync(homeDir, { recursive: true });
  const log = path.join(dir, 'log.txt'); fs.writeFileSync(log, '');
  fs.writeFileSync(path.join(dir, 'release.json'), json || releaseJson(tag, { digest, apk }));
  fs.writeFileSync(path.join(dir, 'app.apk'), APK_BYTES);
  const mock = (name, body) => { fs.writeFileSync(path.join(bin, name), '#!/bin/bash\n' + body + '\n', { mode: 0o755 }); };
  mock('curl', `out=""; api=0
for ((i=1;i<=$#;i++)); do a="\${!i}"; case "$a" in -o) j=$((i+1)); out="\${!j}";; -w) api=1;; esac; done
if [ "$api" = 1 ]; then cp "$MOCK_JSON" "$out"; printf '%s' "$MOCK_HTTP"; else cp "$MOCK_APK" "$out"; echo "download" >> "$MOCK_LOG"; fi`);
  mock('su', 'exit 1');                                         // no root unless a test says so
  mock('termux-open', 'echo "open $*" >> "$MOCK_LOG"');
  Object.keys(extraMocks).forEach((k) => mock(k, extraMocks[k]));
  const res = spawnSync('bash', [SCRIPT].concat(args), {
    env: { PATH: bin + ':/usr/bin:/bin', HOME: homeDir, TMPDIR: dir, MOCK_JSON: path.join(dir, 'release.json'), MOCK_APK: path.join(dir, 'app.apk'), MOCK_LOG: log, MOCK_HTTP: String(http) },
    encoding: 'utf8', input: '',
  });
  return {
    code: res.status, out: res.stdout + res.stderr, home: homeDir,
    log: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean),
    apks: () => { try { return fs.readdirSync(path.join(homeDir, 'moonlight-updates')); } catch (e) { return []; } },
    state: () => { try { return fs.readFileSync(path.join(homeDir, '.moonlight-installed-version'), 'utf8').trim(); } catch (e) { return null; } },
  };
}

check('a newer release is downloaded, its checksum verified, and the Android installer opened', () => {
  const r = run([]);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(/Newest release: v1\.03\.00/.test(r.out));
  assert.ok(/Checksum OK/.test(r.out));
  assert.deepStrictEqual(r.apks(), ['moonlight-v1.03.00.apk']);
  assert.ok(r.log.includes('download'));
  const open = r.log.find((l) => l.startsWith('open '));
  assert.ok(open && /--view --content-type application\/vnd\.android\.package-archive .*moonlight-v1\.03\.00\.apk$/.test(open), open);
});

check('the downloaded file is exactly the release file', () => {
  const r = run([]);
  assert.ok(fs.readFileSync(path.join(r.home, 'moonlight-updates', 'moonlight-v1.03.00.apk')).equals(APK_BYTES));
});

check('the checksum that counts is the one listed for the APK, not another file\'s', () => {
  const r = run([], { digest: SHA });                 // notes.txt (listed first) has a different digest
  assert.strictEqual(r.code, 0, r.out);
  const bad = run([], { digest: 'f'.repeat(64) });
  assert.notStrictEqual(bad.code, 0);
});

check('a damaged download (wrong checksum) is deleted and never installed', () => {
  const r = run([], { digest: 'a'.repeat(64) });
  assert.notStrictEqual(r.code, 0);
  assert.ok(/damaged/.test(r.out));
  assert.deepStrictEqual(r.apks(), []);
  assert.ok(!r.log.some((l) => l.startsWith('open ')));
});

check('--check only reports: nothing is downloaded or opened', () => {
  const r = run(['--check']);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(/Newest release: v1\.03\.00/.test(r.out));
  assert.deepStrictEqual(r.log, []);
  assert.deepStrictEqual(r.apks(), []);
});

check('already on the newest version: says so and does nothing', () => {
  const r = run(['--installed', 'v1.03.00']);
  assert.strictEqual(r.code, 0);
  assert.ok(/Already up to date/.test(r.out));
  assert.deepStrictEqual(r.log, []);
});

check('--force installs it anyway', () => {
  const r = run(['--installed', 'v1.03.00', '--force']);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.log.includes('download'));
});

check('versions are compared as numbers (v1.10.00 is newer than v1.9.5, v1.03.00 is not newer than v1.3.1)', () => {
  assert.ok(run(['--installed', 'v1.9.5'], { tag: 'v1.10.00' }).log.includes('download'));
  assert.ok(/Already up to date/.test(run(['--installed', 'v1.3.1']).out));
  assert.ok(/Already up to date/.test(run(['--installed', 'v2.0.0']).out));
});

check('an already downloaded and verified APK is reused', () => {
  const first = run([]);
  const second = run([], { home: first.home });
  assert.ok(/Already downloaded/.test(second.out));
  assert.ok(!second.log.includes('download'));
});

check('with Shizuku the update is silent, and the version is remembered', () => {
  const r = run([], { extraMocks: { rish: 'echo "rish $*" >> "$MOCK_LOG"; echo "Success"' } });
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.log.some((l) => /^rish -c pm install -r .*moonlight-v1\.03\.00\.apk/.test(l)), r.log.join('|'));
  assert.ok(!r.log.some((l) => l.startsWith('open ')), 'the installer screen is not needed');
  assert.strictEqual(r.state(), 'v1.03.00');
  assert.ok(/Already up to date/.test(run([], { home: r.home }).out), 'the next run knows');
});

check('if Shizuku fails it falls back to the Android installer', () => {
  const r = run([], { extraMocks: { rish: 'echo "Failure [INSTALL_FAILED]"' } });
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.log.some((l) => l.startsWith('open ')));
  assert.strictEqual(r.state(), null, 'not remembered: it is not known that the install finished');
});

check('with root the update is silent', () => {
  const r = run([], { extraMocks: { su: 'if [ "$2" = id ]; then exit 0; fi; echo "su $2" >> "$MOCK_LOG"; exit 0' } });
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.log.some((l) => /^su cp .*pm install -r/.test(l)), r.log.join('|'));
  assert.strictEqual(r.state(), 'v1.03.00');
});

check('a missing release says the repo must be public and have a Release', () => {
  const r = run([], { http: 404, json: '{"message":"Not Found"}' });
  assert.notStrictEqual(r.code, 0);
  assert.ok(/must be public/.test(r.out) && /ScellyP\/Moon-light/.test(r.out));
});

check('a release with no APK yet, and a rate limit, give clear messages', () => {
  const none = run([], { apk: false });
  assert.notStrictEqual(none.code, 0);
  assert.ok(/no APK attached/.test(none.out));
  const limited = run([], { http: 403, json: '{}' });
  assert.ok(/limiting requests/.test(limited.out));
});

check('another repository can be chosen, and unknown options are refused', () => {
  const r = spawnSync('bash', [SCRIPT, '--nope'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
  assert.ok(/Unknown option/.test(r.stderr));
  assert.ok(/MOONLIGHT_REPO/.test(fs.readFileSync(SCRIPT, 'utf8')));
});

check('the script is valid bash and the help text is readable', () => {
  assert.strictEqual(spawnSync('bash', ['-n', SCRIPT]).status, 0);
  const help = spawnSync('bash', [SCRIPT, '--help'], { encoding: 'utf8' }).stdout;
  assert.ok(/bash update-moonlight\.sh --check/.test(help) && /Shizuku/.test(help));
  assert.ok(!/^=+$/m.test(help.split('\n')[0]), 'starts with the title, not a ruler');
});

const updater = fs.readFileSync(path.join(__dirname, '../app/src/main/java/com/scell/moonlight/AppUpdater.kt'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/index.html'), 'utf8');

check('the in-app updater says why when a MANUAL check finds no usable release (not "up to date")', () => {
  assert.ok(/if \(code == 404\) \{[\s\S]*?if \(manual\) \{\s*fail\("check", "No release found at \$OWNER_REPO\./.test(updater));
  assert.ok(/if \(found == null\) \{[\s\S]*?if \(manual\) \{\s*fail\("check", "The newest release \(\$tag\) has no APK attached yet\./.test(updater));
  // the silent background checks stay quiet
  assert.ok(/\} else \{\s*setState\("uptodate", manual = manual\)/.test(updater));
});

check('the version number in the Settings menu has no stray line above it', () => {
  assert.ok(/\.sd-foot #app-version \{[^}]*padding: 0; border: 0;/.test(html));
});

console.log(n + ' checks passed');
