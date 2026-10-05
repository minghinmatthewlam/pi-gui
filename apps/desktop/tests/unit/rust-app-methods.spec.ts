import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { desktopIpc } from "../../contracts/ipc";
import { PI_DRIVER_METHODS, PI_RUNTIME_METHODS } from "../../pi-host/protocol";

const appDir = join(__dirname, "../../../../crates/pi-gui-core/src/app");

async function rustSource(file: string): Promise<string> {
  return readFile(join(appDir, file), "utf8");
}

function rustStringList(source: string, name: string): string[] {
  const body = new RegExp(`pub const ${name}: &\\[&str\\] = &\\[([^\\]]*)\\];`).exec(source)?.[1];
  if (!body) throw new Error(`${name} is missing`);
  return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/** What the Electron preload exposes and the channel each method calls. */
async function preloadMethods(): Promise<Map<string, string | undefined>> {
  const preload = await readFile(join(__dirname, "../../electron/preload.ts"), "utf8");
  const body = preload.slice(preload.indexOf('exposeInMainWorld("piApp"'));
  const methods = new Map<string, string | undefined>();
  // Each top-level property starts a line with two spaces of indentation.
  const entries = [...body.matchAll(/^ {2}(\w+): /gm)];
  entries.forEach((entry, index) => {
    const end = entries[index + 1]?.index ?? body.length;
    const text = body.slice(entry.index, end);
    const channel = /ipcRenderer\.(?:invoke|send|sendSync)\(\s*desktopIpc\.(\w+)/.exec(text)?.[1];
    methods.set(entry[1], channel);
  });
  return methods;
}

test("the Rust kernel names every preload method by the channel the preload calls", async () => {
  const source = await rustSource("methods.rs");
  const rust = new Map(
    [...source.matchAll(/m\(\s*"(\w+)",\s*"([^"]+)",\s*(\w+),?\s*\)/g)].map((match) => [
      match[1],
      { channel: match[2], kind: match[3] },
    ]),
  );
  const channels = desktopIpc as Record<string, string>;
  const preload = await preloadMethods();
  const calling = [...preload].filter(([, channel]) => channel !== undefined);
  expect(calling.length).toBeGreaterThan(100);
  for (const [api, channelKey] of calling) {
    expect(rust.get(api)?.channel, api).toBe(channels[channelKey as string]);
  }
  // The preload's own acknowledgement is the only method that is not part of PiDesktopApi.
  const extra = [...rust.keys()].filter((api) => !preload.has(api));
  expect(extra).toEqual(["pendingComposerDraftFlushed"]);
  expect(rust.get("pendingComposerDraftFlushed")?.channel).toBe(
    desktopIpc.pendingComposerDraftFlushed,
  );
  expect(rust.get("setTerminalFocused")?.kind).toBe("Send");
  expect(rust.get("readClipboardImage")?.kind).toBe("Checked");
});

test("the Rust kernel pushes on the desktopIpc channels", async () => {
  const source = await rustSource("methods.rs");
  const body = source.slice(source.indexOf("pub mod push"));
  const pushes = [...body.matchAll(/pub const \w+: &str =\s*"([^"]+)";/g)].map((m) => m[1]);
  const channels = new Set(Object.values(desktopIpc as Record<string, string>));
  expect(pushes.length).toBeGreaterThan(10);
  for (const push of pushes) {
    expect(channels.has(push), push).toBe(true);
  }
});

test("the Rust pi driver calls the methods the pi host serves", async () => {
  const source = await rustSource("pi.rs");
  expect(rustStringList(source, "PI_DRIVER_METHODS")).toEqual([...PI_DRIVER_METHODS]);
  expect(rustStringList(source, "PI_RUNTIME_METHODS")).toEqual([...PI_RUNTIME_METHODS]);
});
