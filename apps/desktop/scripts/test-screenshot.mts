import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchDesktop, makeWorkspace, addWorkspace } from "../tests/harness.ts";

async function main() {
  const userDataDir = await mkdtemp(join(tmpdir(), "pi-test-screenshot-"));
  const workspacePath = await makeWorkspace("test-ws");

  console.log("Launching desktop...");
  const harness = await launchDesktop(userDataDir);

  try {
    const page = await harness.firstWindow();
    console.log("Got page, waiting 2s...");
    await new Promise((r) => setTimeout(r, 2000));

    await page.screenshot({ path: "/tmp/pi-test-1-before-workspace.png" });
    console.log("Screenshot 1 taken (before workspace)");

    await addWorkspace(page, workspacePath);
    console.log("Workspace added, waiting 2s...");
    await new Promise((r) => setTimeout(r, 2000));

    await page.screenshot({ path: "/tmp/pi-test-2-after-workspace.png" });
    console.log("Screenshot 2 taken (after workspace)");

    // Check DOM content
    const bodyHTML = await page.evaluate(() =>
      document.body.innerHTML.substring(0, 1500),
    );
    console.log("Body HTML preview:", bodyHTML);
  } finally {
    await harness.close();
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
