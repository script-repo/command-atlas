# Command Atlas — live terminal

An interactive CLI mind-map (kubectl · docker · linux · openclaw · openshell) with a
**real terminal deck** wired to actual shells on your machine. Assemble a command in the
map, then send it straight into a live session with one click.

This ships as a small **multi-user** backend: it serves the Atlas page over the network,
authenticates each visitor against a **real local Linux account** (PAM — the same check
`login`/`sshd` use), and gives them a shell that runs *as that user*, starting in *their own*
home directory. Nobody gets in without a valid account on the host, and nobody's shell can
touch another user's files unless the filesystem already allows it.

Source: **https://github.com/script-repo/command-atlas**

```
command-atlas/
├── server.js       # backend: PAM login, sessions, and per-user PTY sessions
├── install.sh       # fresh-system installer (Node.js, build tools, PAM headers, npm install)
├── package.json
├── public/
│   └── index.html  # the atlas + terminal deck (one self-contained page)
└── README.md
```

---

## Prerequisites

- **Linux.** This backend uses PAM and `/bin/login` to authenticate users and drop
  privileges to their shell — there is no Windows/macOS equivalent, so it only runs on Linux.
- **git**, to clone [the repo](https://github.com/script-repo/command-atlas).
- **Node.js 18 or newer** (`node --version`).
- **Native build tools** — `node-pty` and `authenticate-pam` each compile a small native
  addon on install:
  - **Debian/Ubuntu:** `sudo apt install -y build-essential python3 libpam0g-dev`
  - **RHEL/Rocky Linux/Fedora:** `sudo dnf install -y gcc gcc-c++ make python3 pam-devel`
- **Root.** The server process itself must run as root (see *Security* below).

## Quick install (Ubuntu/Debian, RHEL, Rocky Linux, Fedora)

On a fresh box, this single command clones the repo and installs Node.js, the native build
tools, the PAM dev headers, and the npm dependencies — everything needed to run it.
[`install.sh`](./install.sh) auto-detects `apt-get` vs. `dnf`/`yum`, so the **same command**
works on Ubuntu/Debian and on RHEL-family distros (Rocky Linux, RHEL, CentOS, Fedora):

```bash
git clone https://github.com/script-repo/command-atlas.git && cd command-atlas && sudo bash install.sh
```

To update and re-install later:

```bash
cd command-atlas && git pull && sudo bash install.sh
```

If you'd rather install things yourself, clone the repo, see the manual package list above for
your distro, then just run `npm install`.

## Run it

```bash
git clone https://github.com/script-repo/command-atlas.git
cd command-atlas
npm install            # installs xterm, ws, node-pty, authenticate-pam (compiles native code)
sudo npm start          # or: sudo node server.js — root is required, see below
```

On start it prints where it's listening:

```
  Listening on : http://0.0.0.0:7420  (reachable on the network)
```

Open `http://<this-host>:7420/` from any machine on the network. You'll land on a sign-in
card — enter the **username and password of a real account on this host**. On success you get
the atlas plus two live terminals, each running as you, each starting in your home directory.

Change the port with `PORT=8080 sudo npm start`. Bind to a single interface instead of every
interface with `HOST=192.168.1.10 sudo npm start`.

---

## Using the deck

- **Two live shells** side by side, each a full PTY running as *your* account, plus a
  **history pane** on the right.
- **Drag the divider** between the map and the deck to resize; **double-click** it (or the
  *collapse* button) to fold the deck away.
- On a compiled command, alongside **copy** you get **▶ term 1** and **▶ term 2** — these
  push the command into that live shell and log it to history.
- **History pane:** every sent command with a T1/T2 badge and time. Click any entry to send
  it again.
- **logout** in the deck header ends your session and clears your terminals.

### Auto-run toggle (a safety choice)

The deck header has **“auto-run sent commands”**, and it’s **off by default**. With it off,
▶ *stages* the command at the shell prompt without pressing Enter — so you can read the
**Handle with care** notes (on things like `rm -rf`, `kubectl drain`, `docker system prune`)
and hit Enter yourself. Turn it on and sent commands execute immediately.

---

## Security — please read

This tool now hands out real shells **over the network**, to **any account on the host**, so
read this before exposing it beyond your own machine:

- **Real authentication.** Sign-in calls PAM (`authenticate-pam`) with the username/password
  the visitor typed — the same mechanism `login` and `sshd` use. There's no shared token, no
  anonymous access, and no bypass: without a valid local account, nothing works.
- **Runs as root, by necessity.** Verifying another user's password and then dropping
  privileges to run a shell as them both require root. The server refuses to start if it
  isn't running as root (or on a non-Linux platform).
- **Real per-user isolation.** Each terminal is `login -f <user>` — the same program a
  physical console uses — so it gets that user's real uid/gid *and* supplementary groups
  (via PAM/`initgroups`), and lands in their actual home directory. One visitor's shell runs
  with exactly the permissions that account has on the host; it cannot act as another user.
- **Session cookies, not URL tokens.** Signing in sets an `HttpOnly`, `SameSite=Lax` session
  cookie (`Secure` too, automatically, when TLS is enabled). Sessions expire after 12 hours by
  default (`ATLAS_SESSION_TTL_HOURS` to change it) and can be ended any time with **logout**.
- **Origin-checked WebSocket.** `/pty` upgrades are rejected unless the request's `Origin`
  (when the browser sends one) matches the `Host` it was requested on — a different site open
  in your browser can't drive your terminal.
- **Login is rate-limited.** Repeated failed sign-ins from the same address get locked out
  with backoff, to slow down password guessing.

Given all that, this is still meaningfully more exposed than the original localhost-only tool:

- **Put TLS in front of it.** By default it serves plain HTTP, which means passwords and
  session cookies cross the network in cleartext. Either set `ATLAS_TLS_CERT` and
  `ATLAS_TLS_KEY` (PEM paths) to enable built-in HTTPS, or put a TLS-terminating reverse proxy
  (nginx, Caddy, etc.) in front and only expose that.
- **Only run it on hosts/accounts you're comfortable giving shell access to.** Every local
  account becomes a valid login for this tool. Don't run it on a host with accounts that
  shouldn't have remote shell access.
- **Treat the host it runs on accordingly.** A process running as root, accepting network
  connections, is a meaningfully larger attack surface than a localhost-only tool. Keep the
  host patched, and prefer a trusted LAN over the open internet.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `7420` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind to |
| `ATLAS_TLS_CERT` / `ATLAS_TLS_KEY` | *(unset)* | PEM paths — set both to serve HTTPS instead of HTTP |
| `ATLAS_SESSION_TTL_HOURS` | `12` | How long a signed-in session stays valid |
| `ATLAS_PAM_SERVICE` | `login` | PAM service name to authenticate against (see `/etc/pam.d/`) |

---

## Troubleshooting

**`npm install` fails building `node-pty` or `authenticate-pam`** — almost always missing
build tools or PAM headers. Run `sudo bash install.sh` (works on Ubuntu/Debian and on
Rocky Linux/RHEL/Fedora) to install them, or install the packages listed above by hand, then
`rm -rf node_modules && npm install`.

**Server prints "Missing dependencies. Run: npm install" even after `npm install` succeeds** —
this means a stale `node_modules` from another OS/arch is sitting there (native addons like
`node-pty` are platform-specific and `npm install` won't rebuild a package it thinks is already
installed). Delete it and reinstall clean: `rm -rf node_modules package-lock.json && npm install`
(or just re-run `sudo bash install.sh`, which does the same). This shouldn't happen on a fresh
`git clone` going forward — `node_modules/` is no longer committed to the repo.

**Server exits immediately with a root/permission error** — start it with `sudo npm start`
(or run it under a systemd unit with `User=root`). PAM authentication and dropping privileges
to another user's shell both require root.

**"invalid credentials" even though the password is right** — confirm the account exists on
*this* host (`getent passwd <user>`) and that its PAM service (`login` by default) isn't
blocking remote/network logins in a way that also blocks this tool; try
`ATLAS_PAM_SERVICE=sshd` if this host authenticates SSH differently from console login.

**Page loads but the deck stays "offline" after signing in** — check the browser console;
this usually means the WebSocket upgrade was rejected. Confirm you're browsing to the same
host/port the server printed (the same-origin check compares them), and that your session
hasn't expired (`ATLAS_SESSION_TTL_HOURS`).

**Terminals are blank / won’t size** — click into a terminal, or drag the divider to force a
re-fit. They fit on load, on window resize, and on divider drag.

---

## Notes

- xterm.js assets are served locally from `node_modules` (no CDN), so the tool works offline
  once installed.
- Command syntax for **openclaw** follows `docs.openclaw.ai/cli`; **openshell** follows the
  NVIDIA docs (`openshell --help` is authoritative). Both move fast — treat the atlas as a map
  and verify flags against upstream.
- The atlas content is identical to the standalone sheets; this build adds the terminal layer.
