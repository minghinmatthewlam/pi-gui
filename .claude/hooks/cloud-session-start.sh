#!/bin/bash
# Claude Code cloud sessions start from a fresh clone; install dependencies so
# checks and verify-pi-gui can run without a manual setup step. Local sessions
# are left alone.
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "$CLAUDE_PROJECT_DIR"
[ -d node_modules ] || pnpm install --frozen-lockfile >&2
