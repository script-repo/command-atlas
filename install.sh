#!/usr/bin/env bash
# ==============================================================================
# Command Atlas — fresh-system installer (Debian/Ubuntu and RHEL/Rocky/Fedora)
# https://github.com/script-repo/command-atlas
#
# Installs everything a brand-new Linux box needs to run the multi-user
# terminal backend: git, Node.js, native build tools, PAM dev headers, then
# the npm dependencies (which compile node-pty + authenticate-pam).
#
# Also provisions the box for lab use:
#   • relaxes PAM password-quality policy (minlen 8) in /etc/security/pwquality.conf
#   • enables remote SSH with local-account password (PAM) auth
#   • installs kubectl + Docker Engine
#   • creates local lab accounts user-01..user-20, in the docker group, with
#     password $ATLAS_DEFAULT_PASSWORD (or a random one generated + printed
#     once if unset)
#
# Auto-detects the package manager (apt-get, dnf, or yum), so the same
# command works on Ubuntu/Debian as well as Rocky Linux/RHEL/Fedora.
#
# Usage:
#   git clone https://github.com/script-repo/command-atlas.git
#   cd command-atlas && sudo bash install.sh
# ==============================================================================
set -euo pipefail

NODE_MAJOR="${NODE_MAJOR:-20}"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "error: Command Atlas requires Linux (PAM + /bin/login are Linux-only)." >&2
  exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "error: run this installer as root, e.g.:  sudo bash install.sh" >&2
  exit 1
fi

if command -v apt-get >/dev/null 2>&1; then
  PKG_FAMILY=deb
elif command -v dnf >/dev/null 2>&1; then
  PKG_FAMILY=rpm
  PKG_MGR=dnf
elif command -v yum >/dev/null 2>&1; then
  PKG_FAMILY=rpm
  PKG_MGR=yum
else
  echo "error: no supported package manager found (need apt-get, dnf, or yum)." >&2
  echo "       see README.md's Prerequisites section to install the packages by hand." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

node_major_installed() {
  command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' 2>/dev/null
}

if [[ "$PKG_FAMILY" == deb ]]; then
  export DEBIAN_FRONTEND=noninteractive

  echo "==> Updating package index"
  apt-get update -y

  echo "==> Installing git, build tools + PAM headers (build-essential, python3, libpam0g-dev)"
  apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg git build-essential python3 libpam0g-dev

  CURRENT_NODE_MAJOR="$(node_major_installed || true)"
  if [[ -z "$CURRENT_NODE_MAJOR" || "$CURRENT_NODE_MAJOR" -lt 18 ]]; then
    echo "==> Installing Node.js ${NODE_MAJOR}.x (via NodeSource)"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    apt-get install -y nodejs
  else
    echo "==> Node.js $(node -v) already installed (>= 18), skipping"
  fi

else # rpm family: Rocky Linux, RHEL, CentOS, Fedora
  echo "==> Installing git, build tools + PAM headers (gcc-c++, make, python3, pam-devel)"
  "$PKG_MGR" install -y \
    ca-certificates curl gnupg2 git gcc gcc-c++ make python3 pam-devel

  CURRENT_NODE_MAJOR="$(node_major_installed || true)"
  if [[ -z "$CURRENT_NODE_MAJOR" || "$CURRENT_NODE_MAJOR" -lt 18 ]]; then
    echo "==> Installing Node.js ${NODE_MAJOR}.x (via NodeSource)"
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    "$PKG_MGR" install -y nodejs
  else
    echo "==> Node.js $(node -v) already installed (>= 18), skipping"
  fi
fi

echo "==> Installing npm dependencies (this compiles node-pty and authenticate-pam)"
npm install --no-fund --no-audit

# ------------------------------------------------------------------------------
# From here on, each provisioning step is independent lab-host setup, not core
# to running Command Atlas itself. `set -e` is still on for the whole script,
# so each step below is wrapped in a function and called through `run_step`,
# which reports failures instead of letting one bad step (e.g. Docker's repo
# being excluded on a Kubernetes-managed node) abort everything after it —
# npm/native-module installation above still fails the script normally.
# ------------------------------------------------------------------------------
run_step() {
  local desc="$1"; shift
  echo "==> $desc"
  if ! "$@"; then
    echo "    ⚠ warning: '$desc' failed — continuing with the rest of the install." >&2
  fi
}

DOCKER_GROUP_USER=""

# Lower the local password-quality floor to 8 characters.
#
# /etc/security/pwquality.conf is the same path/format on both Debian/Ubuntu
# (libpam-pwquality) and RHEL-family (pwquality) — no distro branching needed.
# Handles: an active `minlen = N` line, a commented-out one, or the file not
# existing at all yet.
provision_pwquality() {
  local conf=/etc/security/pwquality.conf
  touch "$conf"
  if grep -qE '^\s*#?\s*minlen\s*=' "$conf"; then
    sed -i -E 's/^\s*#?\s*minlen\s*=.*/minlen = 8/' "$conf"
  else
    echo 'minlen = 8' >> "$conf"
  fi
}

# Enable remote SSH access with local-account password auth (PAM-backed).
#
# Ubuntu cloud images (and some hardened Rocky images) ship a drop-in under
# /etc/ssh/sshd_config.d/ that forces `PasswordAuthentication no`. sshd uses
# the FIRST value it reads for a keyword, and `Include` directives are
# processed in place — so a same-named drop-in that sorts before the others
# (00-*) wins even against later conflicting drop-ins, as long as the
# `Include` line itself is early in sshd_config (it is, by default, on both
# distros). We add our own 00- file rather than editing vendor drop-ins in
# place, so distro package updates won't silently revert this.
provision_ssh() {
  local sshd_service
  if [[ "$PKG_FAMILY" == deb ]]; then
    apt-get install -y --no-install-recommends openssh-server || return 1
    sshd_service=ssh
  else
    "$PKG_MGR" install -y openssh-server || return 1
    sshd_service=sshd
  fi

  mkdir -p /etc/ssh/sshd_config.d
  if ! grep -qE '^\s*Include\s+/etc/ssh/sshd_config\.d/\*\.conf' /etc/ssh/sshd_config 2>/dev/null; then
    { echo "Include /etc/ssh/sshd_config.d/*.conf"; cat /etc/ssh/sshd_config 2>/dev/null; } > /etc/ssh/sshd_config.tmp
    mv /etc/ssh/sshd_config.tmp /etc/ssh/sshd_config
  fi
  cat > /etc/ssh/sshd_config.d/00-command-atlas.conf <<'EOF'
# Managed by command-atlas install.sh — do not hand-edit, re-run install.sh instead.
PasswordAuthentication yes
UsePAM yes
EOF

  systemctl enable --now "$sshd_service" 2>/dev/null || true
  systemctl reload "$sshd_service" 2>/dev/null || systemctl restart "$sshd_service" 2>/dev/null || true

  if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld 2>/dev/null; then
    firewall-cmd --permanent --add-service=ssh >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null 2>&1 || true
  elif command -v ufw >/dev/null 2>&1; then
    ufw allow OpenSSH >/dev/null 2>&1 || ufw allow ssh >/dev/null 2>&1 || true
  fi
}

# kubectl — static binary from the official Kubernetes release channel.
# Same download works unmodified on both Debian/Ubuntu and RHEL/Rocky.
provision_kubectl() {
  if command -v kubectl >/dev/null 2>&1; then
    echo "    kubectl already installed ($(kubectl version --client 2>/dev/null | head -1 || true)), skipping"
    return 0
  fi
  local arch
  arch="$(uname -m)"
  case "$arch" in
    x86_64)  arch=amd64 ;;
    aarch64) arch=arm64 ;;
  esac
  local version
  version="$(curl -fsSL https://dl.k8s.io/release/stable.txt)" || return 1
  curl -fsSL -o /usr/local/bin/kubectl \
    "https://dl.k8s.io/release/${version}/bin/linux/${arch}/kubectl" || return 1
  chmod +x /usr/local/bin/kubectl
}

# Docker Engine.
#
# On Debian/Ubuntu, get.docker.com's own dist-detection is reliable — use it
# as-is. On RHEL-family, get.docker.com's Rocky/Alma detection points dnf at
# https://download.docker.com/linux/rocky/, whose Packages/ directory does
# not (as of writing) actually publish docker-ce, docker-ce-cli, or
# docker-ce-rootless-extras — only containerd.io and the plugins. That's a
# real gap in what Docker ships there, not a config/exclude problem. Rocky,
# Alma, and RHEL 9 are all ABI-compatible EL9 rebuilds, so we point straight
# at Docker's centos/9 tree instead, which does carry the engine packages
# (as `el9` RPMs, same as Rocky's).
provision_docker() {
  if command -v docker >/dev/null 2>&1; then
    echo "    Docker already installed ($(docker --version 2>/dev/null || true)), skipping"
    return 0
  fi

  if [[ "$PKG_FAMILY" == deb ]]; then
    curl -fsSL https://get.docker.com | sh || return 1
  else
    if [[ "$PKG_MGR" == dnf ]]; then
      dnf install -y dnf-plugins-core || return 1
      rm -f /etc/yum.repos.d/docker-ce.repo /etc/yum.repos.d/docker-ce-staging.repo
      dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo || return 1
      dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin \
        docker-ce-rootless-extras docker-buildx-plugin || return 1
    else
      yum install -y yum-utils || return 1
      rm -f /etc/yum.repos.d/docker-ce.repo /etc/yum.repos.d/docker-ce-staging.repo
      yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo || return 1
      yum install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin \
        docker-ce-rootless-extras docker-buildx-plugin || return 1
    fi
  fi
  systemctl enable --now docker 2>/dev/null || true

  # The docker socket is root:docker 660 — only root or the `docker` group
  # can use `docker` without sudo. Add whoever actually ran
  # `sudo bash install.sh` (the operator, e.g. nutanix) to that group; takes
  # effect on their next login/shell (or `newgrp docker` in the current one).
  if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != root ]] && id "$SUDO_USER" >/dev/null 2>&1; then
    usermod -aG docker "$SUDO_USER" || true
    DOCKER_GROUP_USER="$SUDO_USER"
  fi
}

run_step "Relaxing PAM password-quality policy (minlen -> 8) in /etc/security/pwquality.conf" provision_pwquality
run_step "Enabling SSH remote access with local-account password (PAM) authentication" provision_ssh
run_step "Installing kubectl" provision_kubectl
run_step "Installing Docker Engine" provision_docker

# ------------------------------------------------------------------------------
# Lab accounts user-01..user-20.
#
# Password is only ever SET at account-creation time — re-running install.sh
# (e.g. for the `git pull && sudo bash install.sh` update workflow) never
# resets a password someone already changed via the app's "reset all default
# pw" button or their own `passwd`. Set ATLAS_DEFAULT_PASSWORD before running
# this script to control the initial password; otherwise a random one is
# generated and printed once below (never written to this repo).
# ------------------------------------------------------------------------------
DEFAULT_PASSWORD="${ATLAS_DEFAULT_PASSWORD:-}"
GENERATED_PASSWORD=0
if [[ -z "$DEFAULT_PASSWORD" ]]; then
  DEFAULT_PASSWORD="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16)"
  GENERATED_PASSWORD=1
fi

CREATED_USERS=()
provision_lab_users() {
  local u ok=0 has_docker_group=1
  getent group docker >/dev/null 2>&1 && has_docker_group=0
  for i in $(seq -w 1 20); do
    u="user-$i"
    if ! id "$u" >/dev/null 2>&1; then
      if useradd -m -s /bin/bash "$u" && echo "$u:$DEFAULT_PASSWORD" | chpasswd; then
        CREATED_USERS+=("$u")
      else
        echo "    ⚠ warning: failed to create/set password for $u — continuing" >&2
        ok=1
        continue
      fi
    fi
    # Retroactive too, so a re-run after Docker installs successfully still
    # grants it to lab accounts created on an earlier run.
    if [[ "$has_docker_group" -eq 0 ]]; then
      usermod -aG docker "$u" || true
    fi
  done
  return "$ok"
}
run_step "Ensuring lab accounts user-01..user-20 exist (+ docker group)" provision_lab_users

cat <<'EOF'

------------------------------------------------------------
 Command Atlas is installed.

 Start it with:
   sudo npm start

 Then open http://<this-host>:7420/ and sign in with a real
 local account on this machine.
------------------------------------------------------------
EOF

if [[ -n "$DOCKER_GROUP_USER" ]]; then
  echo " Added '$DOCKER_GROUP_USER' to the docker group so 'docker' works"
  echo " without sudo. Log out and back in (or run: newgrp docker) for it"
  echo " to take effect in this shell."
  echo "------------------------------------------------------------"
fi

if [[ "${#CREATED_USERS[@]}" -gt 0 ]]; then
  echo " Created ${#CREATED_USERS[@]} new lab account(s): ${CREATED_USERS[*]}"
  if [[ "$GENERATED_PASSWORD" -eq 1 ]]; then
    echo " Initial password (randomly generated, shown once — save it now):"
    echo "   $DEFAULT_PASSWORD"
  else
    echo " Initial password: the value of ATLAS_DEFAULT_PASSWORD you supplied."
  fi
  echo " The 'reset all default pw' button in the app (visible to the nutanix"
  echo " user) can change this for all of them later without re-running install.sh."
  echo "------------------------------------------------------------"
fi
