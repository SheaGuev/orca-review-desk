// The review queue's order and grouping. Pure, so the panel's order is tested without a worker.
import type { QueueItem } from "./protocol";

const RISK_RANK = { high: 0, medium: 1, low: 2 } as const;

/** High first; a PR with no guide yet counts as medium, so it is neither buried nor promoted. */
export const riskRank = (item: Pick<QueueItem, "risk">): number =>
  item.risk ? RISK_RANK[item.risk] : RISK_RANK.medium;

/** New commits since your review first, then risk high to low, then waited longest first. */
export function compareQueue(a: QueueItem, b: QueueItem): number {
  return (
    Number(b.newSinceYourReview) - Number(a.newSinceYourReview) ||
    riskRank(a) - riskRank(b) ||
    a.requestedAt - b.requestedAt ||
    a.key.localeCompare(b.key)
  );
}

/** `repo` without the owner, unless two items' repos share a name. */
export function repoLabels(repos: readonly string[]): Map<string, string> {
  const byName = new Map<string, Set<string>>();
  for (const r of repos) {
    const name = r.split("/").pop() ?? r;
    byName.set(name, (byName.get(name) ?? new Set()).add(r));
  }
  return new Map(
    repos.map((r) => {
      const name = r.split("/").pop() ?? r;
      return [r, (byName.get(name)?.size ?? 0) > 1 ? r : name];
    }),
  );
}

export type Grouped = { queue: QueueItem[]; notQueued: QueueItem[]; authored: QueueItem[] };

/**
 * Direct and team requests that get a guide (or already have one) form the queue; the rest are
 * Not queued with their reason; your own PRs stay apart.
 */
export function buildQueue(items: readonly QueueItem[]): Grouped {
  const labels = repoLabels([...new Set(items.map((i) => i.repo))]);
  const labelled = items.map((i) => ({ ...i, repoLabel: labels.get(i.repo) ?? i.repo }));
  const requests = labelled.filter((i) => i.lane !== "authored");
  const inQueue = (i: QueueItem) =>
    i.manualReason === null || i.risk !== null || i.status === "ready" || i.status === "stale";
  const queue = requests
    .filter(inQueue)
    .sort(compareQueue)
    .map((i, n) => ({ ...i, position: n + 1 }));
  const notQueued = requests
    .filter((i) => !inQueue(i))
    .sort((a, b) => a.requestedAt - b.requestedAt || a.key.localeCompare(b.key))
    .map((i) => ({ ...i, position: null }));
  const authored = labelled
    .filter((i) => i.lane === "authored")
    .sort(compareQueue)
    .map((i) => ({ ...i, position: null }));
  return { queue, notQueued, authored };
}
