import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_VIEW_DISCOVER,
  DESKTOP_VIEW_REGISTER,
  DESKTOP_VIEW_UNREGISTER,
  registerDesktopView,
  type DesktopExtensionAPI,
  type DesktopViewRegistrationEvent,
} from "../dist/index.js";
import { parseDesktopHostAction } from "../dist/browser.js";

await test("terminal registration is optional and desktop discovery replays the same closure", () => {
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const shutdown: (() => void)[] = [];
  const pi: DesktopExtensionAPI = {
    events: {
      emit(channel, value) {
        for (const listener of listeners.get(channel) ?? []) listener(value);
      },
      on(channel, listener) {
        const handlers = listeners.get(channel) ?? new Set();
        handlers.add(listener);
        listeners.set(channel, handlers);
        return () => {
          handlers.delete(listener);
        };
      },
    },
    on(_event, listener) {
      shutdown.push(listener);
    },
  };
  let factoryCalls = 0;
  const declaration = {
    id: "review",
    title: "Review",
    source: "file:///extension/index.ts",
    frontend: new URL("file:///extension/dist/desktop.js"),
    backend() {
      factoryCalls += 1;
      return { id: "review-backend", setup() {} };
    },
  };
  const registration = registerDesktopView(pi, declaration);
  assert.equal(registration.available, false);
  const discovered: unknown[] = [];
  const removed: unknown[] = [];
  pi.events.on(DESKTOP_VIEW_REGISTER, (value) => {
    const event = value as DesktopViewRegistrationEvent;
    discovered.push(event.declaration);
    event.accept?.();
  });
  pi.events.on(DESKTOP_VIEW_UNREGISTER, (value) => {
    removed.push(value);
  });
  pi.events.emit(DESKTOP_VIEW_DISCOVER, undefined);
  pi.events.emit(DESKTOP_VIEW_DISCOVER, undefined);
  assert.equal(registration.available, true);
  assert.deepEqual(discovered, [declaration, declaration]);
  assert.equal(factoryCalls, 0, "discovery must not instantiate another backend");
  shutdown.forEach((listener) => listener());
  registration.dispose();
  pi.events.emit(DESKTOP_VIEW_DISCOVER, undefined);
  assert.equal(registration.available, false);
  assert.deepEqual(removed, [declaration]);
  assert.equal(discovered.length, 2);
});

await test("host actions reject foreign target identities and non-JSON values", () => {
  assert.deepEqual(parseDesktopHostAction({ type: "openFile", path: "src/app.ts", line: 3 }), {
    type: "openFile",
    path: "src/app.ts",
    line: 3,
  });
  assert.deepEqual(
    parseDesktopHostAction({
      type: "prepareTaskDraft",
      title: "Fix",
      prompt: "Review finding",
      files: [{ path: "src/app.ts", line: 3 }],
    }),
    {
      type: "prepareTaskDraft",
      title: "Fix",
      prompt: "Review finding",
      files: [{ path: "src/app.ts", line: 3 }],
    },
  );
  for (const action of [
    { type: "openFile", path: "src/app.ts", sessionId: "other" },
    { type: "openFile", path: "src/app.ts", line: 0 },
    { type: "openFile", path: "src/app.ts", column: Number.NaN },
    {
      type: "prepareTaskDraft",
      title: "Fix",
      prompt: "Review finding",
      files: [{ path: "a", workspaceId: "other" }],
    },
    { type: "prepareTaskDraft", title: "Fix", prompt: undefined },
  ])
    assert.throws(() => parseDesktopHostAction(action));
});
