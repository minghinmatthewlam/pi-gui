# Design Document

## 1. Product

**Working title:** Little Coder Desktop

A first-class Little Coder runtime/profile experience inside a pi-gui-derived desktop
application.

The application should feel like a coding-agent workbench rather than a generic chatbot.

## 2. Problem

Little Coder is interesting because its scaffold is deliberately optimized for smaller local
models. Its terminal UI is functional, but a graphical workbench can materially improve:

- parallel task visibility
- diff/review
- worktree handling
- file browsing
- shell/test visibility
- plan/implementation state
- provider/model state
- sub-coder visibility

pi-gui already solves most of the generic desktop-agent UX. Reimplementing that stack would
waste effort and create a second desktop architecture to maintain.

## 3. Design objective

Join pi-gui's desktop shell to Little Coder's behavior without flattening Little Coder into
generic Pi behavior.

The project should add only the smallest amount of Little Coder-specific integration and UI
necessary.

## 4. Primary users

### 4.1 Experienced developer without a local GPU

Needs to:

- develop and review the application;
- run deterministic tests;
- use OpenRouter/cloud models for live validation;
- diagnose integration behavior without depending on the GPU machine.

### 4.2 Developer with a modest local GPU

Reference hardware:

```text
RTX 5070 Laptop GPU
8 GB VRAM
```

Needs to:

- run an appropriate small local coding model;
- connect through LM Studio/llama.cpp/Ollama;
- use the same GUI and Little Coder runtime path;
- observe context/runtime state;
- compare local behavior with cloud behavior.

## 5. Core principles

### 5.1 GUI, agent runtime, and inference are separate layers

```text
┌─────────────────────────────────┐
│ pi-gui desktop                  │
│ threads / review / files / UX   │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ Pi + Little Coder behavior      │
│ tools / skills / plan / context │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ Provider / inference endpoint   │
│ cloud / local / remote-local    │
└─────────────────────────────────┘
```

### 5.2 Preserve scaffold-model fit

The project exists because Little Coder's scaffold appears to extract more useful behavior from
small models.

A GUI simplification that bypasses or changes that scaffold is a regression.

### 5.3 Reuse pi-gui owners and surfaces

Use the existing:

- conversation/timeline
- workbench
- diff/review
- terminal
- file explorer/editor
- worktrees
- session catalog
- provider/model plumbing

unless a concrete requirement proves an existing surface insufficient.

### 5.4 Live inference is validation, not a test prerequisite

Routine tests must be deterministic.

Cloud and local providers are separate live-validation lanes.

### 5.5 Surface operational state that matters for small models

When available, the GUI should eventually expose:

- active runtime profile
- active model
- plan model
- action model
- provider/endpoint health
- context usage
- cache telemetry
- active sub-coders
- background jobs
- permission requests
- plan vs implementation phase

## 6. Primary workflows

### 6.1 Bounded coding task

```text
Open workspace
    ↓
Select Little Coder profile
    ↓
Select provider/model
    ↓
Submit bounded task
    ↓
Agent reads/edits/runs tests
    ↓
Review diff
    ↓
Stage/commit or request rework
```

### 6.2 Plan then implement

```text
Submit larger task
    ↓
Plan Mode
    ↓
research/sub-coders
    ↓
clarifying questions
    ↓
approved plan
    ↓
fresh implementation session
    ↓
action model
    ↓
review changes
```

The planning/implementation context split is part of the desired behavior.

### 6.3 Cloud/local comparison

The same task should be runnable with:

```text
same workspace
same GUI
same Little Coder profile
different provider/model
```

This helps identify whether a failure belongs to:

- desktop integration
- Little Coder scaffold
- provider/runtime
- small local model

### 6.4 Remote local inference

Supported topology:

```text
Developer machine
pi-gui + Pi + Little Coder
        │
        │ trusted LAN / private tunnel
        ▼
GPU machine
LM Studio / llama.cpp / Ollama
```

This should be ordinary provider configuration, not a special application mode.

## 7. MVP

The first useful release should provide:

- current pi-gui baseline features;
- explicit Standard Pi vs Little Coder runtime/profile;
- ordinary Little Coder coding session;
- existing graphical change review;
- visible Plan Mode;
- plan -> implementation transition;
- deterministic Little Coder event fixtures;
- cloud-provider validation on the non-GPU machine;
- local-provider validation on the RTX 5070/8 GB reference machine.

## 8. Post-MVP

Potential later surfaces:

- dedicated plan/action model controls;
- richer sub-coder panel;
- context/cache telemetry;
- background-job UI;
- checkpoint/restore UX if naturally supported;
- Little Coder extension/skill inspection;
- local-provider diagnostics;
- endpoint presets;
- optional guided model-server setup.

## 9. Non-goals

The initial project will not:

- create a new inference engine;
- replace LM Studio, llama.cpp, or Ollama;
- train/fine-tune models;
- replace Pi's agent runtime;
- reimplement Little Coder's behavior;
- require a local GPU;
- replace pi-gui's root repository instructions;
- replace pi-gui's README;
- become a general IDE replacement;
- expose local inference publicly by default.

## 10. Success criteria

The project succeeds when:

1. Little Coder can be used from the desktop surface without needing its interactive TUI;
2. Standard Pi still behaves normally;
3. routine development works with no GPU;
4. cloud and local validation use the same core code path;
5. Little Coder can be upgraded without copying its behavior into the GUI;
6. upstream pi-gui changes remain reasonably mergeable;
7. deterministic tests catch integration regressions before live inference is involved.
