import { appendFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface SessionRefLike {
  readonly workspaceId: string;
  readonly sessionId: string;
}

export interface SeededSessionFileMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestampMs?: number;
}

/** Resolve a session's pi JSONL file path from the app's catalog. */
export async function sessionFilePathFromCatalog(
  userDataDir: string,
  sessionRef: SessionRefLike,
): Promise<string> {
  const catalogs = JSON.parse(await readFile(join(userDataDir, "catalogs.json"), "utf8")) as {
    sessions: Array<{ sessionRef: SessionRefLike; sessionFilePath?: string }>;
    sessionFiles?: Record<string, string>;
  };
  const sessionFilePath =
    catalogs.sessions.find(
      (session) =>
        session.sessionRef.workspaceId === sessionRef.workspaceId &&
        session.sessionRef.sessionId === sessionRef.sessionId,
    )?.sessionFilePath ??
    catalogs.sessionFiles?.[`${sessionRef.workspaceId}:${sessionRef.sessionId}`];
  if (!sessionFilePath) {
    throw new Error(
      `No session file tracked for ${sessionRef.workspaceId}:${sessionRef.sessionId}`,
    );
  }
  return sessionFilePath;
}

/**
 * Append message entries straight to a pi session JSONL file, chaining off the
 * current leaf — the same shape pi itself writes. Use this to seed transcript
 * content that must survive an app relaunch (the app reads transcripts from
 * the session file, not from a cache).
 */
export async function appendMessagesToSessionFile(
  sessionFilePath: string,
  messages: readonly SeededSessionFileMessage[],
): Promise<void> {
  const lines = (await readFile(sessionFilePath, "utf8")).split("\n").filter(Boolean);
  const lastLine = lines.at(-1);
  if (!lastLine) {
    throw new Error(`Session file ${sessionFilePath} is empty`);
  }
  let parentId = (JSON.parse(lastLine) as { id?: string }).id ?? null;
  const baseTime = Date.now();

  const entries = messages.map((message, index) => {
    const id = `seeded-${baseTime}-${index}`;
    const timestamp = message.timestampMs ?? baseTime + index * 1_000;
    const entry = {
      type: "message",
      id,
      parentId,
      timestamp: new Date(timestamp).toISOString(),
      message:
        message.role === "assistant"
          ? {
              role: "assistant",
              content: [{ type: "text", text: message.text }],
              api: "test",
              provider: "test",
              model: "test",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop",
              timestamp,
            }
          : { role: "user", content: message.text, timestamp },
    };
    parentId = id;
    return entry;
  });

  await appendFile(
    sessionFilePath,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
}

/**
 * Fabricate a brand-new pi session JSONL beside an existing one, the way the pi
 * CLI does when starting a fresh session in the same workspace: a session header
 * cloned from the sibling (same cwd/version, new id + timestamp) followed by the
 * given messages. pi derives session identity from the header id, not the
 * filename. Returns the new file's path.
 */
export async function createSessionFileBeside(
  siblingSessionFilePath: string,
  fileName: string,
  messages: readonly SeededSessionFileMessage[],
): Promise<string> {
  const firstLine = (await readFile(siblingSessionFilePath, "utf8"))
    .split("\n")
    .find((line) => line.trim());
  const header = JSON.parse(firstLine ?? "{}") as { type?: string };
  if (header.type !== "session") {
    throw new Error(`First line of ${siblingSessionFilePath} is not a session header`);
  }
  const sessionFilePath = join(dirname(siblingSessionFilePath), fileName);
  const newHeader = {
    ...header,
    id: `cli-seeded-${Date.now()}`,
    timestamp: new Date().toISOString(),
  };
  await writeFile(sessionFilePath, `${JSON.stringify(newHeader)}\n`, "utf8");
  await appendMessagesToSessionFile(sessionFilePath, messages);
  return sessionFilePath;
}

/**
 * Bump a session file's header schema version above what it was written with, simulating a file
 * authored by a newer pi than the bundled runtime. Only the header's version number is changed;
 * the message entries stay valid, so the runtime still parses them while reporting the skew.
 * Returns the new version.
 */
export async function bumpSessionFileSchemaVersion(sessionFilePath: string): Promise<number> {
  const lines = (await readFile(sessionFilePath, "utf8")).split("\n");
  const headerIndex = lines.findIndex((line) => line.trim().length > 0);
  if (headerIndex === -1) {
    throw new Error(`Session file ${sessionFilePath} is empty`);
  }
  const header = JSON.parse(lines[headerIndex]) as { type?: string; version?: number };
  if (header.type !== "session") {
    throw new Error(`First line of ${sessionFilePath} is not a session header`);
  }
  const bumped = (header.version ?? 1) + 1;
  lines[headerIndex] = JSON.stringify({ ...header, version: bumped });
  await writeFile(sessionFilePath, lines.join("\n"), "utf8");
  return bumped;
}
