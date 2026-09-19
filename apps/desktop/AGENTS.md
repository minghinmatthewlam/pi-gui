# Desktop Guidelines

Apply these rules for changes under `apps/desktop/`.

- Preserve Codex-style information architecture and polish; avoid generic dashboard UI.
- macOS is the primary desktop UI verification target. Linux and Windows CI also validate packaging; packaging success does not prove platform-specific UI or native behavior.
- Verify desktop changes on the real Electron surface, and prefer Playwright coverage for repeatable proofs. Distinguish fixture-backed Electron checks, deterministic runtime integration, real-provider conversations, native OS behavior, and packaged-app proof; a passing lane or skipped provider test cannot establish all of these.
- Use `apps/desktop/README.md` for lane/setup commands, and `apps/desktop/tests/AGENTS.md` for test-surface rules under the test tree.
- Keep the main pane conversation-first: transcript, tool timeline, composer, and session state are the priority.
- Don’t expose broad filesystem/process APIs through preload; add only narrow IPC needed by the renderer.
- Prefer shared helpers over duplicating Electron test harness or IPC glue.
- Keep composer and timeline behavior fast on hot paths; avoid full-state disk writes for keystrokes if a narrower path works.
