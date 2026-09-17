# pi-gui verification map

Choose proof by product importance and affected behavior. Core conversation coverage comes first; opening peripheral screens is not sufficient proof of this app.

## Baseline preconditions

Build the current checkout. Use a visible, focused Electron process with test mode unset and an isolated profile/workspace. Real-provider proof requires an explicit auth source, provider, and model. Missing authentication is a blocker. Run the doctor before driving and serialize foreground input/build ownership.

## Driving conventions

The parent skill documents the default `scripts/prove.sh` conversation command and the separate `--smoke` UI check. Drive mutations through buttons, keyboard, and composer input; use DOM/state reads only for observation. No session-creation IPC, synthetic assistant events, or seeded transcripts in core conversation proof. The scratch workspace and initial model configuration are setup fixtures, not UI proof of those setup paths.

## Proof and skip reporting

Record exact feature/entry point, command, result and evidence directory. `completed` in progress/result JSON means a checkpoint was reached; inspect `assertionFailures` as well. Soft draft assertions retain failures while allowing later paths to run; any such failure makes the whole test fail. A map is coverage intent, not a list of passed tests. Each run's result/progress files state the checkpoints actually exercised. A failed or skipped core flow cannot be replaced by a passing settings check. Distinguish navigation to a surface from functional proof on it. Preserve evidence through cleanup.

## Features, in priority order

| Priority | Feature | Executable coverage |
| --- | --- | --- |
| Core | [Conversations](conversations.md) | Default real-provider proof: send, streaming, completion, tool, stop |
| Core | [Thread continuity](thread-continuity.md) | Default proof: switch while running, isolation, background completion, drafts, restart, archive/restore |
| Next | [Queued follow-ups and steering](follow-ups.md) | Existing real-auth recipe; separate, not in default proof |
| Next | [Folders and threads](navigation.md) | Sidebar/shortcut/native-folder recipes; setup fixture is not picker proof |
| Next | [Archive and restore](archive.md) | Default proof on a real conversation; core spec adds hover/group checks |
| Supporting | [Settings](settings.md) | `--smoke`: visible navigation and preference restart |
| Supporting | [Skills](skills.md) | `--smoke` covers opening only; separate recipe tests Try and aliases |
| Supporting | [Worktrees](worktrees.md) | Separate scratch-Git recipe; not in default proof |

Packaged-app launch, native dialogs/clipboard, model/account onboarding, attachments, file/diff/terminal interaction, and broader extension behavior require separate mapped journeys as those features are changed. Do not claim full-app coverage from this initial map.

## Latest observed proof (2026-09-17)

- `run-t8uKWJ` (this branch, after dropping Electron `recordVideo`): doctor passed on a visible development Electron window with test mode/hooks absent and the renderer document focused. New thread → Start thread sent a real `openai-codex` / `gpt-5.6-luna` prompt. The composer and thread row showed `No API key for provider: openai-codex`. Saved oauth access tokens for openai-codex, anthropic, and xai in `$HOME/.pi/agent/auth.json` are expired. `stream-samples.json` is empty. Not a conversation pass.
- Same-day launch failures `run-3TX38D`, `run-aoYczc`, and `run-5nTilg` were harness/environment issues (Playwright Electron `recordVideo` stalling `loadURL`, then native `isFocused()` false). They are not conversation proof.
- Prior `run-jT6s7v` (2026-09-16): a real openai-codex/gpt-5.6-luna request sent, assistant text grew while running, and the response completed. The run then failed because Alpha's draft was empty after creating Bravo and switching back.
- Prior `run-Y5MlNp`: anthropic configuration reached Send but displayed No API key for provider.
- Prior `run-zH4Jq1`: secondary visible settings/navigation smoke passed.

Evidence directories are under `.artifacts/verify-pi-gui/`. These are point-in-time observations of the checkout used; re-run after moving the skill to another branch.
