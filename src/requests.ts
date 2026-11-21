// The requests the panel and the guide tab make of the worker, and the commands in Orca's
// palette. Inputs come from frames, so each is checked here before anything acts on it.
import type { OrcaWorkerApi } from "orca/worker";
import { fail, isCommit, optionalCommit } from "./errors";
import type { Focus } from "./focus";
import { isObj } from "./json";
import type { Opener } from "./open-guide";
import type { PrData } from "./pr-data";
import type { QueueState } from "./protocol";
import { prKey } from "./repo";
import { asDraft, REVIEW_EVENTS, type ReviewEvent } from "./review";
import type { ReviewService } from "./review-service";
import type { RunQueue } from "./run-queue";
import type { Store, StoredGuide } from "./store";
import { stopCount, tourState, type TourState } from "./tour";
import type { TourProgress } from "./tour-progress";
import { patchItem, type WorkerState } from "./worker-state";

export type WorkerApi = {
  state: WorkerState;
  store: Store;
  prData: PrData;
  tours: TourProgress;
  reviews: ReviewService;
  opener: Opener;
  runs: RunQueue;
  focus: Focus;
  queueState: () => QueueState;
  publish: () => void;
  refresh: () => Promise<void>;
  /** The stored guide for `key`; throws `unavailable` when there is none. */
  requireGuide: (key: string) => Promise<StoredGuide>;
  /** Opens the stored guide for `key` and records that the person saw it. */
  openGuide: (key: string) => Promise<void>;
  /** The focused branch's PR, tracked if it is in the queue, else looked up for a manual run. */
  focusedKey: () => Promise<string>;
  /** Queues a run whose guide opens when it is written. */
  generateAndOpen: (key: string) => void;
};

const isReviewEvent = (v: unknown): v is ReviewEvent => REVIEW_EVENTS.some((event) => event === v);

/** Tour progress as the guide tab reads and saves it. */
function tourRequests(api: WorkerApi) {
  const { state, store } = api;
  return {
    async get(key: string, commitIn: unknown, stops: unknown): Promise<TourState> {
      const asked = optionalCommit(commitIn);
      if (typeof stops !== "number" || !Number.isInteger(stops) || stops < 0)
        throw fail("invalid", "Expected a number of stops");
      const commit = asked ?? (await api.requireGuide(key)).pr.commit;
      return tourState(await store.tour(key), commit, stops);
    },
    async save(key: string, value: unknown): Promise<void> {
      const guide = await api.requireGuide(key);
      const commit = isObj(value) ? value.commit : undefined;
      if (!isCommit(commit)) throw fail("invalid", "Expected a tour state");
      // Normalised against the guide the tab shows (its commit), so storage only holds plain JSON.
      const shape = await api.tours.shape(key, guide);
      const stops = shape ? stopCount(shape) : 0;
      const clean = tourState(
        value,
        commit,
        commit === guide.pr.commit ? stops : Number.MAX_SAFE_INTEGER,
      );
      await store.setTour(key, clean);
      // Moving through a guide tab makes it the one the panel marks as current.
      const reopened = state.openKey !== key;
      state.openKey = key;
      const t = state.tracked.get(key);
      const tour = t ? await api.tours.label(key, guide, clean) : null;
      const moved = t !== undefined && tour !== t.item.tour;
      if (moved) patchItem(state, key, { tour });
      if (reopened || moved) api.publish();
    },
  };
}

/** What the guide tab asks about a guide at a commit (default: the stored guide's own). */
function registerGuideData(orca: OrcaWorkerApi, api: WorkerApi): void {
  const { prData } = api;
  orca.panels.handle("diff.get", async ({ key, path, commit }) => {
    if (typeof path !== "string" || !path || path.includes("\0"))
      throw fail("invalid", "Expected a file path");
    const asked = optionalCommit(commit);
    const guide = await api.requireGuide(key);
    return prData.fileDiff(guide, key, asked ?? guide.pr.commit, path);
  });
  orca.panels.handle("breakdown.get", async ({ key, commit }) => {
    const asked = optionalCommit(commit);
    const guide = await api.requireGuide(key);
    return prData.breakdown(guide, key, asked ?? guide.pr.commit);
  });
  orca.panels.handle("skipped.get", async ({ key, commit }) => {
    const asked = optionalCommit(commit);
    const guide = await api.requireGuide(key);
    return prData.skipped(guide, key, asked ?? guide.pr.commit);
  });
  orca.panels.handle("file.open", async ({ repo, number, path }) => {
    const guide = await api.store.guide(prKey(repo, number));
    await api.opener.openFile(repo, guide?.pr.headRef ?? null, path);
    return { opened: true };
  });
}

function registerReview(orca: OrcaWorkerApi, api: WorkerApi): void {
  const { reviews } = api;
  const tour = tourRequests(api);
  orca.panels.handle("review.get", ({ key }) => reviews.info(key));
  orca.panels.handle("review.save", async ({ key, draft }) => {
    const guide = await api.requireGuide(key);
    await reviews.save(key, asDraft(draft, guide.pr.commit));
    return { saved: true as const };
  });
  orca.panels.handle("review.submit", ({ key, event, body }) => {
    if (!isReviewEvent(event)) throw fail("invalid", "Unknown review event");
    return reviews.submit(key, event, typeof body === "string" ? body : "");
  });
  orca.panels.handle("tour.get", ({ key, commit, stops }) => tour.get(key, commit, stops));
  orca.panels.handle("tour.save", async ({ key, state }) => {
    await tour.save(key, state);
    return { saved: true as const };
  });
}

function registerQueue(orca: OrcaWorkerApi, api: WorkerApi): void {
  const refreshed = async (): Promise<QueueState> => {
    await api.refresh();
    return api.queueState();
  };
  orca.panels.handle("queue.get", () => api.queueState());
  orca.panels.handle("queue.refresh", refreshed);
  orca.panels.handle("repo.setOptIn", async ({ repo, optIn }) => {
    await api.store.setOptIn(repo, optIn);
    return refreshed();
  });
  orca.panels.handle("lane.showAuthored", async ({ show }) => {
    await orca.settings.set("includeAuthored", show);
    return refreshed();
  });
  orca.panels.handle("guide.generate", ({ key }) => {
    if (!api.state.tracked.has(key)) throw fail("conflict", "That PR is no longer in your queue");
    api.runs.enqueue(key, false);
    return api.queueState();
  });
  orca.panels.handle("guide.open", async ({ key }) => {
    await api.openGuide(key);
    return { opened: true };
  });
}

function registerCommands(orca: OrcaWorkerApi, api: WorkerApi): void {
  orca.commands.register("refresh", async () => {
    await api.refresh();
    const waiting = api.queueState().queue.length;
    return api.state.lastError
      ? `Could not check GitHub: ${api.state.lastError}`
      : `${waiting} PR${waiting === 1 ? "" : "s"} in your review queue`;
  });
  orca.commands.register("openCurrent", async () => {
    const key = await api.focusedKey();
    if (await api.store.guide(key)) {
      await api.openGuide(key);
      return "Opened the review guide";
    }
    api.generateAndOpen(key);
    return "No guide for this PR yet: writing one now. It opens when it is ready.";
  });
  orca.commands.register("generateCurrent", async () => {
    const key = await api.focusedKey();
    api.generateAndOpen(key);
    return `Writing a review guide for ${key}. It opens when it is ready.`;
  });
}

export function registerRequests(orca: OrcaWorkerApi, api: WorkerApi): void {
  registerQueue(orca, api);
  registerReview(orca, api);
  registerGuideData(orca, api);
  registerCommands(orca, api);
  orca.events.on("workspace.changed", ({ context }) => {
    api.focus.set(context ? { workspaceId: context.workspaceId, branch: context.branch } : null);
    void api.focus.showStatusBar();
  });
  orca.settings.onDidChange(() => void api.refresh());
}
