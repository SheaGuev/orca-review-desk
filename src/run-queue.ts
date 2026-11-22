// Agent runs, one at a time: the ones a person asked for and the automatic ones, which wait for
// pushes to settle and stop at the daily limit.
import { patchItem, rateLimited, runState, type WorkerState } from "./worker-state";

/** After an author pushes, wait this long for more pushes before updating the guide. */
const SETTLE_MS = 90_000;

export type RunQueue = {
  /** Adds a run for `key` unless one is waiting or under way. */
  enqueue: (key: string, automatic: boolean) => void;
  /** Queues an automatic run for every tracked PR that is due one. */
  scheduleAutomatic: () => void;
  /** Clears the settle timers. */
  stop: () => void;
};

type Deps = {
  state: WorkerState;
  /** Writes the guide for `key`; never throws. */
  generate: (key: string, automatic: boolean) => Promise<void>;
  publish: () => void;
  refresh: () => Promise<void>;
};

/** The queue's own bookkeeping, beside the runs in the worker's state. */
type Queue = {
  deps: Deps;
  /** When each stale PR's current head was first seen. */
  firstSeen: Map<string, { sha: string; at: number }>;
  timers: Set<ReturnType<typeof setTimeout>>;
  draining: boolean;
};

/** Checks again once pushes have had time to settle. */
function refreshAfterSettle(q: Queue): void {
  const timer = setTimeout(() => {
    q.timers.delete(timer);
    void q.deps.refresh();
  }, SETTLE_MS + 1_000);
  q.timers.add(timer);
}

/** One run at a time, in the order they were asked for. */
async function drain(q: Queue): Promise<void> {
  const { state } = q.deps;
  if (q.draining) return;
  q.draining = true;
  try {
    for (let next = state.queued.shift(); next; next = state.queued.shift()) {
      state.generating.add(next.key);
      patchItem(state, next.key, { status: "generating" });
      q.deps.publish();
      try {
        await q.deps.generate(next.key, next.automatic);
      } finally {
        state.generating.delete(next.key);
      }
    }
  } finally {
    q.draining = false;
  }
}

function enqueue(q: Queue, key: string, automatic: boolean): void {
  const { state } = q.deps;
  if (runState(state, key)) return;
  state.queued.push({ key, automatic });
  patchItem(state, key, { status: "queued", error: null });
  q.deps.publish();
  void drain(q);
}

/** Whether the author has stopped pushing to a stale PR for long enough to spend a run on it. */
function settled(q: Queue, key: string, head: string, now: number): boolean {
  const seen = q.firstSeen.get(key);
  if (seen?.sha !== head) {
    q.firstSeen.set(key, { sha: head, at: now });
    refreshAfterSettle(q);
    return false;
  }
  return now - seen.at >= SETTLE_MS;
}

function scheduleAutomatic(q: Queue): void {
  const { state } = q.deps;
  // GitHub's rate limit holds automatic runs too; a run you ask for still starts.
  if (rateLimited(state)) return;
  const now = Date.now();
  for (const t of state.tracked.values()) {
    const { item } = t;
    if (!t.auto || (item.status !== "none" && item.status !== "stale")) continue;
    if (item.status === "stale" && !settled(q, item.key, item.headSha, now)) continue;
    const spent = state.runsToday + state.queued.length + state.generating.size;
    if (spent >= state.settings.dailyLimit) break;
    enqueue(q, item.key, true);
  }
}

export function createRunQueue(deps: Deps): RunQueue {
  const q: Queue = { deps, firstSeen: new Map(), timers: new Set(), draining: false };
  return {
    enqueue: (key, automatic) => enqueue(q, key, automatic),
    scheduleAutomatic: () => scheduleAutomatic(q),
    stop: () => {
      for (const timer of q.timers) clearTimeout(timer);
      q.timers.clear();
    },
  };
}
