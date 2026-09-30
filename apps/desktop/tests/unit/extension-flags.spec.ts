import { expect, test } from "@playwright/test";
import type {
  RuntimeExtensionFlag,
  RuntimeExtensionRecord,
  RuntimeSnapshot,
} from "@pi-gui/session-driver/runtime-types";
import { resolveExtensionFlags } from "../../electron/workspace/extension-flags";

function runtimeWith(
  ...extensions: { enabled: boolean; flags: RuntimeExtensionFlag[] }[]
): RuntimeSnapshot {
  return {
    extensions: extensions.map(
      ({ enabled, flags }, index) =>
        ({
          path: `/ext-${index}.ts`,
          displayName: `ext-${index}`,
          enabled,
          flags: flags.map((flag) => flag.name),
          flagDetails: flags,
        }) as unknown as RuntimeExtensionRecord,
    ),
  } as unknown as RuntimeSnapshot;
}

const runtime = runtimeWith(
  {
    enabled: true,
    flags: [
      { name: "plan", type: "boolean" },
      { name: "dry-run", type: "boolean" },
      { name: "env", type: "string" },
      { name: "preset", type: "string" },
    ],
  },
  { enabled: false, flags: [{ name: "disabled-ext-flag", type: "boolean" }] },
);

test("pi receives only switched-on booleans and value flags with text", () => {
  const resolved = resolveExtensionFlags(
    { plan: true, "dry-run": false, env: " staging ", preset: "  " },
    runtime,
  );
  expect(resolved.applied).toEqual({ plan: true, env: "staging" });
});

test("switched-off and empty choices are still remembered as the workspace defaults", () => {
  const resolved = resolveExtensionFlags(
    { plan: true, "dry-run": false, env: "staging", preset: "" },
    runtime,
  );
  expect(resolved.chosen).toEqual({ plan: true, "dry-run": false, env: "staging", preset: "" });
});

test("unknown names, disabled extensions and wrong value types never reach pi or the defaults", () => {
  const resolved = resolveExtensionFlags(
    { gone: true, "disabled-ext-flag": true, plan: "yes", env: true },
    runtime,
  );
  expect(resolved).toEqual({ chosen: {}, applied: {} });
});

test("no runtime means no flags", () => {
  expect(resolveExtensionFlags({ plan: true }, undefined)).toEqual({ chosen: {}, applied: {} });
});
