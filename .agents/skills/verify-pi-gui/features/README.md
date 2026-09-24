# pi-gui verification map

Choose proof by product importance and affected behavior. Core conversation coverage comes first; opening peripheral screens is not sufficient proof of this app.

## Baseline preconditions

Build the current checkout. Use a visible, focused Electron process with test mode unset and an isolated profile/workspace. Real-provider proof requires an explicit auth source, provider, and model. Missing authentication is a blocker. Run the doctor before driving and serialize foreground input/build ownership.

## Driving conventions

The parent skill documents the default `scripts/prove.sh` conversation command, `--maintenance` for the remaining mapped surfaces, and the separate `--smoke` UI check. Drive mutations through buttons, keyboard, and composer input; use DOM/state reads only for observation. No session-creation IPC, synthetic assistant events, or seeded transcripts in conversation or maintenance proof. The scratch workspace and initial model configuration are setup fixtures, not UI proof of those setup paths.

## Proof and skip reporting

Record exact feature/entry point, command, result and evidence directory. `completed` in progress/result JSON means a checkpoint was reached; inspect `assertionFailures` as well. Soft draft assertions retain failures while allowing later paths to run; any such failure makes the whole test fail. A map is coverage intent, not a list of passed tests. Each run's result/progress files state the checkpoints actually exercised. A failed or skipped core flow cannot be replaced by a passing settings check. Distinguish navigation to a surface from functional proof on it. Preserve evidence through cleanup.

## Features, in priority order

| Priority   | Feature                                         | Executable coverage                                                                                          |
| ---------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Core       | [Conversations](conversations.md)               | Default real-provider proof: send, streaming, completion, tool, stop                                         |
| Core       | [Thread continuity](thread-continuity.md)       | Default proof: switch while running, isolation, background completion, drafts, restart, archive/restore      |
| Next       | [Queued follow-ups and steering](follow-ups.md) | `--maintenance`: visible Enter-queue and modified-Enter steer with real auth                                 |
| Next       | [Folders and threads](navigation.md)            | `--maintenance`: New thread until Show more Today, and pin/unpin while a run is going                        |
| Next       | [Archive and restore](archive.md)               | Default proof on a real conversation; core spec adds hover/group checks                                      |
| Supporting | [Settings](settings.md)                         | `--smoke`: visible navigation and preference restart                                                         |
| Supporting | [Skills](skills.md)                             | `--smoke` covers opening; `--maintenance` covers Try and aliases                                             |
| Supporting | [Scheduled tasks](scheduled-tasks.md)           | Core Electron specs for list/create/fire/tool; not in default conversation proof                             |
| Supporting | [Worktrees](worktrees.md)                       | `--maintenance` switches to Workspace grouping, creates a permanent worktree, and checks `git worktree list` |

Packaged-app launch, native dialogs/clipboard, model/account onboarding, attachments, file/diff/terminal interaction, and broader extension behavior require separate mapped journeys as those features are changed. Do not claim full-app coverage from this initial map.

## Latest observed proof (2026-09-24)

Maintenance pass on main `b417b30` in a Linux cloud session (Xvfb), `openai-codex/gpt-5.6-luna`. Conversation `run-mQubER` passed all ten checkpoints, maintenance `run-yrUVKY` passed all seven, and `run-XTCNXP` passed again after the steer-before-follow-up order check was hardened, and smoke `run-0gAibp` passed. No assertion failures; all owned Electron PIDs closed. Eight core specs passed 21/21 via `test:e2e:runner`: `scheduled-tasks`, `scheduled-task-runtime-tools`, `thread-menu`, `composer-controls`, `archive`, `skills-settings`, `worktrees` and `navigation`. The other core specs the map cites (thread switcher, command palette, sidebar toggle, recency, ordering, stop-running-prompt, and the per-page settings specs) were not run in this pass. Known product gap: the running composer hint always reads "Cmd+Enter to steer", also on Linux and Windows where the key is Control+Enter.

## Earlier observed proof (2026-09-22)

The completed review/extension implementation passed all ten real-provider conversation
checkpoints in `run-bif5h7` and all seven maintenance checkpoints in `run-XBuK0l`,
using `openai-codex/gpt-5.6-sol`. No assertion failures were recorded. Stop now proves
cancellation of a real bounded shell command before its completion marker, instead
of depending on how long the model chooses to write. This run aborted the command
in 568 ms; both tasks and their independent drafts survived restart. The conversation
and follow-up traces were inspected in the trace viewer and showed no errors.
Owned Electron processes exited. Separate real-provider PR Review and local macOS
packaged-app checks also passed; see the [redesign verification report](../../../../docs/workspace-redesign-verification.md)
for their scope and retained evidence. Windows/Linux packaging and notarization
were not part of this proof.

## Earlier observed proof (2026-09-19)

- `run-iBtFrn` on product fix `2411711f`: all 10 real-provider checkpoints passed, with no assertion failures. Typing a multiline draft during streaming plus forty 4 px upward inputs progressed monotonically from 480.5 to 324.5 px; subsequent text growth kept reading position within 2 px. Jump, completion, tools, Stop, switching, archive/restore, both drafts and restart passed. The short frame sample had p95 9.2 ms and no intervals above 33 ms. PIDs 17428 and 17948 closed. This proves automated Electron wheel input, not physical trackpad hardware.

- Typing/small-scroll correction: both new interaction regressions failed before the correction (115 px typing drift; tiny upward inputs failed to escape bottom) and pass afterward. Repository checks passed, including 45 desktop unit tests. Full Core: 179/182 passed; two terminal startup failures passed on focused retry. The remaining extension-command draft race also reproduces on original baseline `b4982e94`, before the viewport work. Do not call this sweep fully green.
- `run-fRnNEC` and `run-8mMSLq`: typing plus forty 4 px upward inputs passed, but the recipe incorrectly used the composer button label to detect streaming while a draft was present. A nonempty draft intentionally shows Send during a run. Both failed recipes are retained; the corrected check reads the thread running indicator.

- `run-LLPOKg`: audited rerun passed all 10 checkpoints on final viewport source, including streaming read position, Jump, Stop, tool execution, switching, archive/restore, draft isolation, and both conversations/drafts after restart. Composer input evidence contains the expected whole draft writes and full Bravo before both closes. The earlier truncation did not recur; its cause remains unknown. PIDs 82111 and 82370 closed.

- `run-TCLBNB`: final viewport source passed streaming, reading during growth, Jump, Stop, tool output, switching, archive/restore, and Alpha after restart. The full recipe **failed** because Bravo's draft was `Unsent draft for ` after restart rather than `Unsent draft for Bravo`; the complete draft was visible at the archive/restore checkpoint. Source review found no new draft-truncation path. The recipe now records synthetic composer input events and pre-close values so a later edit can be distinguished from persistence loss. Do not count this run as a full pass.
- Final fixture-backed Core sweep: 180/180 passed after the resize correction. Three paced wheel samples per version showed p95 synthetic wheel-to-scroll of 84.1–89.4 ms on b4982e94, 31.1–31.4 ms on PR117 aac010a, and 24.0–24.4 ms on the final viewport. Final samples had zero frames above 33 ms. PR117 uses an older base; these are workload comparisons, not isolated causal measurements or native input proof.

- `run-DlCXRS`: visible real `openai-codex/gpt-5.6-luna` conversation proof passed with the new viewport owner. While Stop run was visible, wheel input moved away from the bottom, assistant text continued growing, and reading position stayed within 2 CSS pixels. Jump returned to the bottom. Streaming, switch-during-run, tool, Stop, draft isolation, archive/restore, and both conversations after restart passed. `scroll-frames.json`: 181 intervals, p95 9.1 ms, max 9.3 ms, none above 33 ms. This is a short diagnostic sample, not a general performance guarantee or native trackpad proof. Owned processes closed.
- `run-mm4hik`: preceding recipe attempt produced only 380 px of overflow against a 500 px fixture requirement; it failed before scroll proof. The recipe now requests 120 longer lines and waits for 300 px of overflow while still running. Retain the failed run.
- Focused Core coverage is `timeline-pinning.spec.ts`, `context-rail.spec.ts` (turn timing markers), and `timeline-viewport.spec.ts`. The latter covers windowed long messages, click/downward-wheel intent, search navigation, a growing 700-line code row, and layout clamping. Its frame timing is diagnostic; correctness assertions are required in Core.

## Earlier observed proof (2026-09-18)

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
