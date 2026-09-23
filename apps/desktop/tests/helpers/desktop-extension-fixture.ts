import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";

export async function installDesktopExtensionFixture(
  workspace: string,
  attackUrl: string,
  helperModulePath = require.resolve("@pi-gui/extension-ui"),
): Promise<void> {
  const directory = join(workspace, ".pi", "extensions", "desktop-security");
  await mkdir(join(directory, "dist"), { recursive: true });
  await writeFile(
    join(directory, "index.ts"),
    `
import { registerDesktopView } from ${JSON.stringify(helperModulePath)};
export default function fixture(pi) {
  let activations = 0;
  registerDesktopView(pi, {
    id: "security", title: "Security fixture", source: import.meta.url,
    frontend: new URL("./dist/desktop.js", import.meta.url),
    backend: () => ({ id: "security.backend", setup(env) {
      const state = env.replicatedState({ value: 0, activations: ++activations });
      env.provide({ id: "security.counter", local: false }, {
        state,
        async increment(context) {
          state.change(context, (draft) => { draft.value += 1; });
          return state.value;
        },
      });
    } }),
  });
}

`,
  );
  // This small, prebuilt ESM frontend consumes the same public structural service API as authors.
  await writeFile(
    join(directory, "dist", "desktop.js"),
    `
export async function mount(root, host) {
  root.innerHTML = '<h1>Security fixture</h1><output id="counter"></output><button id="increment">Increment</button><pre id="boundary"></pre><button id="network">Try network</button><output id="network-result"></output><button id="navigate">Try navigation</button><output id="navigation-result"></output><button id="outside">Try outside file</button><output id="outside-result"></output><button id="draft">Prepare task draft</button>';
  const context = { abortSignal: host.signal, value() { return undefined; }, toString() { return 'security fixture'; } };
  const Counter = { id: 'security.counter', local: false };
  const binding = host.services.open({ services: [Counter], assertAccess: () => host.signal.throwIfAborted(), onError: error => { root.dataset.error = error.message; } });
  const service = binding.use(Counter);
  await binding.ready(context);
  const render = value => { root.querySelector('#counter').textContent = 'Count ' + value.value + ' · activations ' + value.activations; };
  render(service.state.value);
  const unsubscribe = service.state.subscribe(render);
  let parentAccess = 'allowed';
  try { void parent.document.body; } catch { parentAccess = 'blocked'; }
  root.querySelector('#boundary').textContent = JSON.stringify({ preload: typeof window.piApp, process: typeof process, require: typeof require, parentAccess, origin: self.origin });
  // Record delivery and failure so a missing increment says whether the click or the call was lost.
  root.querySelector('#increment').onclick = event => {
    const button = event.currentTarget;
    button.dataset.clicks = String(Number(button.dataset.clicks ?? 0) + 1);
    service.increment(context).catch(error => { button.dataset.error = String(error?.message ?? error); });
  };
  root.querySelector('#network').onclick = async () => {
    try { await fetch(${JSON.stringify(attackUrl)}); root.querySelector('#network-result').textContent = 'Network allowed'; }
    catch { root.querySelector('#network-result').textContent = 'Network blocked'; }
  };
  root.querySelector('#navigate').onclick = () => {
    location.href = ${JSON.stringify(attackUrl)};
    setTimeout(() => { root.querySelector('#navigation-result').textContent = 'Navigation blocked'; }, 100);
  };
  root.querySelector('#outside').onclick = async () => {
    try { await host.actions.openFile({path:'../outside.txt'}); root.querySelector('#outside-result').textContent = 'Outside allowed'; }
    catch { root.querySelector('#outside-result').textContent = 'Outside blocked'; }
  };
  root.querySelector('#draft').onclick = () => host.actions.prepareTaskDraft({ title: 'Extension prepared task', prompt: 'Inspect the scoped extension findings.' }).catch(() => {});
  return () => { unsubscribe(); return binding.dispose(context); };
}
`,
  );
}

export async function openDesktopExtensionFixture(window: Page): Promise<void> {
  const workbench = window.getByTestId("workbench");
  if (!(await workbench.isVisible())) await window.getByTestId("toggle-side-panel").click();
  const chooser = window.getByTestId("workbench-chooser");
  if (!(await chooser.isVisible())) await window.getByTestId("workbench-add-tab").click();
  await chooser.getByRole("button", { name: "Security fixture", exact: true }).click();
}

/**
 * Waits until the host has received the frame's ready signal. The frame paints its content
 * before mount() returns, so visible frame text alone does not mean the view is ready.
 */
export async function expectExtensionViewReady(window: Page): Promise<void> {
  await expect(window.getByTestId("extension-view-panel")).toHaveAttribute("data-state", "ready");
}
