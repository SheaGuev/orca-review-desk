// One run from the queue: has the agent write the guide for a PR, stores it, and brings the
// queue row up to date. A failure is recorded on the row, never thrown.
import type { Clones } from "./clones";
import { message } from "./errors";
import { GitTampered } from "./git-guard";
import { prDetails } from "./github";
import type { PrData } from "./pr-data";
import { parsePrKey } from "./repo";
import { RISK_WORD, withoutDetail, type PrGuide } from "./schema";
import type { Store } from "./store";
import type { TourProgress } from "./tour-progress";
import { patchItem, type WorkerState } from "./worker-state";
import { writeGuide } from "./write-guide";

/** Orca refuses a storage value over 256 KiB; leave room for the key and encoding. */
const GUIDE_STORAGE_LIMIT = 250_000;
/** Errors from the agent CLI that mean it has no working sign-in. */
const SIGNED_OUT =
  /not logged in|log ?in required|please (run )?\/?login|not signed in|invalid api key|authenticat/i;

type Deps = {
  state: WorkerState;
  store: Store;
  clones: Clones;
  prData: PrData;
  tours: TourProgress;
  log: (text: string) => void;
  publish: () => void;
  /** Told once the guide is stored, before the person is notified (a command's guide opens here). */
  onWritten: (key: string) => Promise<void>;
  notify: (title: string, body: string) => Promise<void>;
};

/** Stores the guide (without its details when it is too big) and clears the last failure. */
async function keep(store: Store, key: string, guide: PrGuide): Promise<PrGuide> {
  const stored = JSON.stringify(guide).length > GUIDE_STORAGE_LIMIT ? withoutDetail(guide) : guide;
  await store.setGuide(key, stored);
  const meta = await store.meta(key);
  await store.setMeta(key, { lastViewedCommit: meta.lastViewedCommit });
  return stored;
}

/** Has the agent write the guide for `key`; throws when anything on the way fails. */
async function write(deps: Deps, key: string): Promise<{ guide: PrGuide; head: string }> {
  const { state, store } = deps;
  const t = state.tracked.get(key);
  const pr = parsePrKey(key);
  if (!pr) throw new Error(`"${key}" does not name a PR`);
  const clone = t?.clone ?? (await deps.clones.find(pr.repo));
  if (!clone)
    throw new Error(`No local clone of ${pr.repo} in Orca. Add it as a project to make guides.`);
  // A new run replaces the last failure, so a worker restart mid-run never shows a stale error.
  const before = await store.meta(key);
  if (before.error) await store.setMeta(key, { lastViewedCommit: before.lastViewedCommit });
  const details = await prDetails(pr.repo, pr.number);
  const guide = await writeGuide({
    key,
    repo: pr.repo,
    clone,
    pr: details,
    settings: state.settings,
    reviewRequest: t ? t.item.lane : "manual",
    requestedAt: t ? t.item.requestedAt : null,
    lastViewedCommit: async () => (await store.meta(key)).lastViewedCommit,
    triage: deps.prData.triage,
    log: deps.log,
  });
  return { guide, head: details.headRefOid };
}

/** Stores a written guide, brings the queue row up to date, and tells whoever is waiting. */
async function finish(
  deps: Deps,
  key: string,
  written: { guide: PrGuide; head: string },
  automatic: boolean,
): Promise<void> {
  const { state, store, log } = deps;
  const { guide } = written;
  const stored = await keep(store, key, guide);
  state.agentSignedOut = false;
  // Ready before the tab asks; a failure here is retried when the tab asks.
  void deps.prData
    .breakdown(stored, key, stored.pr.commit)
    .catch((e: unknown) => log(`${key}: changes breakdown: ${message(e)}`));
  if (automatic) state.runsToday = await store.countRun();
  const tour = await deps.tours.label(key, guide, await store.tour(key));
  // A check during the run replaces the tracked entry, so it is looked up by key again.
  patchItem(state, key, {
    status: "ready",
    risk: guide.risk.level,
    riskSummary: guide.risk.headline,
    error: null,
    headSha: written.head,
    tour,
  });
  await deps.onWritten(key);
  if (automatic && state.tracked.get(key)?.item.lane === "user")
    await deps.notify(
      `Review guide ready: #${guide.pr.number}`,
      `${RISK_WORD[guide.risk.level]} risk. ${guide.risk.headline}`,
    );
}

/**
 * A run changed its clone's git config or hooks: automatic runs stop for the whole repository
 * (stored, so a restart keeps them off) until the person turns it back on.
 */
async function stopAutomatic(deps: Deps, key: string, paths: readonly string[]): Promise<void> {
  const { state, store } = deps;
  const repo = parsePrKey(key)?.repo;
  if (!repo) return;
  await store.setOptIn(repo, false);
  state.tampered = { key, repo, paths };
  const known = state.repos.get(repo);
  if (known) state.repos.set(repo, { ...known, optIn: false });
  for (let i = state.queued.length - 1; i >= 0; i--) {
    const q = state.queued[i];
    if (q?.automatic && parsePrKey(q.key)?.repo === repo) {
      state.queued.splice(i, 1);
      patchItem(state, q.key, { status: "none" });
    }
  }
  for (const t of state.tracked.values()) {
    if (t.item.repo !== repo) continue;
    t.auto = false;
    t.item = { ...t.item, manualReason: t.item.manualReason ?? "Repository turned off" };
  }
}

/** Records a failed run on the PR's row and in storage, against the head it was started for. */
async function fail(deps: Deps, key: string, e: unknown, head: string | undefined): Promise<void> {
  const { state, store } = deps;
  const error = message(e);
  if (SIGNED_OUT.test(error)) state.agentSignedOut = true;
  deps.log(`${key}: ${error}`);
  if (e instanceof GitTampered) await stopAutomatic(deps, key, e.paths);
  const meta = await store.meta(key);
  await store.setMeta(key, { ...meta, error, errorCommit: head });
  patchItem(state, key, { status: "failed", error });
}

export function createGuideRun(deps: Deps): (key: string, automatic: boolean) => Promise<void> {
  return async function generate(key, automatic) {
    const headBefore = deps.state.tracked.get(key)?.item.headSha;
    try {
      await finish(deps, key, await write(deps, key), automatic);
    } catch (e) {
      await fail(deps, key, e, headBefore);
    } finally {
      deps.publish();
    }
  };
}
