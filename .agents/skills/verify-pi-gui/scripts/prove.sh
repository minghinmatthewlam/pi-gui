#!/bin/sh
set -eu
cd "$(dirname "$0")/../../../.."
case "${1:-}" in
  ""|--conversation) spec=conversation.spec.ts ;;
  --smoke) spec=proof.spec.ts ;;
  --maintenance) spec=maintenance.spec.ts ;;
  *) printf 'Usage: %s [--conversation|--smoke|--maintenance]\n' "$0" >&2; exit 2 ;;
esac
# Headless Linux (cloud sessions, containers) has no display for Electron.
if [ "$(uname -s)" = Linux ] && [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && [ -z "${PI_GUI_PROVE_XVFB:-}" ] && command -v xvfb-run >/dev/null; then
  export PI_GUI_PROVE_XVFB=1
  set -- "$PWD/.agents/skills/verify-pi-gui/scripts/prove.sh" "$@"
  if command -v dbus-run-session >/dev/null; then set -- dbus-run-session -- "$@"; fi
  exec xvfb-run -a --server-args="-screen 0 1600x1000x24" "$@"
fi
mkdir -p .artifacts/verify-pi-gui
PI_GUI_PROOF_DIR=$(mktemp -d "$PWD/.artifacts/verify-pi-gui/run-XXXXXX")
export PI_GUI_PROOF_DIR
printf 'Evidence: %s\n' "$PI_GUI_PROOF_DIR"
if [ "$spec" = conversation.spec.ts ] || [ "$spec" = maintenance.spec.ts ]; then
  if [ "${PI_APP_REAL_AUTH:-}" != 1 ] || [ -z "${PI_APP_REAL_AUTH_SOURCE_DIR:-}" ] || [ -z "${PI_GUI_PROVIDER:-}" ] || [ -z "${PI_GUI_MODEL:-}" ]; then
    printf '%s\n' 'BLOCKED: set PI_APP_REAL_AUTH=1, PI_APP_REAL_AUTH_SOURCE_DIR, PI_GUI_PROVIDER and PI_GUI_MODEL. Use --smoke only for the secondary no-provider UI check.' >"$PI_GUI_PROOF_DIR/run.log"
    cat "$PI_GUI_PROOF_DIR/run.log"
    printf '2\n' >"$PI_GUI_PROOF_DIR/exit-code.txt"
    printf '%s\n' '{"result":"blocked","reason":"Missing explicit real-auth source, provider or model"}' >"$PI_GUI_PROOF_DIR/result.json"
    exit 2
  fi
fi
if pnpm --filter @pi-gui/desktop run build >"$PI_GUI_PROOF_DIR/build.log" 2>&1; then
  :
else
  cat "$PI_GUI_PROOF_DIR/build.log"
  exit 1
fi
set +e
pnpm exec playwright test -c .agents/skills/verify-pi-gui/scripts/playwright.config.ts "$spec" --output "$PI_GUI_PROOF_DIR/playwright" --reporter=line >"$PI_GUI_PROOF_DIR/run.log" 2>&1
result=$?
set -e
cat "$PI_GUI_PROOF_DIR/run.log"
printf '%s\n' "$result" >"$PI_GUI_PROOF_DIR/exit-code.txt"
# The spec closes only its own Electron applications, even on assertion failure.
# Keep profile/workspace too: repo policy forbids deleting temp artifacts without approval.
if [ "$result" -eq 0 ]; then
  test -s "$PI_GUI_PROOF_DIR/result.json"
  test -s "$PI_GUI_PROOF_DIR/cleanup.json"
  if [ "$spec" = conversation.spec.ts ]; then
    test -s "$PI_GUI_PROOF_DIR/restart-bravo.png"
    test -s "$PI_GUI_PROOF_DIR/stream-samples.json"
    test -s "$PI_GUI_PROOF_DIR/restart.zip"
  elif [ "$spec" = maintenance.spec.ts ]; then
    test -s "$PI_GUI_PROOF_DIR/skills-try.png"
    test -s "$PI_GUI_PROOF_DIR/navigation-thread-cap.png"
    test -s "$PI_GUI_PROOF_DIR/worktree.png"
    test -s "$PI_GUI_PROOF_DIR/worktree-git.json"
    test -s "$PI_GUI_PROOF_DIR/follow-up-idle.png"
    test -s "$PI_GUI_PROOF_DIR/follow-ups.zip"
  else
    test -s "$PI_GUI_PROOF_DIR/restart.png"
    test -s "$PI_GUI_PROOF_DIR/restart.zip"
  fi
fi
printf 'Retained evidence: %s\n' "$PI_GUI_PROOF_DIR"
exit "$result"
