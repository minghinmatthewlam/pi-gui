import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import type { Checks, Issue, PullRequest, ReviewDecision, Source } from "./contract.ts";

// Reads GitHub through the local `gh` CLI with fixed argv, bounded time and output.
// The browser never supplies arguments; it can only ask for a refresh.

const TIMEOUT_MS = 20_000;
const MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_SNAPSHOT = 2 * 1024 * 1024;
const MAX_FAILED_NAMES = 20;
const BODY_EXCERPT = 600;
const OPEN_LIMIT = "50";
const CLOSED_LIMIT = "25";
const PR_FIELDS =
  "number,title,state,isDraft,author,headRefName,createdAt,updatedAt,statusCheckRollup,reviewDecision,url,additions,deletions";
const ISSUE_FIELDS = "number,title,state,author,labels,comments,createdAt,updatedAt,body,url";

export interface Snapshot {
  repo: string;
  capturedAt: string;
  pullRequests: PullRequest[];
  issues: Issue[];
}

export interface Loaded extends Snapshot {
  source: Source;
}

/** The CLI could not be started. Callers fall back to a saved snapshot. */
export class GhMissingError extends Error {
  constructor() {
    super("The GitHub CLI (gh) is not installed or not on PATH.");
  }
}

export interface LoadOptions {
  cwd: string;
  signal: AbortSignal;
  env: NodeJS.ProcessEnv;
  /** Saved snapshot used when `gh` cannot be started. */
  fallbackSnapshot: string;
  /** Executable name or path; tests pass a fake. */
  gh?: string;
}

export async function loadRepository(options: LoadOptions): Promise<Loaded> {
  const configured = options.env.PI_GUI_GITHUB_FIXTURE?.trim();
  if (configured) return fromSnapshot(await readSnapshot(configured), "configured");
  try {
    return await loadLive(options);
  } catch (error) {
    if (!(error instanceof GhMissingError)) throw error;
    return fromSnapshot(await readSnapshot(options.fallbackSnapshot), "gh-missing");
  }
}

function fromSnapshot(snapshot: Snapshot, reason: "configured" | "gh-missing"): Loaded {
  return { ...snapshot, source: { kind: "snapshot", capturedAt: snapshot.capturedAt, reason } };
}

export async function loadLive(options: LoadOptions): Promise<Loaded> {
  const gh = (args: string[]) => run(options.gh ?? "gh", args, options);
  const repoInfo = record(JSON.parse(await gh(["repo", "view", "--json", "nameWithOwner"])));
  const repo = string(repoInfo.nameWithOwner, 200);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("GitHub returned an invalid repository.");
  const list = async (kind: "pr" | "issue", state: "open" | "closed", fields: string) =>
    array(
      JSON.parse(
        await gh([
          kind,
          "list",
          "--state",
          state,
          "--limit",
          state === "open" ? OPEN_LIMIT : CLOSED_LIMIT,
          "--json",
          fields,
        ]),
      ),
    );
  const [openPrs, closedPrs, openIssues, closedIssues] = await Promise.all([
    list("pr", "open", PR_FIELDS),
    list("pr", "closed", PR_FIELDS),
    list("issue", "open", ISSUE_FIELDS),
    list("issue", "closed", ISSUE_FIELDS),
  ]);
  return {
    repo,
    capturedAt: new Date().toISOString(),
    pullRequests: byUpdated(unique([...openPrs, ...closedPrs].map(normalizePullRequest))),
    issues: byUpdated(unique([...openIssues, ...closedIssues].map(normalizeIssue))),
    source: { kind: "live" },
  };
}

async function run(program: string, args: string[], options: LoadOptions): Promise<string> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    execFile(
      program,
      args,
      {
        cwd: options.cwd,
        env: { ...options.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", GIT_OPTIONAL_LOCKS: "0" },
        signal: options.signal,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        if (options.signal.aborted) {
          reject(options.signal.reason);
          return;
        }
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new GhMissingError());
          return;
        }
        reject(new Error(describeGhFailure(String(stderr || error.message))));
      },
    );
  });
}

export function describeGhFailure(stderr: string): string {
  const text = stderr.trim();
  if (/not a git repository|no git remotes|none of the git remotes/i.test(text))
    return "This folder isn't a GitHub repository. Open a project with a GitHub remote, then refresh.";
  if (/gh auth login|not logged in|authentication/i.test(text))
    return "The GitHub CLI isn't signed in. Run gh auth login, then refresh.";
  return `gh could not read this repository: ${text.slice(0, 400)}`;
}

export async function readSnapshot(path: string): Promise<Snapshot> {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_SNAPSHOT)
    throw new Error("The GitHub snapshot must be a JSON file of at most 2 MiB.");
  const raw = record(JSON.parse(await readFile(path, "utf8")));
  return {
    repo: string(raw.repo, 200),
    capturedAt: date(raw.capturedAt),
    pullRequests: byUpdated(array(raw.pullRequests).map(snapshotPullRequest)),
    issues: byUpdated(array(raw.issues).map(snapshotIssue)),
  };
}

// ---- gh JSON --------------------------------------------------------------------------

export function normalizePullRequest(value: unknown): PullRequest {
  const raw = record(value);
  const state = string(raw.state, 20).toLowerCase();
  return {
    number: positive(raw.number),
    title: string(raw.title, 400),
    state: state === "merged" ? "merged" : state === "closed" ? "closed" : "open",
    draft: raw.isDraft === true,
    author: login(raw.author),
    branch: optionalString(raw.headRefName, 255),
    createdAt: date(raw.createdAt),
    updatedAt: date(raw.updatedAt),
    checks: summarizeChecks(raw.statusCheckRollup),
    review: reviewDecision(raw.reviewDecision),
    url: githubUrl(raw.url),
    additions: count(raw.additions),
    deletions: count(raw.deletions),
  };
}

export function normalizeIssue(value: unknown): Issue {
  const raw = record(value);
  return {
    number: positive(raw.number),
    title: string(raw.title, 400),
    state: string(raw.state, 20).toLowerCase() === "closed" ? "closed" : "open",
    author: login(raw.author),
    labels: Array.isArray(raw.labels)
      ? raw.labels
          .map((label) => optionalString(isRecord(label) ? label.name : label, 60))
          .filter(Boolean)
          .slice(0, 8)
      : [],
    comments: Array.isArray(raw.comments) ? raw.comments.length : (count(raw.comments) ?? 0),
    createdAt: date(raw.createdAt),
    updatedAt: date(raw.updatedAt),
    body: excerpt(raw.body),
    url: githubUrl(raw.url),
  };
}

const FAILED = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "ERROR",
]);
const PENDING = new Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);

/** Collapse gh's statusCheckRollup (CheckRun and StatusContext items) into one summary. */
export function summarizeChecks(value: unknown): Checks {
  const items = Array.isArray(value) ? value.filter(isRecord) : [];
  const failed: string[] = [];
  let passed = 0;
  let pending = 0;
  for (const item of items) {
    const name = optionalString(item.name ?? item.context, 200) || "Unnamed check";
    const status = optionalString(item.status, 40).toUpperCase();
    const outcome = optionalString(item.conclusion ?? item.state, 40).toUpperCase();
    if (FAILED.has(outcome)) failed.push(name);
    else if (PENDING.has(outcome) || (status && status !== "COMPLETED")) pending += 1;
    else passed += 1;
  }
  const state = failed.length ? "failing" : pending ? "pending" : items.length ? "passing" : "none";
  return { state, failed: failed.slice(0, MAX_FAILED_NAMES), passed, total: items.length };
}

function reviewDecision(value: unknown): ReviewDecision {
  switch (value) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "review_required";
    default:
      return "none";
  }
}

// ---- saved snapshot -------------------------------------------------------------------

function snapshotPullRequest(value: unknown): PullRequest {
  const raw = record(value);
  const checks = record(raw.checks);
  const checkState = checks.state;
  const state = raw.state;
  return {
    number: positive(raw.number),
    title: string(raw.title, 400),
    state: state === "merged" || state === "closed" ? state : "open",
    draft: raw.draft === true,
    author: optionalString(raw.author, 80) || "unknown",
    branch: optionalString(raw.branch, 255),
    createdAt: date(raw.createdAt),
    updatedAt: date(raw.updatedAt),
    checks: {
      state:
        checkState === "passing" || checkState === "failing" || checkState === "pending"
          ? checkState
          : "none",
      failed: array(checks.failed)
        .map((name) => optionalString(name, 200))
        .filter(Boolean)
        .slice(0, MAX_FAILED_NAMES),
      passed: count(checks.passed) ?? 0,
      total: count(checks.total) ?? 0,
    },
    review: reviewDecision(typeof raw.review === "string" ? raw.review.toUpperCase() : null),
    url: githubUrl(raw.url),
    additions: count(raw.additions),
    deletions: count(raw.deletions),
  };
}

function snapshotIssue(value: unknown): Issue {
  const raw = record(value);
  return normalizeIssue({ ...raw, author: { login: raw.author } });
}

// ---- validation helpers ---------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("GitHub returned unexpected data.");
  return value;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("GitHub returned unexpected data.");
  return value.slice(0, 200);
}

function string(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("GitHub returned an empty field.");
  return value.slice(0, max);
}

function optionalString(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error("GitHub returned an invalid number.");
  return value as number;
}

function count(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function date(value: unknown): string {
  const text = string(value, 40);
  if (Number.isNaN(Date.parse(text))) throw new Error("GitHub returned an invalid date.");
  return text;
}

function login(value: unknown): string {
  return (isRecord(value) ? optionalString(value.login, 80) : "") || "ghost";
}

function githubUrl(value: unknown): string {
  const url = new URL(string(value, 500));
  if (url.protocol !== "https:" || url.hostname.endsWith(".") || !url.hostname.includes("."))
    throw new Error("GitHub returned an invalid URL.");
  return url.href;
}

/** Plain-text excerpt: drops HTML comments (issue templates) and collapses blank runs. */
export function excerpt(value: unknown): string {
  const text = optionalString(value, 20_000)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > BODY_EXCERPT ? `${text.slice(0, BODY_EXCERPT).trimEnd()}…` : text;
}

function unique<T extends { number: number }>(items: T[]): T[] {
  const seen = new Set<number>();
  return items.filter((item) => !seen.has(item.number) && seen.add(item.number));
}

function byUpdated<T extends { updatedAt: string }>(items: T[]): T[] {
  return items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
