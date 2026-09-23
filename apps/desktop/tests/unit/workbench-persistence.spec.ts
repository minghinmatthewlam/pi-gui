import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toolRefId, type TaskWorkbenchTemplate } from "../../contracts/workbench";
import {
  decodePersistedUiState,
  readPersistedUiState,
  writePersistedUiState,
} from "../../electron/persistence/app-store-persistence";
import { writeFileAtomicQueued } from "../../electron/persistence/atomic-file-write";

function workbenchTemplate(): TaskWorkbenchTemplate {
  return {
    visibility: "hidden",
    tools: [{ kind: "changes" }, { kind: "files" }, { kind: "terminal" }],
    selection: { kind: "tool", toolId: toolRefId({ kind: "files" }) },
    files: {
      workspaceId: "workspace-one",
      tabs: {
        tabs: ["README.md", "src/index.ts"],
        active: "src/index.ts",
        line: { start: 4, end: 8 },
        lineNonce: 3,
        retained: ["README.md"],
      },
    },
    changes: {
      scope: { kind: "uncommitted" },
      workspaceId: "workspace-one",
      selectedPath: "src/index.ts",
    },
  };
}

test("concurrent v19 saves retain exactly one immutable copy of the original v17 bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workbench-migration-"));
  const path = join(dir, "ui-state.json");
  const original =
    '\t{\r\n  "version" : 17,\r\n  "composerDraft" : "keep café",\r\n  "threadGrouping" : "workspace"\r\n}\r\n';
  await writeFile(path, original);

  const retained = {
    composerDraft: "keep café",
    threadGrouping: "workspace" as const,
    taskWorkbenchTemplatesBySession: { "workspace-one:task-one": workbenchTemplate() },
  };
  await Promise.all([
    writePersistedUiState(path, { ...retained, sidebarCollapsed: false }),
    writePersistedUiState(path, { ...retained, sidebarCollapsed: true }),
    writePersistedUiState(path, { ...retained, themeMode: "dark" }),
  ]);

  const migrationCopies = (await readdir(dir)).filter((name) =>
    /^ui-state\.pre-workbench-v17\..+\.json$/.test(name),
  );
  expect(migrationCopies).toHaveLength(1);
  const migrationPath = join(dir, migrationCopies[0]!);
  expect(await readFile(migrationPath)).toEqual(Buffer.from(original));

  const saved = await readPersistedUiState(path);
  expect(saved.version).toBe(19);
  expect(saved.composerDraft).toBe(retained.composerDraft);
  expect(saved.threadGrouping).toBe(retained.threadGrouping);
  expect(saved.taskWorkbenchTemplatesBySession).toEqual(retained.taskWorkbenchTemplatesBySession);
  expect(saved.themeMode).toBe("dark");

  await writePersistedUiState(path, { ...retained, composerDraft: "newer draft" });
  expect(await readFile(migrationPath)).toEqual(Buffer.from(original));
  expect((await readdir(dir)).filter((name) => name.includes(".pre-workbench-"))).toEqual(
    migrationCopies,
  );
  expect(decodePersistedUiState(JSON.parse(await readFile(`${path}.bak`, "utf8"))).version).toBe(
    19,
  );
});

test("migrating recovered v17 state keeps its original bytes and the damaged primary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workbench-recovery-"));
  const path = join(dir, "ui-state.json");
  const good = '{ "version": 17, "composerDraft": "recovered draft" }\n\n';
  const damaged = "{damaged primary\n";
  await writeFile(`${path}.bak`, good);
  await writeFile(path, damaged);

  const recovered = await readPersistedUiState(path);
  expect(recovered.composerDraft).toBe("recovered draft");
  await writePersistedUiState(path, {
    composerDraft: recovered.composerDraft,
    taskWorkbenchTemplatesBySession: { "workspace-one:task-one": workbenchTemplate() },
  });

  const names = await readdir(dir);
  const migrationCopies = names.filter((name) =>
    /^ui-state\.pre-workbench-v17\..+\.json$/.test(name),
  );
  expect(migrationCopies).toHaveLength(1);
  expect(await readFile(join(dir, migrationCopies[0]!))).toEqual(Buffer.from(good));
  expect(await readFile(`${path}.bak`)).toEqual(Buffer.from(good));
  const corruptCopies = names.filter((name) => name.startsWith("ui-state.json.corrupt."));
  expect(corruptCopies).toHaveLength(1);
  expect(await readFile(join(dir, corruptCopies[0]!))).toEqual(Buffer.from(damaged));
  expect((await readPersistedUiState(path)).version).toBe(19);
});

test("v18 layouts default to Uncommitted and retain their exact original bytes across v19 scope saves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workbench-scope-migration-"));
  const path = join(dir, "ui-state.json");
  const template = workbenchTemplate();
  const original = `${JSON.stringify(
    {
      version: 18,
      composerDraft: "retain this draft",
      taskWorkbenchTemplatesBySession: {
        "workspace-one:task-one": {
          ...template,
          changes: {
            workspaceId: template.changes.workspaceId,
            selectedPath: template.changes.selectedPath,
          },
        },
      },
    },
    null,
    3,
  )}\n\n`;
  await writeFile(path, original);

  const restored = await readPersistedUiState(path);
  const restoredTemplate = restored.taskWorkbenchTemplatesBySession?.["workspace-one:task-one"];
  expect(restoredTemplate).toEqual(template);
  expect(await readFile(path, "utf8")).toBe(original);
  if (!restoredTemplate) throw new Error("Expected restored v18 workbench template");

  await writePersistedUiState(path, {
    ...restored,
    taskWorkbenchTemplatesBySession: {
      "workspace-one:task-one": {
        ...restoredTemplate,
        changes: {
          ...restoredTemplate.changes,
          scope: { kind: "branch", baseRef: "origin/trunk" },
        },
      },
    },
  });
  const migrationCopies = (await readdir(dir)).filter((name) =>
    /^ui-state\.pre-workbench-v18\..+\.json$/.test(name),
  );
  expect(migrationCopies).toHaveLength(1);
  const migrationPath = join(dir, migrationCopies[0]!);
  expect(await readFile(migrationPath, "utf8")).toBe(original);
  const saved = await readPersistedUiState(path);
  expect(saved.version).toBe(19);
  expect(saved.composerDraft).toBe("retain this draft");
  expect(saved.taskWorkbenchTemplatesBySession?.["workspace-one:task-one"]?.changes).toEqual({
    ...template.changes,
    scope: { kind: "branch", baseRef: "origin/trunk" },
  });

  await writePersistedUiState(path, {
    ...saved,
    taskWorkbenchTemplatesBySession: {
      "workspace-one:task-one": {
        ...restoredTemplate,
        changes: {
          ...restoredTemplate.changes,
          scope: { kind: "turn", checkpointId: "exact-turn" },
        },
      },
    },
  });
  expect(
    (await readPersistedUiState(path)).taskWorkbenchTemplatesBySession?.["workspace-one:task-one"]
      ?.changes.scope,
  ).toEqual({ kind: "turn", checkpointId: "exact-turn" });
  expect(await readFile(migrationPath, "utf8")).toBe(original);
  expect((await readdir(dir)).filter((name) => name.includes(".pre-workbench-"))).toEqual(
    migrationCopies,
  );
});

test("a migration-copy collision rejects the save without changing existing files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workbench-backup-failure-"));
  const path = join(dir, "ui-state.json");
  const migrationPath = join(dir, "ui-state.pre-workbench-v17.existing.json");
  const original = '{ "version": 17, "composerDraft": "original draft" }\n';
  const existingMigration = '{ "version": 17, "composerDraft": "earlier migration" }\n';
  const previousBackup = '{ "version": 17, "composerDraft": "previous draft" }\n';
  await writeFile(path, original);
  await writeFile(migrationPath, existingMigration);
  await writeFile(`${path}.bak`, previousBackup);

  await expect(
    writeFileAtomicQueued(
      path,
      '{"version":18,"composerDraft":"replacement"}\n',
      decodePersistedUiState,
      { preserveExistingAs: () => migrationPath },
    ),
  ).rejects.toMatchObject({ code: "EEXIST" });

  expect(await readFile(path, "utf8")).toBe(original);
  expect(await readFile(migrationPath, "utf8")).toBe(existingMigration);
  expect(await readFile(`${path}.bak`, "utf8")).toBe(previousBackup);
});

const invalidLayouts: readonly { name: string; value: unknown }[] = [
  { name: "malformed template", value: null },
  { name: "unknown visibility", value: { ...workbenchTemplate(), visibility: "expanded" } },
  {
    name: "duplicate built-in tools",
    value: { ...workbenchTemplate(), tools: [{ kind: "files" }, { kind: "files" }] },
  },
  {
    name: "duplicate extension tools",
    value: {
      ...workbenchTemplate(),
      tools: [
        { kind: "extension", extensionId: "pr-review", viewId: "findings" },
        { kind: "extension", extensionId: "pr-review", viewId: "findings" },
      ],
      selection: { kind: "chooser" },
    },
  },
  {
    name: "selection outside the tool list",
    value: { ...workbenchTemplate(), selection: { kind: "tool", toolId: "missing-tool" } },
  },
  {
    name: "future layout field",
    value: { ...workbenchTemplate(), futureLayoutSetting: "retain me" },
  },
  {
    name: "future tool field",
    value: { ...workbenchTemplate(), tools: [{ kind: "files", futureToolSetting: "retain me" }] },
  },
  {
    name: "null review scope",
    value: { ...workbenchTemplate(), changes: { ...workbenchTemplate().changes, scope: null } },
  },
  {
    name: "unknown review scope",
    value: {
      ...workbenchTemplate(),
      changes: { ...workbenchTemplate().changes, scope: { kind: "future" } },
    },
  },
  {
    name: "mixed review scope fields",
    value: {
      ...workbenchTemplate(),
      changes: {
        ...workbenchTemplate().changes,
        scope: { kind: "branch", checkpointId: "wrong-scope" },
      },
    },
  },
  {
    name: "future review scope field",
    value: {
      ...workbenchTemplate(),
      changes: { ...workbenchTemplate().changes, scope: { kind: "uncommitted", future: true } },
    },
  },
];

for (const { name, value } of invalidLayouts) {
  test(`drops a ${name} and keeps the rest of saved UI state`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "workbench-invalid-layout-"));
    const path = join(dir, "ui-state.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 19,
        composerDraft: "must survive",
        taskWorkbenchTemplatesBySession: {
          "workspace-one:task-one": value,
          "workspace-one:task-two": workbenchTemplate(),
        },
      }),
    );

    const restored = await readPersistedUiState(path);
    expect(restored.composerDraft).toBe("must survive");
    expect(restored.taskWorkbenchTemplatesBySession).toEqual({
      "workspace-one:task-two": workbenchTemplate(),
    });
    await writePersistedUiState(path, { ...restored, composerDraft: "replacement" });
    const saved = await readPersistedUiState(path);
    expect(saved.composerDraft).toBe("replacement");
    expect(Object.keys(saved.taskWorkbenchTemplatesBySession ?? {})).toEqual([
      "workspace-one:task-two",
    ]);
  });
}

test("a malformed layout map is dropped without blocking saved UI state", () => {
  const restored = decodePersistedUiState({
    version: 19,
    composerDraft: "must survive",
    taskWorkbenchTemplatesBySession: ["not", "a", "map"],
  });
  expect(restored.composerDraft).toBe("must survive");
  expect(restored.taskWorkbenchTemplatesBySession).toEqual({});
});
