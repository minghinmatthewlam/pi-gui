import { expect, test } from "@playwright/test";
import { decodeArgs, decodeResult, encodeArgs, encodeResult } from "../../pi-host/protocol";
import { RpcPeer } from "../../rpc/rpc-peer";

/** Two peers wired back to back, delivering lines asynchronously like a real pipe. */
function connectedPeers() {
  let a!: RpcPeer;
  let b!: RpcPeer;
  const pipe = (to: () => RpcPeer) => ({
    send: (line: string) => {
      setImmediate(() => to().receiveChunk(`${line}\n`));
    },
    close: () => undefined,
  });
  a = new RpcPeer({ transport: pipe(() => b) });
  b = new RpcPeer({ transport: pipe(() => a) });
  return { a, b };
}

test("either side can call the other while its own call is waiting", async () => {
  const { a, b } = connectedPeers();
  a.handle("app.double", (params) => (params as number) * 2);
  // b's handler calls back into a before it answers a's request.
  b.handle("host.work", async (params) => {
    const doubled = (await b.request("app.double", params)) as number;
    return doubled + 1;
  });
  await expect(a.request("host.work", 20)).resolves.toBe(41);
});

test("a notification sent before a request is handled first", async () => {
  const { a, b } = connectedPeers();
  const seen: string[] = [];
  b.onNotification("config", (params) => seen.push(`config:${String(params)}`));
  b.handle("run", () => {
    seen.push("run");
    return null;
  });
  a.notify("config", "v2");
  await a.request("run");
  expect(seen).toEqual(["config:v2", "run"]);
});

test("errors keep their name, message and own fields such as a code", async () => {
  const { a, b } = connectedPeers();
  b.handle("open", () => {
    const error = new Error("Session file is held by pi") as Error & { code: string };
    error.name = "SessionLeasedError";
    error.code = "SESSION_LEASED";
    throw error;
  });
  const failure = (await a.request("open").catch((error: unknown) => error)) as Error & {
    code?: string;
  };
  expect(failure.name).toBe("SessionLeasedError");
  expect(failure.message).toBe("Session file is held by pi");
  expect(failure.code).toBe("SESSION_LEASED");
});

test("cancelling a call aborts the handler on the other side", async () => {
  const { a, b } = connectedPeers();
  let aborted: () => void = () => undefined;
  const handlerAborted = new Promise<void>((resolve) => (aborted = resolve));
  b.handle("slow", (_params, { signal }) => {
    signal.addEventListener("abort", aborted, { once: true });
    return new Promise(() => undefined);
  });
  const controller = new AbortController();
  const call = a.request("slow", undefined, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await expect(call).rejects.toThrow(/aborted/);
  await handlerAborted;
});

test("closing rejects calls still waiting for a reply", async () => {
  const { a, b } = connectedPeers();
  b.handle("never", () => new Promise(() => undefined));
  const call = a.request("never");
  setTimeout(() => a.close("host exited"), 10);
  await expect(call).rejects.toThrow("pi host connection closed: host exited");
  await expect(a.request("never")).rejects.toThrow(/closed/);
});

test("stray output on the pipe is ignored and partial lines are joined", async () => {
  let received: unknown;
  const peer = new RpcPeer({ transport: { send: () => undefined, close: () => undefined } });
  peer.onNotification("event", (params) => (received = params));
  peer.receiveChunk("Debugger listening on ws://...\n");
  peer.receiveChunk('{"method":"event","par');
  peer.receiveChunk('ams":{"ok":true}}\n');
  expect(received).toEqual({ ok: true });
});

test("optional arguments and undefined results survive the JSON trip", () => {
  const encoded = JSON.parse(
    JSON.stringify(encodeArgs([{ id: "s" }, undefined, "x", undefined])),
  ) as ReturnType<typeof encodeArgs>;
  expect(decodeArgs(encoded)).toEqual([{ id: "s" }, undefined, "x"]);
  expect(decodeResult(JSON.parse(JSON.stringify(encodeResult(undefined))))).toBeUndefined();
  expect(decodeResult(JSON.parse(JSON.stringify(encodeResult(null))))).toBeNull();
});

test("a reply JSON cannot encode still settles the call as an error", async () => {
  const { a, b } = connectedPeers();
  b.handle("cyclic", () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    return value;
  });
  b.handle("bigint", () => ({ tokens: 12n, failure: new Error("tool failed") }));
  await expect(a.request("cyclic")).rejects.toThrow(/circular/i);
  await expect(a.request("bigint")).resolves.toEqual({
    tokens: "12",
    failure: { name: "Error", message: "tool failed" },
  });
});

test("a message split across many chunks arrives once, whole", () => {
  const received: unknown[] = [];
  const peer = new RpcPeer({ transport: { send: () => undefined, close: () => undefined } });
  peer.onNotification("event", (params) => received.push(params));
  const line = JSON.stringify({ method: "event", params: { text: "x".repeat(10_000) } });
  for (let index = 0; index < line.length; index += 7)
    peer.receiveChunk(line.slice(index, index + 7));
  peer.receiveChunk('\n{"method":"event","params":2}\n');
  expect(received).toEqual([{ text: "x".repeat(10_000) }, 2]);
});
