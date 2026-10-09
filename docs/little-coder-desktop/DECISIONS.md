# Architecture Decisions

## D001 — Build on pi-gui

**Status:** Accepted  
**Date:** 2026-10-09

Use pi-gui as the desktop foundation rather than creating a new desktop application.

Reason: pi-gui already owns the generic coding-agent desktop surfaces and process architecture.

---

## D002 — Do not replace root repository instructions

**Status:** Accepted

Root `AGENTS.md` remains the repository source of truth.

Root `CLAUDE.md` remains the existing symlink to `AGENTS.md`.

Project-specific rules live under `docs/little-coder-desktop/`.

---

## D003 — Preserve Little Coder as the behavior layer

**Status:** Accepted

Do not reimplement Little Coder behavior in desktop code.

Prefer resource/package integration or a narrow RPC/process adapter.

---

## D004 — Prefer native Pi SDK integration; retain RPC fallback

**Status:** Provisionally accepted; WP-001 must verify.

Try to integrate Little Coder through the existing Pi SDK/resource architecture first.

If that cannot faithfully preserve Little Coder behavior, use an explicit RPC/process adapter.

---

## D005 — Provider location is orthogonal to the GUI

**Status:** Accepted

Inference may be cloud, local, LAN, or privately tunneled.

No core GUI feature may assume localhost or CUDA.

---

## D006 — No GPU development requirement

**Status:** Accepted

Routine builds/tests must work without discrete AI hardware.

Local-GPU testing is a separate validation lane.

---

## D007 — Deterministic runtime fixtures are mandatory

**Status:** Accepted

Little Coder-specific GUI behavior must be testable without nondeterministic live inference.

---

## D008 — Preserve existing Pi session ownership

**Status:** Accepted

Do not create a parallel transcript/session database for data already owned by Pi/pi-gui.

---

## D009 — One work package per review cycle

**Status:** Accepted

An implementation agent receives one work package, verifies it, reports, and stops.

Git branch/worktree handling follows root `AGENTS.md` and explicit user instruction.

---

## D010 — Linux x64 is the initial validation priority

**Status:** Accepted

Prioritize Linux x64 while preserving pi-gui's existing portable boundaries.

---

## D011 — Qwen3.5-9B-class model is a validation target only

**Status:** Accepted

Use this model class initially on the RTX 5070/8 GB reference machine.

Do not hard-code model-specific behavior into the application.

---

## D012 — No public exposure requirement for local inference

**Status:** Accepted

Remote-local validation uses trusted LAN, VPN, or SSH tunnel patterns.
