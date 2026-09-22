#!/bin/bash
# SessionStart hook for Claude cloud sessions (see .claude/settings.json).
# Local sessions exit immediately. In the cloud it:
#   1. writes ~/.pi/agent/auth.json from the PI_AUTH_JSON_B64 environment
#      variable, without printing it, unless an auth file already exists;
#   2. starts a virtual X display for Electron;
#   3. exports the verify-pi-gui real-auth defaults for later shell commands.
# Credentials never go in the setup script, which is cached as a snapshot.
set -uo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

agent_dir="$HOME/.pi/agent"
auth="$agent_dir/auth.json"
umask 077
mkdir -p "$agent_dir"

if [ -s "$auth" ]; then
  echo "pi auth: keeping existing $auth"
elif [ -n "${PI_AUTH_JSON_B64:-}" ]; then
  tmp=$(mktemp "$agent_dir/auth.XXXXXX")
  if printf '%s' "$PI_AUTH_JSON_B64" | base64 -d >"$tmp" 2>/dev/null && jq -e 'type == "object"' "$tmp" >/dev/null 2>&1; then
    mv "$tmp" "$auth"
    echo "pi auth: wrote $auth with providers $(jq -c 'keys' "$auth")"
  else
    rm -f "$tmp"
    echo "pi auth: PI_AUTH_JSON_B64 is not base64-encoded JSON; no auth written" >&2
  fi
else
  echo "pi auth: PI_AUTH_JSON_B64 is not set; real-auth proofs will exit 2"
fi

display=:99
if ! pgrep -x Xvfb >/dev/null 2>&1; then
  if command -v Xvfb >/dev/null 2>&1; then
    nohup Xvfb "$display" -screen 0 1920x1080x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
    echo "display: started Xvfb on $display"
  else
    echo "display: Xvfb missing; paste scripts/cloud/setup.sh into the environment setup script" >&2
  fi
fi

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    # setup.sh pins a Node >=22.19 install at /opt/pi-node.
    [ -x /opt/pi-node/bin/node ] && echo "export PATH=/opt/pi-node/bin:\$PATH"
    echo "export DISPLAY=$display"
    echo "export PI_APP_REAL_AUTH=\${PI_APP_REAL_AUTH:-1}"
    echo "export PI_APP_REAL_AUTH_SOURCE_DIR=\${PI_APP_REAL_AUTH_SOURCE_DIR:-$agent_dir}"
    echo "export PI_GUI_PROVIDER=\${PI_GUI_PROVIDER:-openai-codex}"
    echo "export PI_GUI_MODEL=\${PI_GUI_MODEL:-gpt-5.6-luna}"
  } >>"$CLAUDE_ENV_FILE"
fi
exit 0
