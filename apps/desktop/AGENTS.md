# Desktop Guidelines

Apply these rules for changes under `apps/desktop/`.

- Preserve Codex-style information architecture and polish; avoid generic dashboard UI.
- Verify desktop changes on the real Electron surface, and prefer Playwright coverage for repeatable proofs.
- Use `apps/desktop/README.md` for lane/setup commands, and `apps/desktop/tests/AGENTS.md` for test-surface rules under the test tree.
- Keep the main pane conversation-first: transcript, tool timeline, composer, and session state are the priority.
- Don’t expose broad filesystem/process APIs through preload; add only narrow IPC needed by the renderer.
- Prefer shared helpers over duplicating Electron test harness or IPC glue.
- Keep composer and timeline behavior fast on hot paths; avoid full-state disk writes for keystrokes if a narrower path works.
