/**
 * Moonlight Virtual Environment — Local Test Server
 * Zero-dependency Node.js HTTP server for running and testing the Moonlight app in a browser.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '8080', 10);
const ROOT_DIR = path.resolve(__dirname, '..');
const ASSETS_DIR = path.resolve(ROOT_DIR, 'app/src/main/assets');
const TEST_ENV_DIR = path.resolve(ROOT_DIR, 'test-environment');
const TESTS_DIR = path.resolve(ROOT_DIR, 'tests');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.mp3':  'audio/mpeg',
  '.txt':  'text/plain; charset=utf-8'
};

function serveFile(res, filePath, transform) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + filePath);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    let output = data;
    if (transform && typeof transform === 'function') {
      output = transform(data.toString('utf8'));
    }
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(output);
  });
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  let pathname = decodeURIComponent(parsedUrl.pathname);

  // API: Run tests
  if (pathname === '/api/run-tests') {
    handleRunTests(res);
    return;
  }

  // API: Get app version and status
  if (pathname === '/api/status') {
    let version = 'unknown';
    try {
      const vFile = fs.readFileSync(path.join(ASSETS_DIR, 'version.js'), 'utf8');
      const m = vFile.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
      if (m) version = m[1];
    } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: version, timestamp: new Date().toISOString() }));
    return;
  }

  // Root -> Test Harness Dashboard
  if (pathname === '/' || pathname === '/index.html') {
    serveFile(res, path.join(TEST_ENV_DIR, 'index.html'));
    return;
  }

  // Direct app view (/app/ or /app/index.html) -> inject virtual environment bridge into HTML
  if (pathname === '/app/' || pathname === '/app/index.html') {
    serveFile(res, path.join(ASSETS_DIR, 'index.html'), (html) => {
      const injection = '\n<script src="/test-environment/sample-library.js"></script>' +
                        '\n<script src="/test-environment/mock-android-bridge.js"></script>\n';
      return html.replace(/<head>/i, '<head>' + injection);
    });
    return;
  }

  // App asset files (/app/*)
  if (pathname.startsWith('/app/')) {
    const rel = pathname.slice('/app/'.length);
    const target = path.join(ASSETS_DIR, rel);
    serveFile(res, target);
    return;
  }

  // Test environment files (/test-environment/*)
  if (pathname.startsWith('/test-environment/')) {
    const rel = pathname.slice('/test-environment/'.length);
    const target = path.join(TEST_ENV_DIR, rel);
    serveFile(res, target);
    return;
  }

  // Fallback: check test-environment then assets
  const candidateTest = path.join(TEST_ENV_DIR, pathname);
  if (fs.existsSync(candidateTest) && fs.statSync(candidateTest).isFile()) {
    serveFile(res, candidateTest);
    return;
  }

  const candidateApp = path.join(ASSETS_DIR, pathname);
  if (fs.existsSync(candidateApp) && fs.statSync(candidateApp).isFile()) {
    serveFile(res, candidateApp);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404 Not Found: ' + pathname);
});

function handleRunTests(res) {
  const testFiles = [
    'song-download.test.js',
    'playlist-records.test.js',
    'index-html.test.js',
    'playlist-editor.test.js',
    'song-memory.test.js',
    'settings-menu.test.js',
    'playlist-sheet.test.js',
    'playlist-picker.test.js',
    'spotify-home.test.js',
    'spotify-tabs.test.js',
    'player-app.test.js',
    'theme-extraction.test.js',
    'moon-sky.test.js',
    'song-backup.test.js',
    'playlist-share.test.js'
  ];

  let results = [];
  let pending = testFiles.length;

  testFiles.forEach(file => {
    const fullPath = path.join(TESTS_DIR, file);
    if (!fs.existsSync(fullPath)) {
      results.push({ file: file, ok: false, output: 'File not found' });
      if (--pending === 0) respond();
      return;
    }

    const child = spawn(process.execPath, [fullPath], { cwd: ROOT_DIR });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => {
      results.push({
        file: file,
        ok: code === 0,
        output: stdout.trim() || stderr.trim()
      });
      if (--pending === 0) respond();
    });
  });

  function respond() {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: results.every(r => r.ok), results: results }));
  }
}

function start(port) {
  server.listen(port, () => {
    console.log('\n======================================================');
    console.log(' Moonlight PC Test Environment Server Running!');
    console.log(' Web Dashboard: http://localhost:' + port);
    console.log(' Direct App:    http://localhost:' + port + '/app/');
    console.log('======================================================\n');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log('Port ' + port + ' is busy, trying ' + (port + 1) + '...');
      start(port + 1);
    } else {
      console.error('Server error:', err);
    }
  });
}

start(PORT);
