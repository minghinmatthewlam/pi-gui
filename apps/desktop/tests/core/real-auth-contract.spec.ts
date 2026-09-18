import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { getRealAuthConfig, launchDesktop, makeUserDataDir } from "../helpers/electron-app";

test.skip(
  process.env.PI_APP_REAL_AUTH === "1",
  "This contract covers the default non-real-auth path.",
);

test("default desktop launches keep real-auth mode disabled and seed fake auth in a temp agent dir", async () => {
  const realAuth = getRealAuthConfig();
  expect(realAuth.enabled).toBe(false);
  expect(realAuth.skipReason).toContain("PI_APP_REAL_AUTH=1");
  expect(realAuth.skipReason).toContain("PI_APP_REAL_AUTH_SOURCE_DIR");

  const userDataDir = await makeUserDataDir();
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "ambient-test-key-must-not-leak";
  const harness = await launchDesktop(userDataDir, { testMode: "background" }).finally(() => {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  });

  try {
    await harness.firstWindow();
    expect(await harness.electronApp.evaluate(() => process.env.OPENAI_API_KEY)).toBeUndefined();

    const agentDir = await harness.electronApp.evaluate(
      () => process.env.PI_CODING_AGENT_DIR ?? "",
    );
    expect(agentDir).toBe(join(userDataDir, "agent"));

    const auth = JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")) as {
      openai?: { key?: string };
    };
    expect(auth.openai?.key).toBe("test-openai-key");

    const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as {
      defaultProvider?: string;
      defaultModel?: string;
    };
    expect(settings).toMatchObject({
      defaultProvider: "openai",
      defaultModel: "gpt-5",
    });
  } finally {
    await harness.close();
  }
});

test("Core rejects an explicit real-auth source before opening it", async () => {
  const previousLane = process.env.PI_APP_TEST_LANE;
  process.env.PI_APP_TEST_LANE = "core";
  try {
    await expect(
      launchDesktop(await makeUserDataDir(), { realAuthSourceDir: "/unused-real-auth-source" }),
    ).rejects.toThrow("Core tests must not use real provider credentials");
  } finally {
    if (previousLane === undefined) delete process.env.PI_APP_TEST_LANE;
    else process.env.PI_APP_TEST_LANE = previousLane;
  }
});
