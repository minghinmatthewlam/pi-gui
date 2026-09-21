export type RecencyBucketId = "today" | "last-7-days" | "last-30-days" | "older";

export const RECENCY_BUCKET_ORDER = [
  "today",
  "last-7-days",
  "last-30-days",
  "older",
] as const satisfies readonly RecencyBucketId[];

export const RECENCY_BUCKET_LABELS: Readonly<Record<RecencyBucketId, string>> = {
  today: "Today",
  "last-7-days": "Last 7 Days",
  "last-30-days": "Last 30 Days",
  older: "Older",
};

export function sessionLastInteractedAt(session: {
  readonly lastInteractedAt?: string;
  readonly updatedAt: string;
}): string {
  return session.lastInteractedAt ?? session.updatedAt;
}

export function compareByRecency(
  left: {
    readonly lastInteractedAt?: string;
    readonly updatedAt: string;
    readonly title: string;
  },
  right: {
    readonly lastInteractedAt?: string;
    readonly updatedAt: string;
    readonly title: string;
  },
): number {
  const leftInteractedAt = sessionLastInteractedAt(left);
  const rightInteractedAt = sessionLastInteractedAt(right);
  if (leftInteractedAt !== rightInteractedAt) {
    return rightInteractedAt.localeCompare(leftInteractedAt);
  }
  return left.title.localeCompare(right.title);
}

export function recencyBucketId(isoTimestamp: string, nowMs: number = Date.now()): RecencyBucketId {
  const timestamp = Date.parse(isoTimestamp);
  if (Number.isNaN(timestamp)) {
    return "older";
  }

  const now = new Date(nowMs);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const last7Start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7).getTime();
  const last30Start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30).getTime();

  if (timestamp >= todayStart) {
    return "today";
  }
  if (timestamp >= last7Start) {
    return "last-7-days";
  }
  if (timestamp >= last30Start) {
    return "last-30-days";
  }
  return "older";
}
