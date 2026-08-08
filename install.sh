#!/usr/bin/env bash
# ==============================================================================
# Command Atlas — fresh-system installer (Debian/Ubuntu and RHEL/Rocky/Fedora)
# https://github.com/script-repo/command-atlas
#
# Installs everything a brand-new Linux box needs to run the multi-user
# terminal backend: git, Node.js, native build tools, PAM dev headers, then
# the npm dependencies (which compile node-pty + authenticate-pam).
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

cat <<'EOF'

------------------------------------------------------------
 Command Atlas is installed.

 Start it with:
   sudo npm start

 Then open http://<this-host>:7420/ and sign in with a real
 local account on this machine.
------------------------------------------------------------
EOF
