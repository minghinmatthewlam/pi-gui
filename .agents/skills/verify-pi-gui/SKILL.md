---
name: verify-pi-gui
description: "Verify pi-gui's core conversation flows through visible Electron UI with a real provider: sending, streaming, thread switching, tools, stop, drafts and restart. Use for desktop user-flow verification; includes a separate settings smoke and a prioritized feature map."
---

# Verify pi-gui

Read [features/README.md](features/README.md) before choosing coverage. Conversation behavior is the primary proof. A passing settings/navigation smoke does not establish that the app can send or stream a message. Use the existing `apps/desktop/tests/helpers/electron-app.ts` launcher; the skill supplies UI recipes and evidence capture, not a second app implementation.

## Launch

Run from the repository root with dependencies installed (Node >=22.19.0 <26, pnpm 10.25.0; setup is `pnpm install --frozen-lockfile`). The default command is the real-provider conversation proof:

```sh
PI_APP_REAL_AUTH=1 \
PI_APP_REAL_AUTH_SOURCE_DIR="$HOME/.pi/agent" \
PI_GUI_PROVIDER=openai-codex \
PI_GUI_MODEL=gpt-5.6-luna \
.agents/skills/verify-pi-gui/scripts/prove.sh
```

Use a provider/model actually configured for this user; those example values are not a guarantee of usable authentication. The explicit environment opts into real requests and usage. Missing configuration exits 2 before build; invalid credentials fail the run. Never silently skip core proof or substitute fake auth. Custom endpoints that require `models.json` are not supported by this initial recipe; use a configured built-in provider or extend the credential/config setup deliberately.

For the secondary no-provider settings/navigation proof:

```sh
.agents/skills/verify-pi-gui/scripts/prove.sh --smoke
```

Both commands build first, show and focus Electron with `PI_APP_TEST_MODE` removed, and retain a unique `.artifacts/verify-pi-gui/run-XXXXXX/`. Build failure blocks launch; do not reuse stale output. On this host the full Xcode selection can block `git`/`swiftc` on its license. An already working Command Line Tools installation can be selected per invocation with `DEVELOPER_DIR=/Library/Developer/CommandLineTools`; verify `xcrun --find swiftc` under that environment first. Do not accept licenses or change global developer settings for the user.

Each run uses a scratch workspace and isolated profile. The conversation proof copies only the selected provider credentials into a mode-0700 private temporary directory outside the evidence tree, with a mode-0600 auth file. It creates a minimal model configuration there once and reuses it across restart. It does not modify the source profile. Do not publish the private directory or credentials. Separate profiles prevent history collision, but build output and foreground input are shared: serialize runs and do not drive the user's installed app.

## Doctor

On each launch, focus the owned app and perform the recipe's read-only identity checks: app path resolves to this checkout's `apps/desktop`, userData equals this run's profile, native window is visible and focused, test mode is absent, and main-process test hooks are absent. `firstWindow()` waits for DOM load and the preload bridge. Doctor JSON records actual paths and PID. Successful sending validates usable authentication; a configured provider name alone does not.

If launch fails or auth is rejected, capture the error and stop that attempt. A map entry and a build are not runtime proof.

## Drive

The default `conversation.spec.ts` drives [conversations](features/conversations.md) and [thread continuity](features/thread-continuity.md):

1. Click New thread, enter Alpha's prompt, click Start thread. Observe assistant text growing while the row reports running, then the final assistant marker and completion.
2. Create Bravo through the same UI. Its real shell tool writes a marker file and briefly waits. Select Alpha while Bravo runs; verify Alpha's text/draft and Bravo's continuing status. Let Bravo complete while Alpha is selected.
3. Select Bravo, inspect the assistant result and expanded tool output, and compare the actual file on disk.
4. Send a follow-up through the composer, observe assistant output, click Stop run, and verify the run stops. Check distinct drafts by switching both ways.
5. Archive/restore Bravo through sidebar controls. Restart the app, select both conversations, and verify transcripts and drafts.

`proof.spec.ts`, selected only by `--smoke`, clicks Settings sections, opens Skills and New thread, and verifies a preference after restart. Neither recipe creates sessions through IPC or injects assistant events. The model configuration and scratch workspace are launch fixtures; they do not prove account onboarding or native folder opening.

Playwright sends input to the real renderer; it does not move the desktop pointer. Native pickers, clipboard, permissions and OS switching need a native/Computer Use journey. The launcher uses the development Electron binary with freshly built app code, not a packaged installation. Read the feature map for other required entry points. [Queued follow-ups](features/follow-ups.md), worktrees, and native/package paths have separate coverage; do not imply they passed with the default proof.

For product changes, use `apps/desktop/tests/AGENTS.md` and the current package scripts to choose additional regression lanes. Existing core/live specs may contain IPC fixtures or injected events; inspect them before treating them as real conversation proof.

## Evidence

The helper prints the evidence directory. Conversation runs retain doctor JSON, screenshots and ARIA at each checkpoint, timestamped assistant streaming samples, videos, action traces, tool output file, build/run logs, exit code, progress/result JSON, and cleanup records. Inspect assistant-only content so a prompt containing the expected answer cannot make the test pass. Streaming requires observed growth during a run; a completed answer alone is insufficient. Persistence requires a second process using the same profile. Tool proof needs both visible output and the file side effect.

Open the actual `conversation.zip` or `restart.zip` from the printed directory with `pnpm exec playwright show-trace`. The settings smoke instead uses `change.zip` and `restart.zip`. Inspect screenshots/video as well as assertions. Keep credentials outside artifacts shared with reviewers; trace source includes test code and prompts, so use synthetic prompts only.

This is not a dry-run: conversation mode contacts the configured provider, consumes usage, creates session files, and runs the specified scratch-workspace tool command. Report exact completed checkpoints and any failure. Never present a partial/blocked run as a full pass.

## Cleanup

Both recipes close only their owned Electron applications in `finally`, including assertion/trace failures, and record the PIDs in `cleanup.json`. Confirm those processes exited and the proof artifacts still exist. For launch failure, inspect Playwright's teardown/error; terminate only a verified owned PID if stranded, never by process name.

Root `AGENTS.md` prohibits deleting temporary artifacts without approval. Retain scratch state and the private profile; do not put that private credential-bearing directory into shared evidence. Request explicit cleanup authorization before deleting retained private state. Process teardown still completes on every attempted run.

## Helpers

- `scripts/prove.sh [--conversation|--smoke]`: executable CLI; default is conversation. Builds, allocates artifacts, runs the chosen recipe, preserves exit status, checks retained proof.
- `scripts/conversation.spec.ts`: default real-provider user journey.
- `scripts/proof.spec.ts`: secondary no-provider UI smoke.
- `scripts/playwright.config.ts`: inherits repo defaults, selects these recipes, disables retries.

Use `$maintain-verification-skill` to keep the map and live recipes aligned with the app.
