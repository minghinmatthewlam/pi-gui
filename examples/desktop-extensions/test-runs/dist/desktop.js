// node_modules/@earendil-works/chord/dist/context/index.js
var ABORT_SIGNAL_CONTEXT_KEY = Object.freeze({
  token: /* @__PURE__ */ Symbol("chord.abortSignal")
});
var BaseContext = class {
  get abortSignal() {
    return this.value(ABORT_SIGNAL_CONTEXT_KEY);
  }
};
var EmptyContext = class extends BaseContext {
  #name;
  constructor(name) {
    super();
    this.#name = name;
  }
  value(_key) {
    return void 0;
  }
  toString() {
    return this.#name;
  }
};
var BACKGROUND_CONTEXT = new EmptyContext("[Context BACKGROUND_CONTEXT]");
var TODO_CONTEXT = new EmptyContext("[Context TODO_CONTEXT]");

// node_modules/@earendil-works/chord/dist/api.js
function defineService(id, options) {
  if (id.length === 0)
    throw new TypeError("Service ID must not be empty");
  if (id.startsWith("$chord."))
    throw new TypeError("Service IDs beginning with $chord. are reserved");
  return Object.freeze({ id, local: options?.local ?? false });
}

// examples/desktop-extensions/test-runs/contract.ts
var OUTPUT_LIMIT = 32 * 1024;
var TestRuns = defineService("pi-gui.example.test-runs.v1");
function isActive(run) {
  return run.outcome.kind === "running" || run.outcome.kind === "cancelling";
}
function outcomeLabel(run) {
  switch (run.outcome.kind) {
    case "running":
      return "Running";
    case "cancelling":
      return "Stopping";
    case "completed":
      return run.outcome.exitCode === 0 ? "Command completed \xB7 exit 0" : `Command failed \xB7 exit ${run.outcome.exitCode}`;
    case "cancelled":
      return "Cancelled";
    case "timedOut":
      return "Timed out";
    case "executionError":
      return `Could not run \xB7 ${run.outcome.message}`;
    case "interrupted":
      return "Interrupted \xB7 result unknown";
  }
}

// examples/desktop-extensions/test-runs/desktop.ts
function element(tag, text = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}
async function mount(root, host) {
  host.signal.throwIfAborted();
  const style = element("style");
  style.textContent = `
    *{box-sizing:border-box} body{margin:0} button,select{font:inherit}
    .tests{font:14px/1.5 system-ui,sans-serif;padding:24px;color:var(--fg);background:var(--bg);min-height:100vh}
    h1{font-size:22px;margin:0 0 4px} p{margin:0 0 18px;opacity:.8}
    .controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:18px}
    button,select{border:1px solid color-mix(in srgb,var(--fg) 24%,transparent);border-radius:7px;padding:8px 12px;color:inherit;background:var(--bg)}
    button{cursor:pointer} button:disabled{cursor:default;opacity:.5}
    .start{background:var(--accent);color:white;border-color:transparent}
    .layout{display:grid;grid-template-columns:minmax(160px,230px) minmax(0,1fr);gap:20px}
    .history{display:flex;flex-direction:column;gap:8px}.history button{text-align:left}
    .history button[aria-pressed=true]{border-color:var(--accent)}
    .history small{display:block;opacity:.75}.detail{min-width:0}
    h2{font-size:16px;margin:0 0 6px}.command{display:block;overflow-wrap:anywhere;margin-bottom:10px;opacity:.75}
    pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.55 ui-monospace,monospace;padding:16px;border-radius:8px;background:color-mix(in srgb,var(--fg) 7%,var(--bg));min-height:180px;max-height:65vh;overflow:auto}
    .notice{color:var(--accent);margin-bottom:12px}.error{color:#e27373;white-space:pre-wrap;margin-bottom:12px}
    @media(max-width:580px){.tests{padding:16px}.layout{grid-template-columns:1fr}.history{flex-direction:row;overflow:auto}.history button{min-width:160px}}
  `;
  const view = element("main");
  view.className = "tests";
  view.style.setProperty("--bg", host.theme.background);
  view.style.setProperty("--fg", host.theme.foreground);
  view.style.setProperty("--accent", host.theme.accent);
  view.append(
    element("h1", "Test Runs"),
    element(
      "p",
      "Run a real example suite. Command output and exit status are saved with this task."
    )
  );
  const controls = element("div");
  controls.className = "controls";
  const label = element("label", "Suite ");
  const select = element("select");
  select.setAttribute("aria-label", "Test suite");
  label.append(select);
  const start = element("button", "Run suite");
  start.className = "start";
  const stop = element("button", "Stop run");
  controls.append(label, start, stop);
  const error = element("div");
  error.className = "error";
  error.setAttribute("role", "alert");
  const layout = element("div");
  layout.className = "layout";
  const history = element("nav");
  history.className = "history";
  history.setAttribute("aria-label", "Recent test runs");
  const detail = element("section");
  detail.className = "detail";
  const title = element("h2", "No runs yet");
  title.setAttribute("aria-live", "polite");
  const command = element("code");
  command.className = "command";
  const notice = element("div");
  notice.className = "notice";
  const output = element("pre", "Choose a suite, then Run suite.");
  output.setAttribute("aria-label", "Test output");
  detail.append(title, command, notice, output);
  layout.append(history, detail);
  view.append(controls, error, layout);
  root.replaceChildren(style, view);
  let state = { ready: false, error: null, suites: [], runs: [] };
  let selected = null;
  let actionError = "";
  let pending = false;
  let disposed = false;
  const render = () => {
    if (disposed) return;
    const selectedSuite = select.value;
    select.replaceChildren(
      ...state.suites.map((suite) => {
        const option = element("option", suite.label);
        option.value = suite.id;
        return option;
      })
    );
    if (state.suites.some((suite) => suite.id === selectedSuite)) select.value = selectedSuite;
    const active = state.runs.find(isActive);
    start.disabled = !state.ready || pending || Boolean(active);
    select.disabled = start.disabled;
    stop.disabled = pending || !active || active.outcome.kind === "cancelling";
    error.textContent = [state.error, actionError].filter(Boolean).join("\n");
    history.replaceChildren(
      ...[...state.runs].reverse().map((run2) => {
        const button = element("button", run2.label);
        button.append(element("small", outcomeLabel(run2)));
        button.setAttribute("aria-pressed", String(run2.id === selected));
        button.onclick = () => {
          selected = run2.id;
          render();
        };
        return button;
      })
    );
    const run = state.runs.find((candidate) => candidate.id === selected) ?? state.runs.at(-1);
    if (!run) {
      title.textContent = state.ready ? "No runs yet" : "Connecting\u2026";
      command.textContent = "";
      notice.textContent = "";
      output.textContent = "Choose a suite, then Run suite.";
      return;
    }
    title.textContent = `${run.label} \xB7 ${outcomeLabel(run)}`;
    command.textContent = run.command;
    notice.textContent = run.truncated ? `Showing the last 32 KiB. ${run.outputBytes.toLocaleString()} output bytes were received; earlier output is not retained.` : "";
    const wasAtBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 30;
    output.textContent = run.output || (isActive(run) ? "Waiting for output\u2026" : "(No output)");
    if (wasAtBottom) output.scrollTop = output.scrollHeight;
  };
  const showError = (reason) => {
    actionError = reason instanceof Error ? reason.message : String(reason);
    render();
  };
  const binding = host.services.open({
    services: [TestRuns],
    assertAccess: () => host.signal.throwIfAborted(),
    onError: showError
  });
  const service = binding.use(TestRuns);
  let unsubscribe = () => {
  };
  const perform = async (action) => {
    if (pending || disposed) return;
    pending = true;
    actionError = "";
    render();
    try {
      await action();
    } catch (reason) {
      actionError = reason instanceof Error ? reason.message : String(reason);
    } finally {
      pending = false;
      render();
    }
  };
  start.onclick = () => {
    const suiteId = select.value;
    const requestId = [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    perform(async () => {
      const result = await service.start({ suiteId, requestId }, BACKGROUND_CONTEXT);
      selected = result.runId;
    }).catch(showError);
  };
  stop.onclick = () => {
    const active = state.runs.find(isActive);
    if (active)
      perform(() => service.cancel({ runId: active.id }, BACKGROUND_CONTEXT)).catch(showError);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    host.signal.removeEventListener("abort", dispose);
    binding.dispose(BACKGROUND_CONTEXT).catch(showError);
    root.replaceChildren();
  };
  host.signal.addEventListener("abort", dispose, { once: true });
  render();
  try {
    await binding.ready(BACKGROUND_CONTEXT);
    host.signal.throwIfAborted();
    unsubscribe = service.state.subscribe((next) => {
      const lastId = state.runs.at(-1)?.id;
      state = next;
      if (next.runs.at(-1)?.id !== lastId) selected = next.runs.at(-1)?.id ?? null;
      render();
    });
    if (service.state.value) state = service.state.value;
    selected = state.runs.at(-1)?.id ?? null;
    render();
  } catch (reason) {
    dispose();
    throw reason;
  }
  return dispose;
}
export {
  mount
};
