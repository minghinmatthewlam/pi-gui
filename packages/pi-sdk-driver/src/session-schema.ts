import { open } from "node:fs/promises";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";

/**
 * Session-file schema-version skew detection.
 *
 * pi session files carry a header version. The bundled runtime migrates older
 * files up, but a file written by a NEWER pi (a user's global CLI ahead of the
 * app's bundled runtime) is consumed as-is: unknown entry types/roles are
 * silently dropped by transcriptFromMessages / buildSessionContext, so content
 * disappears with no signal. We cannot render what the bundled runtime cannot
 * parse, so instead we detect the skew and surface it, letting the app warn the
 * user that some content may not display.
 *
 * Detection is conservative: only a header version strictly greater than the
 * bundled runtime's is flagged (no false positives relative to the runtime
 * version). Missing/unknown/older versions are never flagged, so current and
 * older sessions see zero behavior change. Note this keys off the version
 * number, not the actual entries — a newer pi that bumps the version without
 * introducing unparseable entries would flag with nothing actually lost.
 */

/** The session schema version the bundled pi runtime writes and understands. */
export const RUNTIME_SCHEMA_VERSION: number = CURRENT_SESSION_VERSION;

export interface SessionSchemaInfo {
  /**
   * The session file's header version. `undefined` when the file has no
   * readable session header (e.g. missing/corrupt), in which case skew cannot
   * be determined and is assumed absent.
   */
  readonly fileSchemaVersion: number | undefined;
  /** The bundled runtime's schema version ({@link RUNTIME_SCHEMA_VERSION}). */
  readonly runtimeSchemaVersion: number;
  /** True when the file was written by a newer pi than the bundled runtime. */
  readonly writtenByNewerRuntime: boolean;
}

export function buildSessionSchemaInfo(fileSchemaVersion: number | undefined): SessionSchemaInfo {
  return {
    fileSchemaVersion,
    runtimeSchemaVersion: RUNTIME_SCHEMA_VERSION,
    writtenByNewerRuntime:
      fileSchemaVersion !== undefined && fileSchemaVersion > RUNTIME_SCHEMA_VERSION,
  };
}

/** Extract the schema version from a parsed session header line. */
export function schemaVersionFromHeaderLine(line: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const header = parsed as { type?: unknown; version?: unknown };
  if (header.type !== "session") {
    return undefined;
  }
  // pi treats a header with no version as v1 (see migrateToCurrentVersion).
  return typeof header.version === "number" ? header.version : 1;
}

/**
 * Read just the header of a session JSONL and return its schema version. Cheap:
 * reads a single bounded chunk from the front, never the whole file (unlike
 * SessionManager.open, which eagerly parses every entry). Mirrors pi's own
 * unexported readSessionHeader. `undefined` if the file is unreadable or its
 * first line is not a session header.
 */
export async function readSessionFileSchemaVersion(filePath: string): Promise<number | undefined> {
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch {
    return undefined;
  }
  try {
    // A session header is a single small JSON object on the first line; one
    // bounded read covers it without parsing the rest of the file.
    const buffer = Buffer.allocUnsafe(16 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === 0) {
      return undefined;
    }
    const chunk = buffer.toString("utf8", 0, bytesRead);
    const newlineIndex = chunk.indexOf("\n");
    return schemaVersionFromHeaderLine(newlineIndex === -1 ? chunk : chunk.slice(0, newlineIndex));
  } finally {
    await handle.close();
  }
}
