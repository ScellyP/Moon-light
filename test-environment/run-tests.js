/**
 * Moonlight Test Suite Runner
 * Runs all node unit tests and displays a summary table.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const TESTS_DIR = path.resolve(ROOT_DIR, 'tests');

const testFiles = [
  'song-download.test.js',
  'playlist-records.test.js',
  'index-html.test.js',
  'playlist-editor.test.js',
  'song-search.test.js',
  'song-memory.test.js',
  'settings-menu.test.js',
  'playlist-sheet.test.js',
  'playlist-picker.test.js',
  'playlist-header.test.js',
  'spotify-home.test.js',
  'spotify-tabs.test.js',
  'player-app.test.js',
  'theme-extraction.test.js',
  'moon-sky.test.js',
  'song-backup.test.js',
  'playlist-share.test.js'
];

console.log('\n========================================================');
console.log(' Moonlight Automated Test Runner');
console.log(' Target directory: ' + ROOT_DIR);
console.log('========================================================\n');

let totalPassed = 0;
let totalFailed = 0;
const results = [];

testFiles.forEach((file) => {
  const filePath = path.join(TESTS_DIR, file);
  if (!fs.existsSync(filePath)) {
    console.log(`[SKIP] ${file} (not found)`);
    return;
  }

  process.stdout.write(`Running ${file.padEnd(28)} ... `);
  const start = Date.now();
  const res = spawnSync(process.execPath, [filePath], {
    cwd: ROOT_DIR,
    encoding: 'utf8'
  });
  const duration = Date.now() - start;

  if (res.status === 0) {
    console.log(`\x1b[32mPASS\x1b[0m (${duration}ms)`);
    totalPassed++;
    results.push({ file, ok: true, duration });
  } else {
    console.log(`\x1b[31mFAIL\x1b[0m (${duration}ms)`);
    console.error(res.stdout || res.stderr);
    totalFailed++;
    results.push({ file, ok: false, duration });
  }
});

console.log('\n--------------------------------------------------------');
console.log(`Summary: ${totalPassed} passed, ${totalFailed} failed out of ${totalPassed + totalFailed} suites.`);
console.log('========================================================\n');

if (totalFailed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
