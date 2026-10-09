# Little Coder Desktop — Project Overview

**Status:** Revision 1  
**Date:** 2026-10-09  
**Working title:** `little-coder-desktop`

This project adds a first-class graphical desktop experience for
[`little-coder`](https://github.com/itayinbarr/little-coder) to a fork of
[`pi-gui`](https://github.com/minghinmatthewlam/pi-gui).

The project is an **extension/integration of pi-gui**, not a replacement application and not a
fresh repository.

## Project thesis

Combine:

- **pi-gui:** the mature desktop shell around Pi, including threads, worktrees, review/diff UI,
  file browsing/editing, terminal integration, session handling, provider selection, and
  Electron process boundaries;
- **little-coder:** a Pi-based scaffold specifically tuned for smaller local models, including
  controlled extension loading, planning/implementation separation, sub-coders, context
  management, tool-skill cards, background jobs, and other small-model-oriented behavior.

The result should be:

```text
pi-gui desktop UX
        +
little-coder behavior
        +
provider-agnostic inference
```

The result must **not** be:

```text
generic Pi GUI
        +
"Little Coder" branding
```

## Existing pi-gui repository rules remain authoritative

The repository already contains:

```text
AGENTS.md
CLAUDE.md -> AGENTS.md
README.md
```

Those are upstream-owned root files and remain in place.

For this project, instruction precedence is:

1. root `AGENTS.md`
2. `docs/little-coder-desktop/PROJECT-RULES.md`
3. architecture/design documents in this directory
4. the assigned work package

If a project rule conflicts with root `AGENTS.md`, root `AGENTS.md` wins.

## Development model

The project must be fully developable without a local GPU.

### Machine A — primary development machine

No discrete AI accelerator is required.

Used for:

- architecture and code review
- GUI development
- Pi/little-coder integration
- deterministic fixture tests
- repository verification
- cloud-model validation through OpenRouter or another supported provider

### Machine B — local-AI reference machine

Reference hardware:

```text
NVIDIA RTX 5070 Laptop GPU
8 GB VRAM
```

Used for:

- local-provider validation
- small-model behavior testing
- latency/context/VRAM UX validation

Initial reference model class:

```text
Qwen3.5-9B-class quantized model
```

Possible servers:

- LM Studio
- llama.cpp
- Ollama

The reference model is a validation target, not an application dependency.

## Durable source of truth

This project package belongs inside the pi-gui fork so that:

- both developers see the same design;
- Codex sees the same design;
- work packages are versioned with the code;
- architectural decisions survive chat history;
- cloud and local development use the same source of truth.

## Read order

Before implementing a work package:

1. repository root `AGENTS.md`
2. `PROJECT-RULES.md`
3. `DESIGN.md`
4. `TECHNICAL-SPEC.md`
5. `DECISIONS.md`
6. `ROADMAP.md`
7. assigned `work-packages/WP-*.md`

## First implementation task

Begin with:

```text
work-packages/WP-001-bootstrap-and-integration-spike.md
```

WP-001 intentionally proves the actual integration boundary before the project commits to a
large implementation.
