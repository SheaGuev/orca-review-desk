// What the worker knows between requests: the PRs it follows, the runs under way, and the facts
// the panel's one notice line is made from. One object, so each part of the worker says which of
// it it reads and changes.
import type { Notice, QueueItem, QueueState, RepoState } from "./protocol";
import { buildQueue } from "./queue";
import type { RunState, Tracked } from "./queue-items";
import { agentLabel, harnessName, type Settings } from "./settings";

/** A run waiting its turn, with how it was started: only automatic ones count against the daily limit. */
export type QueuedRun = { key: string; automatic: boolean };

export type WorkerState = {
  /** The PRs found by the last check (and any opened by a command), by key. */
  readonly tracked: Map<string, Tracked>;
  readonly repos: Map<string, RepoState>;
  readonly generating: Set<string>;
  readonly queued: QueuedRun[];
  settings: Settings;
  /** Automatic runs counted today. */
  runsToday: number;
  checking: boolean;
  checkedAt: number | null;
  /** Why the last check failed; null once one works. */
  lastError: string | null;
  /**
   * After checks hit GitHub's rate limit: automatic checks and runs wait until `resumeAt`,
   * `fromGitHub` when that is GitHub's own reset time; `strikes` counts the checks limited in a
   * row. Null once a check works.
   */
  rateLimit: { resumeAt: number; fromGitHub: boolean; strikes: number } | null;
  /** The last agent run failed for want of a sign-in; cleared by the next run that works. */
  agentSignedOut: boolean;
  /** The label of the agent whose CLI the last run could not find; cleared by the next run that works. */
  agentMissing: string | null;
  /** QueueState.openKey: the guide last opened or moved through. */
  openKey: string | null;
  /** The last run that changed its clone's git config or hooks; cleared when its repo is turned on. */
  tampered: { key: string; repo: string; paths: readonly string[] } | null;
};

export const createWorkerState = (settings: Settings, runsToday: number): WorkerState => ({
  tracked: new Map(),
  repos: new Map(),
  generating: new Set(),
  queued: [],
  settings,
  runsToday,
  checking: false,
  checkedAt: null,
  lastError: null,
  rateLimit: null,
  agentSignedOut: false,
  agentMissing: null,
  openKey: null,
  tampered: null,
});

/** Replaces fields of a tracked PR's queue item; a PR no longer tracked is left alone. */
export function patchItem(state: WorkerState, key: string, patch: Partial<QueueItem>): void {
  const t = state.tracked.get(key);
  if (t) t.item = { ...t.item, ...patch };
}

/** What an agent run is doing for `key` right now, if anything. */
export function runState(state: WorkerState, key: string): RunState {
  if (state.generating.has(key)) return "generating";
  return state.queued.some((q) => q.key === key) ? "queued" : null;
}

/** Whether a check failed for GitHub's rate limit, by its error text. */
export const isRateLimit = (error: string): boolean => /rate limit/i.test(error);

/** Whether automatic checks and runs wait for GitHub's rate limit to lift. */
export const rateLimited = (state: WorkerState): boolean =>
  state.rateLimit !== null && Date.now() < state.rateLimit.resumeAt;

const clock = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** "a, b", or "a, b and 3 more". */
const someOf = (paths: readonly string[]): string =>
  paths.length > 2
    ? `${paths.slice(0, 2).join(", ")} and ${paths.length - 2} more`
    : paths.join(", ");

/**
 * The one status line the panel shows: a tampering run, GitHub unreachable or rate-limited, agent not installed or
 * signed out, daily limit.
 */
function notice(state: WorkerState, items: readonly QueueItem[]): Notice | null {
  const { settings, checkedAt, tampered } = state;
  if (tampered)
    return {
      tone: "danger",
      text: `The run for ${tampered.key.slice(tampered.repo.length)} changed ${someOf(tampered.paths)} in ${tampered.repo} · automatic guides are off until you have checked the clone`,
      turnOn: tampered.repo,
    };
  if (state.lastError) {
    const limit = state.rateLimit;
    if (isRateLimit(state.lastError) && limit?.fromGitHub && rateLimited(state))
      return {
        tone: "warning",
        text: `GitHub rate limit reached · checks resume at ${clock(limit.resumeAt)}`,
      };
    const what = isRateLimit(state.lastError)
      ? "GitHub rate limit reached"
      : "Couldn't reach GitHub";
    return {
      tone: "warning",
      text: `${what}${checkedAt === null ? "" : ` · last checked ${clock(checkedAt)}`}`,
    };
  }
  if (state.agentMissing)
    return {
      tone: "danger",
      text: `${state.agentMissing} isn't installed · install it, then Generate`,
    };
  if (state.agentSignedOut)
    return {
      tone: "danger",
      text: `${harnessName(settings.harness)} is not signed in · sign in from a terminal, then Generate`,
    };
  const waiting = items.some(
    (i) =>
      i.manualReason === null &&
      (i.status === "none" || i.status === "stale") &&
      state.tracked.get(i.key)?.auto,
  );
  if (waiting && state.runsToday >= settings.dailyLimit)
    return {
      tone: "warning",
      text: "Automatic guides paused until tomorrow · Generate still works",
    };
  return null;
}

/** Everything the panel draws, from the state as it is now. */
export function queueStateOf(state: WorkerState): QueueState {
  const items = [...state.tracked.values()].map((t) => t.item);
  return {
    ...buildQueue(items),
    repos: [...state.repos.values()].sort((a, b) => a.repo.localeCompare(b.repo)),
    checking: state.checking,
    checkedAt: state.checkedAt,
    notice: notice(state, items),
    agentLabel: agentLabel(state.settings),
    includeAuthored: state.settings.includeAuthored,
    openKey: state.openKey,
  };
}
