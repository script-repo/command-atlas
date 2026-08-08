/* ============================================================================
   Command Atlas — multi-user terminal backend
   ----------------------------------------------------------------------------
   Serves the Atlas page and gives its terminal deck REAL shells on THIS host,
   running as whichever local Linux account each visitor authenticates as.

   Security posture (read the README):
     • Users log in with their real local Linux account (PAM). No account,
       no shell — there is no shared/anonymous access.
     • Each terminal is `login -f <user>`, so it runs as that user, with that
       user's groups, and starts in that user's own home directory.
     • Sessions are a random cookie, HttpOnly + SameSite=Lax (Secure when TLS
       is enabled). WebSocket upgrades are rejected without a valid session
       and unless the Origin (when present) matches the request Host.
     • This process must run as root — PAM needs root to verify another
       user's password, and dropping privileges to that user's shell needs
       root too. Because it's now reachable from the network, put TLS in
       front of it (ATLAS_TLS_CERT/ATLAS_TLS_KEY below, or a reverse proxy).
   ========================================================================== */

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

if (process.platform === 'win32') {
  console.error('\n  Command Atlas multi-user mode requires Linux.');
  console.error('  (PAM authentication and /bin/login are not available on Windows.)\n');
  process.exit(1);
}

let WebSocketServer, pty, pam;
try {
  ({ WebSocketServer } = require('ws'));
  pty = require('node-pty');
  pam = require('authenticate-pam');
} catch (e) {
  console.error('\n  Missing dependencies. Run:  npm install\n');
  console.error('  (node-pty and authenticate-pam compile native code — see the README if the build fails.)\n');
  process.exit(1);
}

if (typeof process.getuid === 'function' && process.getuid() !== 0) {
  console.error('\n  Command Atlas must run as root:');
  console.error('    • PAM needs root to verify other users\' passwords.');
  console.error('    • Spawning a shell as another user needs root to drop privileges to it.\n');
  console.error('  Run it with:  sudo node server.js   (or: sudo npm start)\n');
  process.exit(1);
}

const PORT         = Number(process.env.PORT || 7420);
const HOST         = process.env.HOST || '0.0.0.0';
const PAM_SERVICE  = process.env.ATLAS_PAM_SERVICE || 'login';
const SESSION_TTL_MS = (Number(process.env.ATLAS_SESSION_TTL_HOURS) || 12) * 3600 * 1000;
const SESSION_COOKIE = 'atlas_sid';
const USERNAME_RE = /^[a-zA-Z_][a-zA-Z0-9_-]{0,31}$/;

const TLS_CERT = process.env.ATLAS_TLS_CERT;
const TLS_KEY  = process.env.ATLAS_TLS_KEY;
const useTLS   = Boolean(TLS_CERT && TLS_KEY);

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

function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  }, extraHeaders || {}));
  res.end(body);
}

/* ---- cookies & sessions --------------------------------------------------- */

const sessions = new Map(); // sid -> { username, createdAt, lastActive }

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) { try { out[k] = decodeURIComponent(v); } catch { out[k] = v; } }
  });
  return out;
}

function serializeSessionCookie(sid, maxAgeSeconds) {
  const parts = [`${SESSION_COOKIE}=${sid}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (useTLS) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookie() {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (useTLS) parts.push('Secure');
  return parts.join('; ');
}

function getSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies[SESSION_COOKIE];
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) { sessions.delete(sid); return null; }
  session.lastActive = Date.now();
  return { sid, username: session.username };
}

/* ---- login rate limiting (per source IP) ---------------------------------- */

const loginAttempts = new Map(); // ip -> { windowStart, count, lockedUntil }
const RL_MAX_ATTEMPTS = 8;
const RL_WINDOW_MS = 5 * 60 * 1000;
const RL_LOCK_MS = 60 * 1000;

function checkRateLimit(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec) return { allowed: true };
  const now = Date.now();
  if (rec.lockedUntil && now < rec.lockedUntil) return { allowed: false, retryAfterMs: rec.lockedUntil - now };
  if (now - rec.windowStart > RL_WINDOW_MS) { loginAttempts.delete(ip); return { allowed: true }; }
  return { allowed: true };
}

function recordLoginFailure(ip) {
  const now = Date.now();
  let rec = loginAttempts.get(ip);
  if (!rec || now - rec.windowStart > RL_WINDOW_MS) rec = { windowStart: now, count: 0 };
  rec.count += 1;
  if (rec.count >= RL_MAX_ATTEMPTS) {
    rec.lockedUntil = now + RL_LOCK_MS * Math.min(rec.count - RL_MAX_ATTEMPTS + 1, 10);
  }
  loginAttempts.set(ip, rec);
}

function recordLoginSuccess(ip) { loginAttempts.delete(ip); }

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) { if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(sid); }
  for (const [ip, rec] of loginAttempts) {
    if ((!rec.lockedUntil || now > rec.lockedUntil) && now - rec.windowStart > RL_WINDOW_MS) loginAttempts.delete(ip);
  }
}, 15 * 60 * 1000).unref();

/* ---- request body helper --------------------------------------------------- */

function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function readTextBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ---- auth API --------------------------------------------------------------- */

async function handleLogin(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';

  const limited = checkRateLimit(ip);
  if (!limited.allowed) {
    return sendJson(res, 429, { error: 'too many attempts — try again shortly' },
      { 'Retry-After': String(Math.ceil(limited.retryAfterMs / 1000)) });
  }

  let body;
  try { body = await readJsonBody(req, 1024); }
  catch { return sendJson(res, 400, { error: 'bad request' }); }

  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!USERNAME_RE.test(username) || !password) {
    recordLoginFailure(ip);
    return sendJson(res, 401, { error: 'invalid credentials' });
  }

  pam.authenticate(username, password, (err) => {
    if (err) {
      recordLoginFailure(ip);
      return sendJson(res, 401, { error: 'invalid credentials' });
    }
    recordLoginSuccess(ip);
    const sid = crypto.randomBytes(32).toString('hex');
    sessions.set(sid, { username, createdAt: Date.now(), lastActive: Date.now() });
    sendJson(res, 200, { username }, { 'Set-Cookie': serializeSessionCookie(sid, Math.floor(SESSION_TTL_MS / 1000)) });
  }, { serviceName: PAM_SERVICE, remoteHost: ip });
}

function handleLogout(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies[SESSION_COOKIE];
  if (sid) sessions.delete(sid);
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
}

function handleMe(req, res) {
  const session = getSession(req);
  if (!session) return sendJson(res, 401, { error: 'unauthenticated' });
  sendJson(res, 200, { username: session.username });
}

/* ---- kubeconfig upload -------------------------------------------------------- */

const KUBECONFIG_MAX_BYTES = 2 * 1024 * 1024;

// `getent passwd` reads the same user database `login -f` does (local files,
// or LDAP/SSSD/etc. via nsswitch), so home dir/uid/gid always match the
// account the user's shell actually runs as.
function getPasswdEntry(username) {
  return new Promise((resolve, reject) => {
    execFile('getent', ['passwd', username], (err, stdout) => {
      if (err) return reject(err);
      const fields = stdout.trim().split(':');
      if (fields.length < 7) return reject(new Error('unexpected getent output'));
      resolve({ uid: Number(fields[2]), gid: Number(fields[3]), home: fields[5] });
    });
  });
}

function looksLikeKubeconfig(text) {
  return /^\s*apiVersion:/m.test(text) && /^\s*clusters:/m.test(text) &&
    /^\s*contexts:/m.test(text) && /^\s*users:/m.test(text);
}

async function handleKubeconfigUpload(req, res) {
  const session = getSession(req);
  if (!session) return sendJson(res, 401, { error: 'unauthenticated' });

  let text;
  try { text = await readTextBody(req, KUBECONFIG_MAX_BYTES); }
  catch { return sendJson(res, 413, { error: 'file too large (max 2 MB)' }); }

  if (!text.trim() || !looksLikeKubeconfig(text)) {
    return sendJson(res, 400, { error: "that doesn't look like a kubeconfig (expected apiVersion/clusters/contexts/users)" });
  }

  let pw;
  try { pw = await getPasswdEntry(session.username); }
  catch { return sendJson(res, 500, { error: 'could not resolve your home directory' }); }

  const kubeDir = path.join(pw.home, '.kube');
  const configPath = path.join(kubeDir, 'config');

  try {
    fs.mkdirSync(kubeDir, { recursive: true, mode: 0o700 });
    fs.chownSync(kubeDir, pw.uid, pw.gid);

    if (fs.existsSync(configPath)) {
      const backupPath = `${configPath}.bak-${Date.now()}`;
      fs.renameSync(configPath, backupPath);
      fs.chownSync(backupPath, pw.uid, pw.gid);
    }

    fs.writeFileSync(configPath, text, { mode: 0o600 });
    fs.chownSync(configPath, pw.uid, pw.gid);
  } catch (e) {
    return sendJson(res, 500, { error: `failed to write kubeconfig: ${e.message}` });
  }

  sendJson(res, 200, { ok: true, path: configPath });
}

/* ---- HTTP server ------------------------------------------------------------ */

function requestHandler(req, res) {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;

  if (req.method === 'POST' && p === '/api/login')       return void handleLogin(req, res);
  if (req.method === 'POST' && p === '/api/logout')      return void handleLogout(req, res);
  if (req.method === 'GET'  && p === '/api/me')          return void handleMe(req, res);
  if (req.method === 'POST' && p === '/api/kubeconfig')  return void handleKubeconfigUpload(req, res);

  if (VENDOR[p]) return sendFile(res, VENDOR[p]);

  const filePath = path.join(PUBLIC, path.normalize(p === '/' ? '/index.html' : p));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  sendFile(res, filePath);
}

const server = useTLS
  ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, requestHandler)
  : http.createServer(requestHandler);

/* ---- WebSocket: real per-user PTY sessions ----------------------------------- */

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  if (u.pathname !== '/pty') { socket.destroy(); return; }

  // Same-origin check: if the browser sent an Origin, its host must match ours.
  // (Works no matter which LAN hostname/IP/port the client used to reach us.)
  const origin = req.headers.origin;
  if (origin) {
    let originHost;
    try { originHost = new URL(origin).host; } catch { socket.destroy(); return; }
    if (originHost !== req.headers.host) { socket.destroy(); return; }
  }

  const session = getSession(req);
  if (!session) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.atlasUser = session.username;
    wss.emit('connection', ws, req);
  });
});

// `term.kill()` only signals the single PID node-pty tracks — the `login`
// process itself. `login -f` forks internally and execs the shell as a
// *child*, then blocks waiting for it so it can run PAM/utmp cleanup once it
// exits. A bare SIGHUP to just `login`'s PID kills login (default signal
// disposition) without ever touching that child, orphaning the shell —
// still alive, still attached to the pty, session never closed. Those
// orphans pile up across reconnects/relogins and are what caused terminals
// to stop working. `.destroy()` closes the pty's master fd first, which
// triggers a real kernel-level hangup delivered to the pty's whole
// foreground process group (login *and* its shell child), so login gets to
// actually finish its cleanup. `killPty` uses that, then double-checks with
// a delayed SIGKILL to the process group in case anything still survives.
function killPty(term) {
  const pid = term.pid;
  try {
    if (typeof term.destroy === 'function') term.destroy();
    else term.kill();
  } catch { try { term.kill(); } catch {} }

  setTimeout(() => {
    try { process.kill(-pid, 0); } catch { return; } // nothing left in the group
    try { process.kill(-pid, 'SIGKILL'); } catch {}
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }, 2000).unref();
}

wss.on('connection', (ws) => {
  const username = ws.atlasUser;
  const ptys = {};

  // `login -f <user>` (pre-authenticated login) drops privileges to that
  // user correctly — real uid/gid *and* supplementary groups via PAM/
  // initgroups — reads their home dir & shell from the passwd db, cd's
  // there, and execs their shell. That's more correct than hand-rolling
  // uid/gid on pty.spawn, which does not set supplementary groups.
  const spawnTerm = (n) => {
    const term = pty.spawn('/bin/login', ['-f', username], {
      name: 'xterm-256color',
      cols: 80, rows: 24,
      cwd: '/',
      env: { TERM: 'xterm-256color', LANG: process.env.LANG || 'C.UTF-8' },
    });
    term.onData((d) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'data', term: n, data: d })); });
    term.onExit(({ exitCode }) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'exit', term: n, code: exitCode })); });
    ptys[n] = term;
  };

  spawnTerm(1);
  spawnTerm(2);
  ws.send(JSON.stringify({ type: 'ready', shell: `login -f ${username}`, user: username }));

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const t = ptys[m.term];
    if (!t) return;
    if (m.type === 'input') t.write(m.data);
    else if (m.type === 'resize' && m.cols > 0 && m.rows > 0) { try { t.resize(m.cols, m.rows); } catch {} }
  });

  ws.on('close', () => { Object.values(ptys).forEach((t) => { try { killPty(t); } catch {} }); });
});

// When bound to a wildcard address, print the actual LAN IP(s) a browser can
// use instead of the meaningless 0.0.0.0 — that's a "listen on everything"
// instruction to the OS, not a reachable address.
function listLanAddresses() {
  const addrs = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const net of ifaces || []) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  return addrs;
}

server.listen(PORT, HOST, () => {
  const scheme = useTLS ? 'https' : 'http';
  const line = '─'.repeat(58);
  console.log(`\n┌${line}┐`);
  console.log('  Command Atlas — multi-user terminal backend is live');
  console.log(`└${line}┘\n`);

  const isWildcard = HOST === '0.0.0.0' || HOST === '::' || HOST === '';
  const urls = isWildcard
    ? listLanAddresses().map((ip) => `${scheme}://${ip}:${PORT}`)
    : [`${scheme}://${HOST}:${PORT}`];
  if (!urls.length) urls.push(`${scheme}://${HOST}:${PORT}`);

  if (urls.length === 1) {
    console.log(`  Listening on : ${urls[0]}`);
  } else {
    console.log('  Listening on :');
    urls.forEach((u) => console.log(`      ${u}`));
  }
  console.log('  Auth         : local Linux accounts via PAM — log in on the page');
  console.log('  Shells       : `login -f <user>` per terminal — starts in that user\'s own $HOME');
  if (!useTLS) {
    console.log('\n  ⚠  No TLS configured — credentials and session cookies travel in cleartext.');
    console.log('     Set ATLAS_TLS_CERT and ATLAS_TLS_KEY, or put a TLS-terminating reverse proxy in front.');
  }
  console.log('\n  Stop : Ctrl-C\n');
});
