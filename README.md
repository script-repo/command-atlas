# Command Atlas — live terminal

An interactive CLI mind-map (kubectl · docker · linux · openclaw · openshell) with a
**real terminal deck** wired to actual shells on your machine. Assemble a command in the
map, then send it straight into a live session with one click.

Because a browser page cannot open a shell on the host by itself (the sandbox forbids it —
and thank goodness, or every website could run commands on your computer), this ships as a
tiny local backend. You run it; the page connects to `localhost`; the shells are real.

```
command-atlas-terminal/
├── server.js        # local backend: serves the page + brokers real PTY sessions
├── package.json
├── public/
│   └── index.html   # the atlas + terminal deck (one self-contained page)
└── README.md
```

---

## Prerequisites

- **Node.js 18 or newer** (`node --version`).
- **Native build tools** — `node-pty` compiles a small native addon on install:
  - **macOS:** `xcode-select --install`
  - **Debian/Ubuntu:** `sudo apt install -y build-essential python3`
  - **RHEL/Fedora:** `sudo dnf install -y gcc-c++ make python3`
  - **Windows:** a recent Node includes the build tools; if not, install
    “Desktop development with C++” from Visual Studio Build Tools.

## Run it

```bash
cd command-atlas-terminal
npm install        # installs xterm, ws, node-pty (compiles node-pty)
npm start          # or: node server.js
```

On start it prints a URL with a one-time token:

```
    http://127.0.0.1:7420/?token=<random-hex>
```

Open that URL. The status pill in the deck header turns **live** and both terminals give you
a real shell. Type in them like any terminal (tab-completion, `vim`, `top`, all of it).

Change the port with `PORT=8080 npm start`. Pin the token with `ATLAS_TOKEN=... npm start`.

---

## Using the deck

- **Two live shells** side by side, each a full PTY, plus a **history pane** on the right.
- **Drag the divider** between the map and the deck to resize; **double-click** it (or the
  *collapse* button) to fold the deck away.
- On a compiled command, alongside **copy** you get **▶ term 1** and **▶ term 2** — these
  push the command into that live shell and log it to history.
- **History pane:** every sent command with a T1/T2 badge and time. Click any entry to send
  it again.

### Auto-run toggle (a safety choice)

The deck header has **“auto-run sent commands”**, and it’s **off by default**. With it off,
▶ *stages* the command at the shell prompt without pressing Enter — so you can read the
**Handle with care** notes (on things like `rm -rf`, `kubectl drain`, `docker system prune`)
and hit Enter yourself. Turn it on and sent commands execute immediately.

---

## Security — please read

This tool hands out real shells, so it’s built to be **yours only**:

- **Localhost-only.** The server binds to `127.0.0.1`. It is not reachable from your network.
- **Token required.** A random token (printed at startup) is required to load the page and to
  open the WebSocket. Without it, connections are dropped.
- **Origin-checked.** WebSocket upgrades are rejected unless the request’s `Origin` is this
  same server — so a malicious website open in your browser can’t reach `localhost` and drive
  your shell.

Given that:

- **Do not** bind it to `0.0.0.0`, put it behind a public proxy/tunnel, or share the tokened
  URL. Anyone who can reach it runs commands as you.
- Treat it like an open terminal on your machine, because that’s what it is.

---

## Troubleshooting

**`npm install` fails building `node-pty`** — almost always missing build tools. Install the
ones for your OS above, then `rm -rf node_modules && npm install`. On Linux you need a C++
compiler (`gcc-c++`/`build-essential`) and `python3` on `PATH`.

**Page loads but the deck says “offline”** — you opened `index.html` directly (as a `file://`)
instead of through the server, or the URL is missing its `?token=`. Start the backend and use
the printed URL.

**Terminals are blank / won’t size** — click into a terminal, or drag the divider to force a
re-fit. They fit on load, on window resize, and on divider drag.

**Wrong shell** — the backend uses `$SHELL` (POSIX) or `%COMSPEC%` (Windows). Set `SHELL` to
override, e.g. `SHELL=/bin/zsh npm start`.

---

## Notes

- xterm.js assets are served locally from `node_modules` (no CDN), so the tool works offline.
- Command syntax for **openclaw** follows `docs.openclaw.ai/cli`; **openshell** follows the
  NVIDIA docs (`openshell --help` is authoritative). Both move fast — treat the atlas as a map
  and verify flags against upstream.
- The atlas content is identical to the standalone sheets; this build adds the terminal layer.
