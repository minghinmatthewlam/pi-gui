# Technical Specification

## 1. Scope

This specification defines the intended architecture for adding a first-class Little Coder
runtime/profile to pi-gui.

It deliberately avoids locking details that WP-001 must first verify against current upstream
source.

## 2. Existing pi-gui constraints

The current repository architecture already defines strong ownership boundaries.

Important existing characteristics include:

- Electron + React renderer;
- narrow preload/browser-safe API;
- Electron main owning host/platform capabilities;
- `DesktopAppStore` and bounded owners in main;
- `packages/session-driver` owning portable session contracts;
- `packages/pi-sdk-driver` as the thin adapter over upstream Pi;
- Pi session/transcript data remaining authoritative rather than copied into desktop state;
- repository architecture guards preventing renderer and host-boundary violations.

This project must fit those boundaries rather than create a parallel desktop architecture.

## 3. Little Coder characteristics to preserve

Little Coder currently builds on Pi and adds controlled extensions/skills and additional workflow
behavior.

Important current characteristics include:

- controlled extension loading rather than arbitrary default discovery;
- Plan Mode;
- approved-plan -> fresh implementation-session transition;
- plan/action model separation;
- sub-coders/dispatch;
- background jobs;
- read-before-edit behavior;
- context usage information;
- cache telemetry when available;
- tool-skill cards;
- provider independence;
- configurable local-provider base URLs.

The launcher-controlled runtime environment is part of the behavior to preserve.

## 4. Proposed component model

```text
┌──────────────────────────────────────────────────────────────┐
│ Existing pi-gui renderer                                     │
│ + Little Coder-specific presentation where required          │
└───────────────────────────┬──────────────────────────────────┘
                            │ existing typed IPC
┌───────────────────────────▼──────────────────────────────────┐
│ Existing preload/main ownership boundaries                   │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│ Existing app/session/driver composition                      │
│ + minimal runtime/profile seam                               │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│ Pi runtime                                                   │
│  ├── Standard Pi configuration                              │
│  └── Little Coder configuration                             │
└───────────────────────────┬──────────────────────────────────┘
                            │ provider API
             ┌──────────────┼───────────────┐
             ▼              ▼               ▼
         cloud/OpenRouter  LM Studio     llama.cpp/Ollama
                           local/LAN     local/LAN
```

## 5. Runtime/profile abstraction

The preferred result is a small integration seam rather than Little Coder conditionals spread
throughout desktop owners.

Conceptually:

```ts
interface RuntimeProfile {
  id: string;
  displayName: string;
  capabilities: RuntimeCapabilities;
  resourcePolicy: RuntimeResourcePolicy;
}
```

This is illustrative only.

WP-001 must identify the actual smallest seam that fits the current codebase and existing
ownership model.

### Standard Pi

Must preserve current pi-gui behavior.

### Little Coder

Must reproduce Little Coder's controlled runtime closely enough that the GUI does not silently
change its scaffold.

Prefer using installed/upstream Little Coder resources rather than vendoring them.

## 6. Integration strategies

WP-001 must evaluate these in order.

### Strategy A — existing Pi SDK/resource-loading integration

**Preferred if faithful.**

pi-gui already delegates to upstream Pi through `pi-sdk-driver`. Current Pi resource-loading
paths expose mechanisms for explicit extension sources and disabling ordinary extension discovery.

If Little Coder's launcher environment can be reproduced through supported/reasonably isolated
Pi SDK seams without copying Little Coder behavior, use this route.

Advantages:

- remains inside pi-gui's existing driver/session architecture;
- no second process protocol;
- natural compatibility with existing desktop owners and session handling.

Risk:

- Little Coder launcher may perform setup beyond controlled resource loading.

### Strategy B — supervised Little Coder/Pi RPC adapter

**Fallback if Strategy A cannot preserve behavior cleanly.**

Run upstream Little Coder/Pi as the authoritative agent process and adapt its RPC/events into
pi-gui's bounded driver/session interfaces.

Advantages:

- Little Coder launcher stays authoritative;
- lower risk of missing hidden launcher behavior.

Costs:

- process supervision;
- second adapter implementation;
- event/session translation;
- more integration surface.

### Strategy C — copy Little Coder behavior into pi-gui

**Rejected for MVP.**

Reconsider only through an explicit architecture decision after demonstrating that A and B are
not viable.

## 7. Provider architecture

Runtime profile and provider are independent concepts.

The Little Coder profile must support the providers Pi/Little Coder support, including:

- cloud models;
- OpenRouter;
- LM Studio;
- llama.cpp;
- Ollama;
- trusted remote local endpoint.

Do not infer endpoint location from model identity.

Do not create a second provider configuration system if existing Pi/pi-gui settings already own
the necessary state.

## 8. Reference validation configurations

### Cloud development

```text
Runtime/profile: Little Coder
Provider: OpenRouter or other supported cloud provider
GPU: not required
```

Purpose:

- live agent-loop validation;
- strong-model comparison;
- development on the non-GPU machine.

### Local reference

```text
GPU: RTX 5070 Laptop, 8 GB
Model class: Qwen3.5-9B quantized
Server: LM Studio / llama.cpp / Ollama
```

Purpose:

- small-model behavior;
- latency;
- context/VRAM constraints;
- local-provider failure/recovery.

### Remote-local

```text
pi-gui machine
    │
    │ trusted LAN / private tunnel
    ▼
GPU inference machine
```

This must use ordinary endpoint/provider configuration.

## 9. Session/persistence model

Do not create a parallel transcript database.

Use existing Pi/pi-gui ownership:

- Pi owns agent session/transcript truth;
- pi-gui owns its existing desktop/UI state;
- project-specific UI-only preferences may be persisted in the appropriate existing owner.

Derived caches may exist if disposable and reproducible.

## 10. Little Coder-specific state

Potential UI state includes:

```text
runtime profile
plan/action phase
plan model
action model
sub-coder lifecycle
background-job lifecycle
context usage
cache telemetry
provider health
```

Before inventing new state, WP-001 must determine which of these already exist in:

- Pi session entries;
- Pi events;
- Little Coder events/extensions;
- current pi-gui projections.

Prefer projections/adapters over duplicate mutable truth.

## 11. Deterministic fixtures

Later work should establish a replayable, credential-free runtime fixture layer.

Suggested cases:

```text
standard-response
edit-and-test
permission-request
plan-approved
subcoder-run
background-job
provider-failure
context-warning
cancelled-run
```

The injection point must respect existing pi-gui owner/driver boundaries.

## 12. Security

### Credentials

Reuse existing provider credential handling.

Never place secrets in:

- repository docs;
- fixtures;
- committed screenshots;
- debug output.

### Tool permissions

If runtime and GUI disagree about an approval state, fail closed.

### Remote providers

Do not automatically expose local model servers on public interfaces.

## 13. Licensing/source boundaries

WP-001 should verify current upstream licenses.

Expected current state:

- pi-gui: MIT
- Little Coder: Apache-2.0

Avoid vendoring Little Coder in MVP.

If redistribution is later introduced, review attribution/NOTICE obligations before release.

## 14. Upstream sync strategy

Keep Little Coder-specific changes localized:

- runtime/profile adapter/seam;
- Little Coder presentation components;
- deterministic fixture infrastructure;
- compatibility shims if unavoidable.

Avoid rewriting generic pi-gui components when an existing owner/extension seam can solve the
problem.

## 15. Platform scope

MVP validation priority:

1. Linux x64;
2. preserve current upstream cross-platform abstractions;
3. broader packaging validation later.

Do not introduce Linux-only assumptions into portable owners/contracts without necessity.

## 16. Questions WP-001 must answer

1. Can the existing `pi-sdk-driver` reproduce Little Coder's controlled resource environment?
2. What does Little Coder's launcher do beyond resource/extension selection?
3. Which Little Coder states already flow through ordinary Pi sessions/events?
4. Which states need an adapter?
5. Can an installed Little Coder package be discovered through a stable path/API?
6. Does direct resource integration require private Pi APIs?
7. If private APIs are required, can the assumption be isolated in the existing compatibility
   seam style used by pi-gui?
8. If direct SDK integration is not faithful, what is the smallest RPC/process adapter?
9. Where can deterministic runtime fixtures enter without violating owner boundaries?
10. What exact upstream versions/commits were evaluated?
