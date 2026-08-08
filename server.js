/* ============================================================================
   Command Atlas — local terminal backend
   ----------------------------------------------------------------------------
   Serves the Atlas page and gives its terminal deck REAL shells on THIS host.

   Security posture (read the README):
     • Binds to 127.0.0.1 only — never reachable from the network.
     • A random token is required to open the page and the WebSocket.
     • WebSocket upgrades are rejected unless the Origin is this same server,
       so a random website open in your browser cannot connect to your shell.
   This is a single-user local tool. Do not expose it. Do not put it behind a
   public proxy. Anyone who can reach it can run commands as you.
   ========================================================================== */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

let WebSocketServer, pty;
try {
  ({ WebSocketServer } = require('ws'));
  pty = require('node-pty');
} catch (e) {
  console.error('\n  Missing dependencies. Run:  npm install\n');
  console.error('  (node-pty compiles native code — see the README if the build fails.)\n');
  process.exit(1);
}

const PORT  = Number(process.env.PORT || 7420);
const HOST  = '127.0.0.1';
const TOKEN = process.env.ATLAS_TOKEN || crypto.randomBytes(24).toString('hex');

const PUBLIC = path.join(__dirname, 'public');
const NM     = path.join(__dirname, 'node_modules');

/* xterm assets served straight from the installed packages (works offline) */
const VENDOR = {
  '/vendor/xterm.js'    : path.join(NM, '@xterm', 'xterm', 'lib', 'xterm.js'),
  '/vendor/xterm.css'   : path.join(NM, '@xterm', 'xterm', 'css', 'xterm.css'),
  '/vendor/addon-fit.js': path.join(NM, '@xterm', 'addon-fit', 'lib', 'addon-fit.js'),
};

const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.ico':'image/x-icon',
  '.map':'application/json', '.woff2':'font/woff2'
};

function sendFile(res, fp) {
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  let p = u.pathname;

  if (VENDOR[p]) return sendFile(res, VENDOR[p]);
  if (p === '/') p = '/index.html';

  const filePath = path.join(PUBLIC, path.normalize(p));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  sendFile(res, filePath);
});

/* ---- WebSocket: real PTY sessions ---------------------------------------- */
const ALLOWED_ORIGINS = new Set([
  `http://${HOST}:${PORT}`,
  `http://localhost:${PORT}`,
]);

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  if (u.pathname !== '/pty') { socket.destroy(); return; }

  // Reject drive-by connections from other origins (e.g. a malicious website).
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) { socket.destroy(); return; }

  // Require the token.
  if (u.searchParams.get('token') !== TOKEN) { socket.destroy(); return; }

  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

const isWin = process.platform === 'win32';
const SHELL = isWin
  ? (process.env.COMSPEC || 'powershell.exe')
  : (process.env.SHELL || 'bash');

wss.on('connection', (ws) => {
  const sessions = {};

  const spawn = (n) => {
    const term = pty.spawn(SHELL, [], {
      name: 'xterm-256color',
      cols: 80, rows: 24,
      cwd: process.env.HOME || process.cwd(),
      env: Object.assign({}, process.env, { TERM: 'xterm-256color' }),
    });
    term.onData((d) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'data', term: n, data: d })); });
    term.onExit(({ exitCode }) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'exit', term: n, code: exitCode })); });
    sessions[n] = term;
  };

  spawn(1);
  spawn(2);
  ws.send(JSON.stringify({ type: 'ready', shell: SHELL }));

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const t = sessions[m.term];
    if (!t) return;
    if (m.type === 'input') t.write(m.data);
    else if (m.type === 'resize' && m.cols > 0 && m.rows > 0) { try { t.resize(m.cols, m.rows); } catch {} }
  });

  ws.on('close', () => { Object.values(sessions).forEach((t) => { try { t.kill(); } catch {} }); });
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/?token=${TOKEN}`;
  const line = '─'.repeat(58);
  console.log(`\n┌${line}┐`);
  console.log('  Command Atlas — terminal backend is live');
  console.log(`└${line}┘\n`);
  console.log('  Open this URL in your browser (the token is required):\n');
  console.log(`    \x1b[1m${url}\x1b[0m\n`);
  console.log(`  Shell   : ${SHELL}`);
  console.log(`  Bound to: ${HOST}:${PORT}  (localhost only — not on the network)`);
  console.log('  Stop    : Ctrl-C\n');
});
