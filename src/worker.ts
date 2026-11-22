// The plugin's worker: finds the PRs waiting for your review, has an agent write a guide for each,
// keeps them current as authors push, and opens them in Orca. The status bar item keeps it
// running while the plugin is enabled, so it can poll.
//
// This file only puts the parts together. What the worker knows is in src/worker-state.ts; what
// it does is in src/queue-check.ts (asking GitHub), src/run-queue.ts and src/guide-run.ts (agent
// runs), src/review-service.ts (reviews), src/open-guide.ts, src/focus.ts (the status bar) and
// src/requests.ts (what the panel and the guide tab ask).
import type { OrcaWorkerApi } from "orca/worker";
import { createClones, type Clones } from "./clones";
import { fail, message } from "./errors";
import { loadLoginPath } from "./exec";
import { createFocus, type Focus } from "./focus";
import { prDetails, rateLimitReset } from "./github";
import { createGuideRun } from "./guide-run";
import { createOpener, type Opener } from "./open-guide";
import { createPrData } from "./pr-data";
import { createQueueCheck } from "./queue-check";
import { buildItem, restoreItem, type PrFound, type Tracked } from "./queue-items";
import { prKey } from "./repo";
import { registerRequests } from "./requests";
import { removeStaleRuns } from "./run-files";
import { createReviewService, type ReviewService } from "./review-service";
import { createRunQueue, type RunQueue } from "./run-queue";
import { readSettings } from "./settings";
import { createStore, type SavedPr, type Store, type StoredGuide } from "./store";
import { createTourProgress } from "./tour-progress";
import {
  createWorkerState,
  isRateLimit,
  patchItem,
  queueStateOf,
  rateLimited,
  runState,
  type WorkerState,
} from "./worker-state";

/** How often GitHub is checked; cheap, since an unchanged PR costs no call beyond its search. */
const POLL_MS = 2 * 60_000;
/** A restart this soon after the last check lists the saved PRs and leaves checking to the poll. */
const RECENT_CHECK_MS = 2 * 60_000;
/** Waits after checks hit the rate limit in a row, when GitHub gives no reset time. */
const RATE_LIMIT_BACKOFF_MS = [5, 10, 20, 40, 60].map((m) => m * 60_000);
/** Guides of PRs that left the queue are forgotten after this long. */
const KEEP_GUIDES_MS = 14 * 24 * 60 * 60_000;

let stopTimers: () => void = () => undefined;

/** Clears the poll and settle timers before Orca stops the worker. */
export function deactivate(): void {
  stopTimers();
}

/** The parts every action below needs. */
type Parts = {
  state: WorkerState;
  store: Store;
  clones: Clones;
  focus: Focus;
  opener: Opener;
  log: (text: string) => void;
  publish: () => void;
  /** The PR as the queue shows it now, read from storage and the local clone. */
  itemFor: (pr: PrFound) => Promise<Tracked>;
  /** A PR the last check saved, as the queue shows it now. */
  restoreItem: (saved: SavedPr) => Promise<Tracked>;
};

async function requireGuide(store: Store, key: string): Promise<StoredGuide> {
  const guide = await store.guide(key);
  if (!guide) throw fail("unavailable", "No guide for this PR yet");
  return guide;
}

/** Opens the stored guide and records the commit the person saw, for "Since your last review". */
async function openGuide(p: Parts, key: string): Promise<void> {
  const guide = await requireGuide(p.store, key);
  await p.opener.open(guide);
  const meta = await p.store.meta(key);
  await p.store.setMeta(key, { ...meta, lastViewedCommit: guide.pr.commit });
  patchItem(p.state, key, { newSinceYourReview: false });
  p.state.openKey = key;
  p.publish();
}

/** The focused branch's PR, tracked if it is in the queue, else looked up for a manual run. */
async function focusedKey(p: Parts): Promise<string> {
  const f = await p.focus.pr();
  if (!f) throw fail("unavailable", "Focus a workspace of a GitHub repository first");
  const t = p.focus.trackedFor(f.repo, f.branch);
  if (t) return t.item.key;
  const details = await prDetails(f.repo, f.branch).catch(() => null);
  if (!details) throw fail("unavailable", `No open PR for ${f.branch}`);
  const key = prKey(f.repo, details.number);
  const built = await p.itemFor({
    key,
    repo: f.repo,
    lane: "authored",
    details,
    clone: await p.clones.find(f.repo),
    team: null,
    requestedAt: Date.parse(details.createdAt) || Date.now(),
    association: null,
  });
  p.state.tracked.set(key, { ...built, auto: false });
  return key;
}

/** Opens a just-written guide when a command asked for it; a failure to open is only logged. */
async function openIfAsked(p: Parts, asked: Set<string>, key: string): Promise<void> {
  if (!asked.delete(key)) return;
  await openGuide(p, key).catch((e: unknown) =>
    p.log(`${key}: could not open the guide: ${message(e)}`),
  );
}

/** Keeps the queue row's pending-comment count in step with the stored draft. */
function showPending(p: Parts, key: string, count: number): void {
  const t = p.state.tracked.get(key);
  if (!t || t.item.pendingComments === count) return;
  patchItem(p.state, key, { pendingComments: count });
  p.publish();
}

/**
 * After a check hit the rate limit: automatic checks wait until GitHub's reset for the resources
 * used up, else for a backoff that grows with each limited check in a row.
 */
async function holdForRateLimit(state: WorkerState): Promise<void> {
  const strikes = (state.rateLimit?.strikes ?? 0) + 1;
  const reset = await rateLimitReset();
  const now = Date.now();
  // A reset already past says nothing about when the limit lifts.
  state.rateLimit =
    reset !== null && reset > now
      ? { resumeAt: reset, fromGitHub: true, strikes }
      : {
          resumeAt: now + (RATE_LIMIT_BACKOFF_MS[strikes - 1] ?? RATE_LIMIT_BACKOFF_MS.at(-1) ?? 0),
          fromGitHub: false,
          strikes,
        };
}

/**
 * `refresh`: one check of GitHub at a time, shared by everyone who asks meanwhile. Each check
 * then queues the automatic runs now due (`afterCheck`) and forgets guides long gone.
 */
function createRefresh(
  p: Parts,
  check: () => Promise<void>,
  afterCheck: () => void,
): () => Promise<void> {
  let checking: Promise<void> | null = null;
  const checkOnce = async (): Promise<void> => {
    p.focus.forget();
    await check();
    afterCheck();
    await p.store
      .prune((key) => p.state.tracked.has(key), Date.now() - KEEP_GUIDES_MS)
      .catch((e: unknown) => p.log(`prune: ${message(e)}`));
  };
  return () => {
    if (checking) return checking;
    const run = checkOnce()
      .catch(async (e: unknown) => {
        p.state.lastError = message(e);
        p.log(`check failed: ${p.state.lastError}`);
        if (isRateLimit(p.state.lastError)) await holdForRateLimit(p.state);
      })
      .finally(() => {
        checking = null;
        p.state.checking = false;
        p.publish();
      });
    checking = run;
    p.state.checking = true;
    p.publish();
    return run;
  };
}

/** The review service, told where the queue keeps a PR's head and its pending count. */
const reviewsFor = (p: Parts, refresh: () => Promise<void>): ReviewService =>
  createReviewService({
    store: p.store,
    clones: p.clones,
    requireGuide: (key) => requireGuide(p.store, key),
    headOf: (key) => p.state.tracked.get(key)?.item.headSha,
    onPending: (key, count) => showPending(p, key, count),
    onPosted: () => void refresh(),
    log: p.log,
  });

/** Storage, state and the parts with no behaviour of their own to wire. */
async function createParts(orca: OrcaWorkerApi) {
  const log = (text: string): void => orca.log(text);
  const store = createStore(orca.storage);
  const settingsNow = async () => readSettings(await orca.settings.get());
  const state = createWorkerState(await settingsNow(), await store.runsToday());
  const clones = createClones(async () => (await orca.host.call("project.list")).projects);
  const prData = createPrData({
    log,
    cloneOf: async (key, repo) => state.tracked.get(key)?.clone ?? (await clones.find(repo)),
  });
  const tours = createTourProgress({ skipped: prData.skipped, log });
  const focus = createFocus({ host: orca.host, state, log });
  const itemDeps = (key: string) => ({
    store,
    settings: state.settings,
    run: runState(state, key),
    tourLabel: tours.label,
  });
  const parts: Parts = {
    state,
    store,
    clones,
    focus,
    opener: createOpener({ host: orca.host, clones, log }),
    log,
    publish: () => {
      orca.panels.post("queue.changed", queueStateOf(state));
      void focus.showStatusBar();
    },
    itemFor: (pr) => buildItem(pr, itemDeps(pr.key)),
    restoreItem: (saved) => restoreItem(saved, itemDeps(saved.key)),
  };
  return { parts, prData, tours, settingsNow };
}

/** Run folders left by a crash hold a PR's files; cleared before any run starts. */
async function clearOldRuns(orca: OrcaWorkerApi, log: (text: string) => void): Promise<void> {
  try {
    const { projects } = await orca.host.call("project.list");
    const local = projects.filter((p) => p.kind === "git" && (!p.hostId || p.hostId === "local"));
    await removeStaleRuns(local.map((p) => p.path));
  } catch (e) {
    log(`could not remove old run files: ${message(e)}`);
  }
}

/** Whether the list restored at startup was checked too recently to check again yet. */
function checkedRecently(state: WorkerState): boolean {
  const since = state.checkedAt === null ? null : Date.now() - state.checkedAt;
  return since !== null && since >= 0 && since < RECENT_CHECK_MS;
}

/**
 * Before the first check: the login shell's PATH, no run folders left by a crash, and the list
 * from before a restart shown until the check replaces it.
 */
async function beforeFirstCheck(
  orca: OrcaWorkerApi,
  p: Parts,
  restore: () => Promise<void>,
): Promise<void> {
  await loadLoginPath();
  await clearOldRuns(orca, p.log);
  await restore().catch((e: unknown) => p.log(`could not restore the list: ${message(e)}`));
  p.publish();
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  const { parts, prData, tours, settingsNow } = await createParts(orca);
  const { state, store, clones, focus, opener, log, publish } = parts;
  /** Guides started from a command open themselves when they are written. */
  const openWhenReady = new Set<string>();
  const queue = createQueueCheck({ ...parts, readSettings: settingsNow });
  const refresh = createRefresh(parts, queue.check, () => runs.scheduleAutomatic());
  /** A check nobody asked for (the poll, a restart, pushes settling) waits out a rate limit. */
  const autoRefresh = (): Promise<void> => (rateLimited(state) ? Promise.resolve() : refresh());
  const generate = createGuideRun({
    state,
    store,
    clones,
    prData,
    tours,
    log,
    publish,
    onWritten: (key) => openIfAsked(parts, openWhenReady, key),
    notify: async (title, body) => {
      await orca.host.call("notifications.show", { title, body }).catch(() => undefined);
    },
  });
  const runs: RunQueue = createRunQueue({ state, generate, publish, refresh: autoRefresh });
  const reviews = reviewsFor(parts, refresh);
  registerRequests(orca, {
    state,
    store,
    prData,
    tours,
    reviews,
    opener,
    runs,
    focus,
    queueState: () => queueStateOf(state),
    publish,
    refresh,
    requireGuide: (key) => requireGuide(store, key),
    openGuide: (key) => openGuide(parts, key),
    focusedKey: () => focusedKey(parts),
    generateAndOpen: (key) => {
      openWhenReady.add(key);
      runs.enqueue(key, false);
    },
  });

  await beforeFirstCheck(orca, parts, queue.restore);
  const poll = setInterval(() => void autoRefresh(), POLL_MS);
  stopTimers = () => {
    clearInterval(poll);
    runs.stop();
  };
  if (!checkedRecently(state)) void autoRefresh();
}
