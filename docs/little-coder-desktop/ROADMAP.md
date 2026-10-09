# Roadmap

Later details may change after WP-001 resolves the real integration boundary.

## Milestone 0 — Prove the seam

### WP-001 — Baseline and integration spike

Goal:

- run/record current repository baseline;
- inspect actual pi-gui/Pi/Little Coder sources;
- choose native SDK integration or RPC/process adapter;
- identify the minimal runtime/profile seam;
- preserve Standard Pi;
- identify deterministic fixture injection point.

See `work-packages/WP-001-bootstrap-and-integration-spike.md`.

### WP-002 — Runtime/profile plumbing

Depends on WP-001.

Goal:

- introduce first-class Standard Pi / Little Coder profile selection at the approved ownership
  seam;
- keep Standard Pi as the default;
- bootstrap Little Coder using the chosen strategy;
- avoid polished Little Coder-specific UI.

### WP-003 — Deterministic fixture/replay harness

Goal:

- establish credential-free runtime-event fixtures;
- replay representative events through the approved driver/owner seam;
- provide baseline cases for tools, failures, permissions, cancellation.

## Milestone 1 — First useful Little Coder desktop flow

### WP-004 — Basic Little Coder session execution

Goal:

- create/resume Little Coder-profile sessions;
- run ordinary coding tasks;
- display normal Pi tool activity;
- review resulting file changes using existing pi-gui review UX.

Requires one cloud-provider live validation.

### WP-005 — Plan Mode and implementation transition

Goal:

- display Plan Mode;
- render clarification flow;
- approve plan;
- transition to the fresh implementation session;
- preserve planning/action context separation.

### WP-006 — Per-phase model controls

Goal:

- expose plan model and action model using upstream-owned state;
- avoid shadow configuration.

### WP-007 — Sub-coders and background jobs

Goal:

- display Little Coder sub-coder lifecycle;
- display background jobs;
- show cancellation/failure;
- accurately represent serial vs parallel execution.

## Milestone 2 — Local-small-model UX

### WP-008 — Context/cache/provider telemetry

Goal:

- context utilization;
- cache telemetry where available;
- provider endpoint health;
- graceful absence of telemetry.

### WP-009 — RTX 5070 / 8 GB validation

Validate with:

- local provider;
- Qwen3.5-9B-class quantized model;
- bounded multi-file coding task;
- plan -> implement;
- diff review;
- test execution.

Capture qualitative latency/context/behavior findings.

### WP-010 — Remote-local validation

Run pi-gui/Little Coder on one machine and inference on the GPU machine through a trusted
connection.

Verify:

- configurable endpoint;
- disconnect/recovery behavior;
- absence of localhost assumptions;
- no credentials in logs.

## Milestone 3 — Hardening

### WP-011 — Upstream compatibility

Goal:

- isolate project-specific integration;
- document upstream update procedure;
- compatibility checks;
- supported upstream ranges.

### WP-012 — Linux technical preview

Goal:

- Linux x64 build;
- installation/setup docs;
- provider setup;
- Little Coder discovery/setup;
- known limitations;
- license/notice review.

## Deferred

Not part of the initial roadmap:

- IDE replacement;
- model training/fine-tuning;
- automatic benchmarking suite;
- model marketplace;
- native computer-use automation;
- broad Windows/macOS release polish;
- rewriting Little Coder itself.
