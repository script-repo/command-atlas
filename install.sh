#!/usr/bin/env bash
# ==============================================================================
# Command Atlas — fresh-system installer (Debian/Ubuntu)
# https://github.com/script-repo/command-atlas
#
# Installs everything a brand-new Linux box needs to run the multi-user
# terminal backend: git, Node.js, native build tools, PAM dev headers, then
# the npm dependencies (which compile node-pty + authenticate-pam).
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

if ! command -v apt-get >/dev/null 2>&1; then
  echo "error: this installer supports Debian/Ubuntu (apt-get) only." >&2
  echo "       see README.md's Prerequisites section for the RHEL/Fedora package list." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Updating package index"
apt-get update -y

echo "==> Installing git, build tools + PAM headers (build-essential, python3, libpam0g-dev)"
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg git build-essential python3 libpam0g-dev

node_major_installed() {
  command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' 2>/dev/null
}

CURRENT_NODE_MAJOR="$(node_major_installed || true)"
if [[ -z "$CURRENT_NODE_MAJOR" || "$CURRENT_NODE_MAJOR" -lt 18 ]]; then
  echo "==> Installing Node.js ${NODE_MAJOR}.x (via NodeSource)"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
else
  echo "==> Node.js $(node -v) already installed (>= 18), skipping"
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
