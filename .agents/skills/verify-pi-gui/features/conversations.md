# Conversations: send, stream, and stop

The primary product flow is to send a prompt, watch an assistant response grow, and finish or stop the run. A successful settings smoke is not a substitute for this flow.

## Sub-features

- `conversation-send`: create a real thread by filling New thread prompt and clicking Start thread.
- `conversation-stream`: observe at least two increasing assistant text lengths while the thread shows running.
- `conversation-complete`: observe the final assistant marker and the running indicator clearing without an error.
- `conversation-tool`: execute a real tool, inspect its output, and corroborate a file written in the scratch workspace.
- `conversation-stop`: send a follow-up that starts a bounded shell tool, click Stop run while it is executing, and verify cancellation before its completion file can be written.

## How to get to it (user POV)

- Sidebar New thread (or Cmd+N / Control+N) → enter a prompt → Start thread.
- Existing thread → composer → Send message (the primary proof uses the button).
- During a run, an empty composer shows Stop run.
- Click a tool header to expand/collapse its output.
- Enter is a separate send entry point; queued Enter and steering shortcuts are mapped in `follow-ups.md`.

## Driving it with Playwright

Preconditions: a built app, an explicitly selected working provider/model, and the real-auth environment described in the parent skill. Run `scripts/prove.sh` from the skill directory path shown there; conversation proof is the default.

- **Send:** the recipe clicks New thread, fills `getByLabel('New thread prompt')`, then clicks Start thread. Require a real sidebar session ID and Stop run. No session creation IPC or injected events are allowed.
- **Stream:** sample `.timeline-item--assistant .message__content` while the active row has `data-sidebar-indicator="running"`. Retain timestamped lengths in `stream-samples.json` and a partial screenshot. Looking for text in the entire transcript can falsely match the user's prompt; assertions must target assistant messages.
- **Complete:** require `ALPHA_DONE` in the assistant response and a cleared running indicator. Failed/auth-error states are failures, not completion.
- **Tool:** Bravo runs a short shell command in the scratch folder to write `verification-tool.txt`. Check `BRAVO_TOOL_OK` in both the file and the expanded `.timeline-tool__body`, then collapse the header.
- **Stop:** submit the prescribed 25-second shell command. Require a running tool plus the actual `verification-cancel-started.txt` marker; the marker printed in the command input alone is insufficient. Click Stop run, require idle within 10 seconds, Send message, and `Command aborted` in tool output. Require less than 20 seconds since the start observation and no `verification-cancel-completed.txt`; retain `stop-proof.json`. Do not depend on a model producing a requested number of sentences to keep the run open.

## Gotchas

- Uses real provider requests and can consume usage. Keep prompts and scratch tool commands bounded.
- Missing/expired authentication is BLOCKED; do not replace the run with mocked responses or silently pass a skip.
- A final answer alone does not prove streaming. Require observed growth while running.
- The initial scratch folder is a fixture; native folder selection is a separate proof.

## Streaming scroll diagnostic

Run `pnpm --filter @pi-gui/desktop run test:perf:scroll` for three fixture-backed Electron samples. The existing performance spec seeds 120 long messages, keeps a growing 700-line code row visible, sends 300 assistant-delta/running-status pairs, and applies alternating wheel input until the final token is displayed. It reports frame gaps, long tasks, synthetic wheel-event-to-scroll latency, event/sample counts, stream/input duration, mounted rows, and main-process publication counts. Raw samples are retained in each test's output directory. Set `PERF_LABEL` to identify the checkout.

Use the same workload and machine for comparisons. Publication backpressure changes actual stream duration; report that duration. Wheel timestamps describe synthetic renderer input, not physical trackpad latency. These metrics are diagnostic, not shared-runner CI thresholds. Set `PERF_CPU=1` for a separate profile run; exclude profiled runs from timing comparisons. Core viewport tests remain the correctness gate.

## Typing and small-scroll overlap

The original large-wheel proof missed user-visible jitter and scroll lock. Core `timeline-viewport.spec.ts` now samples the position throughout typing into a fixed-height multiline draft, and overlaps typing/streaming with 4px upward wheel steps. These tests failed on 4b1b6847 (115px typing drift and failure to move upward). Never replace them with only an eventual-position assertion or a single large wheel step.

The real-provider recipe also types into a multiline draft while sending repeated 4px upward inputs. It retains `typing-scroll.json`, verifies upward progress without backward jumps, checks the exact draft, then verifies a stable reading position while more assistant text arrives. This proves synthetic renderer input; native trackpad momentum still requires a manual check.
