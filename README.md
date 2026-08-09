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
├── server.js       # backend: PAM login, sessions, per-user PTY sessions, bulk-password-reset API
├── install.sh       # fresh-system installer + lab provisioning (see "Deployment provisioning" below)
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
- **`kubectl`** and **Docker Engine**, for the command atlas's kubectl/docker sections to be
  runnable for real — `install.sh` installs both automatically (see *Deployment provisioning*
  below).
- **Root.** The server process itself must run as root (see *Security* below).

## Quick install (Ubuntu/Debian, RHEL, Rocky Linux, Fedora)

On a fresh box, this single command clones the repo and installs Node.js, the native build
tools, the PAM dev headers, and the npm dependencies — everything needed to run it. It also
**provisions the box for lab use** (see the next section for exactly what that means — read it
before running this on anything but a disposable lab host).
[`install.sh`](./install.sh) auto-detects `apt-get` vs. `dnf`/`yum`, so the **same command**
works on Ubuntu/Debian and on RHEL-family distros (Rocky Linux, RHEL, CentOS, Fedora):

```bash
git clone https://github.com/script-repo/command-atlas.git && cd command-atlas && sudo bash install.sh
```

To update and re-install later:

```bash
cd command-atlas && git pull && sudo bash install.sh
```

Re-running it is safe: package installs are idempotent, and the lab accounts described below
only ever get their password *set* the first time they're created — never reset by a later
`install.sh` run.

If you'd rather install things yourself, clone the repo, see the manual package list above for
your distro, then just run `npm install`.

### Deployment provisioning — what `install.sh` changes on the host

Beyond installing dependencies, `install.sh` makes these system-level changes, in order:

1. **Lowers the PAM password-quality floor.** Sets `minlen = 8` (was distro-default 14) in
   `/etc/security/pwquality.conf` — the same file/format on Debian/Ubuntu and RHEL-family, so
   this needs no distro branching. ⚠️ This weakens the password policy for **every local
   account**, not just the lab ones below — only run this on a host where that's acceptable.
2. **Enables SSH with local-account password (PAM) authentication.** Installs/enables
   `openssh-server`, then drops `PasswordAuthentication yes` + `UsePAM yes` into
   `/etc/ssh/sshd_config.d/00-command-atlas.conf` (sorted early so it wins even against
   distro/cloud-image drop-ins that disable password auth), reloads `sshd`, and opens the
   firewall for SSH if `firewalld`/`ufw` is active. ⚠️ This makes **every local account**
   remotely SSH-able with just a password, from anywhere that can reach port 22.
3. **Installs `kubectl`** — the official static binary for your CPU architecture, from
   `dl.k8s.io`, straight to `/usr/local/bin/kubectl`. Pairs with the kubeconfig upload feature
   below so `kubectl` in a terminal just works.
4. **Installs Docker Engine** via the official `get.docker.com` convenience script, then
   enables the `docker` service.
5. **Creates local lab accounts `user-01` through `user-20`** (`useradd -m`, `/bin/bash`,
   plain accounts — no `sudo`, no extra groups), if they don't already exist. The password is
   only set **at creation time**: pass `ATLAS_DEFAULT_PASSWORD=<value>` before running
   `install.sh` to choose it, or leave it unset and a random 16-character password is generated
   and printed once to the console (never written to this repo or any file). Nothing ever
   overwrites these passwords on a later `install.sh` run — use the in-app **reset all default
   pw** button below (or `passwd <user>` by hand) to change them afterward.

None of this is appropriate for a general-purpose or production host — it's built for a
disposable lab box that a small group of people are meant to be able to SSH/terminal into with
a short shared password. See *Security* below before running it anywhere else.

## Run it

```bash
git clone https://github.com/script-repo/command-atlas.git
cd command-atlas
npm install            # installs xterm, ws, node-pty, authenticate-pam (compiles native code)
sudo npm start          # or: sudo node server.js — root is required, see below
```

On start it prints the actual LAN address(es) you can open — not the `0.0.0.0` wildcard it's
bound to:

```
  Listening on :
      http://192.168.1.42:7420
      http://10.0.5.7:7420
```

Open one of those URLs from any machine on the network. You'll land on a sign-in card — enter
the **username and password of a real account on this host**. On success you get the atlas plus
two live terminals, each running as you, each starting in your home directory.

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

### Uploading a kubeconfig

The **kubeconfig** button in the top-right corner uploads a kubeconfig from your local machine
straight into your account on the server, so `kubectl` in either terminal just works:

1. Click **kubeconfig**, pick your `config`/`.yaml` file (it's read entirely in the browser —
   nothing is stored client-side).
2. It's sent to the server over your existing signed-in session and saved as `~/.kube/config`
   **for your account specifically** — owned by you, mode `600`, in *your* home directory.
   Other users on the host can't read or overwrite it, and it can't land in anyone else's home
   directory.
3. If you already had a `~/.kube/config`, it's renamed to `config.bak-<timestamp>` first rather
   than being silently overwritten.

The button is disabled behind the sign-in screen, and the upload is rejected (400) if the file
doesn't look like a kubeconfig (no `apiVersion`/`clusters`/`contexts`/`users` keys) or is over 2 MB.

### Resetting the lab accounts' default password

If you sign in as the account named `nutanix` (configurable — see `ATLAS_RESET_PW_ADMIN`
below), a **reset all default pw** button appears in the top-right corner. It's not shown to
anyone else. Clicking it prompts for a new password (entered twice, minimum 8 characters) and,
on submit, immediately overwrites the password for every `user-01`..`user-20` account that
exists on the host — a fast way to re-arm a lab for a new session without SSHing in by hand or
re-running `install.sh`. Accounts that don't exist are silently skipped and reported back.

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
- **Kubeconfig uploads are session-scoped.** `POST /api/kubeconfig` requires a valid session and
  always writes to *that session's own* `~/.kube/config` (owned by that user, mode `600`) — the
  destination path is derived from the authenticated username via `getent`, never from anything
  the client sends, so there's no way to target another user's files.
- **Bulk password reset is admin-gated.** `POST /api/reset-default-passwords` requires a valid
  session *and* that the session's username exactly matches `ATLAS_RESET_PW_ADMIN` (`nutanix` by
  default) — anyone else gets a 403, and the button isn't even rendered for them. It only ever
  touches the configured `user-01`..`user-20` range (`ATLAS_BULK_USER_PREFIX`/
  `ATLAS_BULK_USER_COUNT`), skipping accounts that don't exist.

Given all that, this is still meaningfully more exposed than the original localhost-only tool —
and, if you've run `install.sh`'s provisioning steps, more exposed still:

- **The password policy is weaker and SSH is open.** `install.sh` sets `pwquality.conf`'s
  `minlen` to 8 and enables SSH password authentication for *every* local account on the box,
  not just `user-01`..`user-20` — see *Deployment provisioning* above. Only do this on a
  disposable lab host on a trusted network.
- **20 accounts share one password at a time.** The lab accounts are meant to be easy to
  reset/rotate as a group, not to be individually secure — don't put anything on this host that
  a would-be lab participant with a guessable/shared password shouldn't be able to reach.

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
| `ATLAS_RESET_PW_ADMIN` | `nutanix` | The one account allowed to see/use the "reset all default pw" button |
| `ATLAS_BULK_USER_PREFIX` | `user-` | Username prefix targeted by the bulk password reset |
| `ATLAS_BULK_USER_COUNT` | `20` | How many accounts (`<prefix>01`..`<prefix>NN`) the bulk reset targets |
| `ATLAS_DEFAULT_PASSWORD` | *(random, printed once)* | Read by `install.sh` (not the server) — sets the initial password for newly-created lab accounts |

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

**After logging out/back in (or reconnecting), one terminal stops working, or the other one's
shell exits** — fixed in this version: closing a terminal now calls node-pty's `destroy()`
(a real pty hangup to the whole session) instead of a bare `kill()`, which used to only signal
`login`'s own PID and leave its shell child orphaned. If you hit this on a host that was running
an older version, there may already be leaked shell processes from before the fix — check with
`ps -ef | grep '[l]ogin -f'` and kill any that no longer correspond to an open browser tab.

**SSH password login still refused after running `install.sh`** — some hardened images ship a
drop-in under `/etc/ssh/sshd_config.d/` that also sets `PasswordAuthentication`; `install.sh`
adds its own `00-command-atlas.conf` so it's read first (and wins), but only if
`/etc/ssh/sshd_config` actually `Include`s that directory — check with
`sshd -T | grep -i passwordauthentication` to see the value sshd is actually using, and confirm
`sshd_config` has an `Include /etc/ssh/sshd_config.d/*.conf` line near the top.

**"reset all default pw" button doesn't appear** — it only renders for the account named in
`ATLAS_RESET_PW_ADMIN` (`nutanix` by default). Confirm you signed in as that exact account, and
that the server was started with the same (or default) value of that variable. If you just
pulled these provisioning changes for the first time, also confirm you actually re-ran
`sudo bash install.sh` (to create `user-01`..`user-20`) *and* restarted the server process —
`git pull` alone doesn't reload a running `node server.js`, and a browser will often cache the
old page until you hard-refresh.

**`dnf install docker-ce ...` fails with "Unable to find a match" on Rocky Linux, but only for
`docker-ce`/`docker-ce-cli`/`docker-ce-rootless-extras`** (`containerd.io` and the plugins
install fine) — Docker's own `https://download.docker.com/linux/rocky/` repo tree genuinely
doesn't publish those three packages, only `containerd.io` and the buildx/compose/model
plugins. Since Rocky, Alma, and RHEL 9 are all ABI-compatible EL9 rebuilds, `install.sh` points
at Docker's `linux/centos/` tree instead on rpm-family distros, which does carry `el9` builds of
the missing packages. If Docker still can't install (e.g. a genuinely unsupported distro/arch),
that's reported as a warning and the rest of `install.sh` (kubectl, SSH, pwquality, lab
accounts) still completes — a single provisioning step failing no longer aborts the whole
script.

---

## Notes

- xterm.js assets are served locally from `node_modules` (no CDN), so the tool works offline
  once installed.
- Command syntax for **openclaw** follows `docs.openclaw.ai/cli`; **openshell** follows the
  NVIDIA docs (`openshell --help` is authoritative). Both move fast — treat the atlas as a map
  and verify flags against upstream.
- The atlas content is identical to the standalone sheets; this build adds the terminal layer.
