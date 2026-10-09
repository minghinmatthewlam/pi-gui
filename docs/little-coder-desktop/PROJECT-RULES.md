# Little Coder Desktop — Project Rules

These are **project-specific supplemental instructions**.

They do not replace the repository's root `AGENTS.md`.

If anything here conflicts with root `AGENTS.md`, follow root `AGENTS.md`.

## 1. Mission

Add Little Coder as a maintainable first-class runtime/profile experience inside the pi-gui
architecture while preserving:

- pi-gui's existing product direction;
- pi-gui's ownership and Electron boundaries;
- Standard Pi behavior;
- Little Coder's small-model scaffold.

The GUI is a control surface. It is not a replacement implementation of Pi or Little Coder.

## 2. Work-package discipline

Implement only the assigned work package.

Do not opportunistically implement later roadmap items.

Do not perform unrelated dependency upgrades, formatting sweeps, renames, broad cleanup, or
architecture refactors unless required by the assigned acceptance criteria.

Respect the current Git branch/worktree. Do not create or switch branches unless the user
explicitly asks, consistent with root `AGENTS.md`.

At completion:

1. run required verification;
2. review the diff for scope and unnecessary abstraction;
3. report results;
4. stop.

Do not automatically start the next work package.

## 3. Preserve the existing pi-gui architecture

Follow `docs/architecture.md`.

In particular:

- renderer remains browser-safe;
- preload remains narrow;
- Electron main owns host/platform capabilities;
- portable contracts stay portable;
- `pi-sdk-driver` remains thin over Pi;
- session ownership remains with Pi where Pi already owns it;
- project code must not bypass existing owners merely for convenience.

## 4. Preserve Little Coder as the behavior layer

Do not copy Little Coder's prompts, extensions, skills, plan logic, context logic, or tool
policies into bespoke desktop code merely to make integration easier.

Preferred integration order:

1. use existing Pi SDK/resource-loading seams;
2. if that cannot faithfully reproduce Little Coder, use a narrow RPC/process adapter;
3. vendor/fork Little Coder behavior only after an explicit architecture decision showing that
   the first two approaches are untenable.

The default assumption is that Little Coder should remain independently updateable.

## 5. Standard Pi must remain intact

Adding Little Coder must not silently change current pi-gui behavior.

Standard Pi remains the default until a later work package explicitly changes product behavior.

Every integration seam must include regression coverage for the existing Standard Pi path.

## 6. Inference is provider-agnostic

Never assume:

```text
provider == localhost
```

Supported topologies may include:

- cloud provider
- OpenRouter
- localhost
- LAN-hosted inference
- inference reached through a trusted VPN or SSH tunnel

Core GUI logic must not care where inference physically runs.

## 7. No GPU dependency for development

Normal development and repository checks must not require:

- CUDA
- NVIDIA hardware
- LM Studio
- Ollama
- llama.cpp
- paid API access

Live-provider/local-model tests belong in separate opt-in validation lanes.

## 8. Deterministic runtime tests

Little Coder-specific UI behavior must eventually be testable without a live model.

Representative deterministic fixtures should cover:

- assistant output
- tool calls/results/errors
- permission request
- plan-mode transition
- approved plan -> implementation
- sub-coder lifecycle
- background jobs
- context warning
- provider failure
- cancellation

Do not commit sensitive production/user transcripts as fixtures.

## 9. Security

Never commit:

- API keys
- OpenRouter credentials
- provider secrets
- private endpoint credentials
- sensitive captured prompts

Do not expose unauthenticated local model servers directly to the public Internet.

Remote local-inference testing should use trusted LAN or private tunnel/VPN patterns.

## 10. Upstream-change discipline

Before modifying an integration seam:

1. inspect the actual checked-out pi-gui source;
2. inspect the actual target Little Coder version;
3. prefer released/public APIs;
4. isolate required compatibility assumptions;
5. add tests that make upstream breakage obvious.

Do not assume this project packet permanently describes current upstream internals.

## 11. Verification

Start from the existing repository guidance:

- `.agents/skills/verify-pi-gui/SKILL.md` for desktop verification;
- `docs/ci-baseline.md` for repository checks.

At minimum, code-bearing work packages normally require the affected subset of the existing
baseline and, before completion, the work package's explicit verification commands.

Do not weaken upstream verification in order to make the new integration pass.

## 12. Completion report

For each work package report:

- behavior implemented
- files changed
- checks/tests run
- acceptance criteria status
- architecture deviations
- known limitations
- deferred follow-ups

Then stop.
