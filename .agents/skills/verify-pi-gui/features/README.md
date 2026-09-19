# pi-gui verification map

Choose proof by product importance and affected behavior. Core conversation coverage comes first; opening peripheral screens is not sufficient proof of this app.

## Baseline preconditions

Build the current checkout. Use a visible, focused Electron process with test mode unset and an isolated profile/workspace. Real-provider proof requires an explicit auth source, provider, and model. Missing authentication is a blocker. Run the doctor before driving and serialize foreground input/build ownership.

## Driving conventions

The parent skill documents the default `scripts/prove.sh` conversation command and the separate `--smoke` UI check. Drive mutations through buttons, keyboard, and composer input; use DOM/state reads only for observation. No session-creation IPC, synthetic assistant events, or seeded transcripts in core conversation proof. The scratch workspace and initial model configuration are setup fixtures, not UI proof of those setup paths.

## Proof and skip reporting

Record exact feature/entry point, command, result and evidence directory. `completed` in progress/result JSON means a checkpoint was reached; inspect `assertionFailures` as well. Soft draft assertions retain failures while allowing later paths to run; any such failure makes the whole test fail. A map is coverage intent, not a list of passed tests. Each run's result/progress files state the checkpoints actually exercised. A failed or skipped core flow cannot be replaced by a passing settings check. Distinguish navigation to a surface from functional proof on it. Preserve evidence through cleanup.

## Features, in priority order

| Priority   | Feature                                         | Executable coverage                                                                                     |
| ---------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Core       | [Conversations](conversations.md)               | Default real-provider proof: send, streaming, completion, tool, stop                                    |
| Core       | [Thread continuity](thread-continuity.md)       | Default proof: switch while running, isolation, background completion, drafts, restart, archive/restore |
| Next       | [Queued follow-ups and steering](follow-ups.md) | Existing real-auth recipe; separate, not in default proof                                               |
| Next       | [Folders and threads](navigation.md)            | Sidebar/shortcut/native-folder recipes; pin ordering, restart, and pin/unpin during a pending prompt    |
| Next       | [Archive and restore](archive.md)               | Default proof on a real conversation; core spec adds hover/group checks                                 |
| Supporting | [Settings](settings.md)                         | `--smoke`: visible navigation and preference restart                                                    |
| Supporting | [Skills](skills.md)                             | `--smoke` covers opening only; separate recipe tests Try and aliases                                    |
| Supporting | [Worktrees](worktrees.md)                       | Separate scratch-Git recipe; not in default proof                                                       |

Packaged-app launch, native dialogs/clipboard, model/account onboarding, attachments, file/diff/terminal interaction, and broader extension behavior require separate mapped journeys as those features are changed. Do not claim full-app coverage from this initial map.

## Latest observed proof (2026-09-18)

- `run-elqPTZ`: the complete openai-codex/gpt-5.6-luna conversation recipe passed after the state/window/IPC owner extraction and persistence hardening. All nine checkpoints passed, including switching during a tool run, Stop, independent drafts, archive/restore, and both conversations after restart. No assertion failures; PIDs 25552 and 25778 exited. Screenshots and tool-file evidence were inspected. This is the development Electron app; packaged launch has separate proof.
- `run-mKBpsN`: the complete real openai-codex/gpt-5.6-luna conversation recipe passed on `d73837ae`: streaming, tool output and file side effect, switching during a run, Stop, draft isolation, archive/restore, and both conversations after restart. No assertion failures; both owned Electron processes exited. This uses the development Electron binary, not the packaged app.
- Earlier runs `run-yJgXkz` and `run-IZZnQJ` exposed draft loss on New thread, Stop blocked behind the active prompt, and requested cancellation reported as failure. The fixes now have deterministic regressions; preserve those failed-run artifacts alongside the successful proof.

## Earlier observed proof (2026-09-17)

- `run-t8uKWJ` (this branch, with Electron `recordVideo` temporarily dropped): doctor passed on a visible development Electron window with test mode/hooks absent and the renderer document focused. New thread → Start thread sent a real `openai-codex` / `gpt-5.6-luna` prompt. The composer and thread row showed `No API key for provider: openai-codex`. Saved oauth access tokens for openai-codex, anthropic, and xai in `$HOME/.pi/agent/auth.json` are expired. `stream-samples.json` is empty. Not a conversation pass.
- Same-day launch failures `run-3TX38D`, `run-aoYczc`, and `run-5nTilg` were harness/environment issues (Playwright Electron `recordVideo` stalling `loadURL`, then native `isFocused()` false). They are not conversation proof.

## Earlier observed proof (2026-09-16)

- `run-jT6s7v`: a real openai-codex/gpt-5.6-luna request sent, assistant text grew while running, and the response completed. The run then failed because Alpha's draft was empty after creating Bravo and switching back. Both the draft expectation and the nonzero result remain.
- At that point, the revised recipe continued after draft assertion failures but had not completed a real run. The later September 18 runs above now cover tool completion, Stop, archive/restore, and restart.
- `run-Y5MlNp`: anthropic configuration reached Send but displayed No API key for provider; no response proof.
- `run-zH4Jq1`: earlier secondary visible settings/navigation smoke passed.

Evidence directories are under `.artifacts/verify-pi-gui/`. These are point-in-time observations of the checkout used; re-run after moving the skill to another branch.
