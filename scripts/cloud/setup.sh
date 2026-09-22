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

# Virtual display and the shared libraries Electron needs on Ubuntu 24.04.
export DEBIAN_FRONTEND=noninteractive
# The image ships extra PPAs (deadsnakes, ondrej/php) that the Custom network
# allowlist blocks, so apt-get update exits 100 even though the Ubuntu indexes
# download. Tolerate that; a missing package still fails the install below.
apt-get update -q || true
apt-get install -y -q --no-install-recommends \
  xvfb xauth dbus-x11 fonts-liberation \
  libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libgbm1 \
  libgtk-3-0t64 libasound2t64 libxss1 libxkbcommon0 libxcomposite1 \
  libxdamage1 libxrandr2 libxtst6 libpango-1.0-0 libcairo2 libsecret-1-0

# pi-gui requires Node >=22.19. Install a newer Node 22 into /usr/local if the
# image's default is older.
current=$(node -p 'process.versions.node' 2>/dev/null || echo 0.0.0)
if [ "$(printf '%s\n%s\n' "$NODE_MIN" "$current" | sort -V | head -1)" != "$NODE_MIN" ]; then
  arch=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')
  base=https://nodejs.org/dist/latest-v22.x
  tarball=$(curl -fsSL "$base/SHASUMS256.txt" | awk -v a="linux-$arch.tar.xz" '$2 ~ a"$" {print $2}')
  curl -fsSL "$base/$tarball" | tar -xJ -C /usr/local --strip-components=1
  ln -sf /usr/local/bin/node /usr/bin/node
fi

npm install -g "pnpm@$PNPM_VERSION"
node --version
pnpm --version
