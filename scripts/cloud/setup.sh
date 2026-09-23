#!/bin/bash
# Claude cloud environment setup script for pi-gui.
# Paste this file's contents into the environment's "Setup script" field.
# It runs as root on Ubuntu 24.04 before Claude Code starts, and its result is
# cached as a filesystem snapshot for about seven days. Never write credentials
# here: they would be baked into the snapshot. scripts/cloud/session-start.sh
# writes auth at every session start instead.
set -euo pipefail

NODE_MIN=22.19.0
PNPM_VERSION=10.25.0

# Virtual display with a minimal window manager (X11 maximize is a request only
# a window manager answers), the shared libraries Electron needs on Ubuntu
# 24.04, libnotify so Electron reports desktop notifications as supported, and
# ffmpeg so agents can record the display as video proof of UI changes.
export DEBIAN_FRONTEND=noninteractive
# The image ships extra PPAs (deadsnakes, ondrej/php) that the Custom network
# allowlist blocks, so apt-get update exits 100 even though the Ubuntu indexes
# download. Tolerate that; a missing package still fails the install below.
apt-get update -q || true
apt-get install -y -q --no-install-recommends \
  xvfb xauth dbus-x11 openbox fonts-liberation \
  libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libgbm1 \
  libgtk-3-0t64 libasound2t64 libxss1 libxkbcommon0 libxcomposite1 \
  libxdamage1 libxrandr2 libxtst6 libpango-1.0-0 libcairo2 libsecret-1-0 \
  libnotify4 ffmpeg

# pi-gui requires Node >=22.19. The image has several Node installs and its
# /usr/local/bin/node points at Node 20, so pin one satisfying install at
# /opt/pi-node. session-start.sh puts /opt/pi-node/bin first on PATH.
node_ok() {
  v=$("$1" -p 'process.versions.node' 2>/dev/null) || return 1
  [ "$(printf '%s\n%s\n' "$NODE_MIN" "$v" | sort -V | head -1)" = "$NODE_MIN" ] && [ "${v%%.*}" -lt 26 ]
}
if node_ok /opt/node22/bin/node; then
  ln -sfn /opt/node22 /opt/pi-node
else
  arch=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')
  base=https://nodejs.org/dist/latest-v22.x
  tarball=$(curl -fsSL "$base/SHASUMS256.txt" | awk -v a="linux-$arch.tar.xz" '$2 ~ a"$" {print $2}')
  rm -rf /opt/pi-node && mkdir -p /opt/pi-node
  curl -fsSL "$base/$tarball" | tar -xJ -C /opt/pi-node --strip-components=1
fi
node_ok /opt/pi-node/bin/node

export PATH=/opt/pi-node/bin:$PATH
npm install -g "pnpm@$PNPM_VERSION"
node --version
pnpm --version
