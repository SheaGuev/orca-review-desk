// The requests the panel and the guide tab make of the worker, and the commands in Orca's
// palette. Inputs come from frames, so each is checked here before anything acts on it.
import type { OrcaWorkerApi } from "orca/worker";
import { fail, isCommit, message, optionalCommit } from "./errors";
import type { Focus } from "./focus";
import { setFileViewed, viewedFiles, type ViewedFiles } from "./github";
import { isObj } from "./json";
import type { Opener } from "./open-guide";
import type { PrData } from "./pr-data";
import type { CommentRequest, OpenResult, QueueState, WorktreeChoice } from "./protocol";
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
  /**
   * Opens the stored guide for `key` and records that the person saw it. From the panel it may
   * ask about a worktree instead ("may-ask") or act on the answer; without a choice it never asks.
   */
  openGuide: (key: string, choice?: WorktreeChoice | "may-ask") => Promise<OpenResult>;
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
  orca.panels.handle("file.lines", async ({ key, path, commit }) => {
    if (typeof path !== "string" || !path || path.includes("\0"))
      throw fail("invalid", "Expected a file path");
    const asked = optionalCommit(commit);
    const guide = await api.requireGuide(key);
    return prData.fileLines(guide, key, asked ?? guide.pr.commit, path);
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
  orca.panels.handle("import.resolve", async ({ key, from, specifier }) => {
    if (typeof from !== "string" || !from || from.includes("\0"))
      throw fail("invalid", "Expected the importing file's path");
    if (
      typeof specifier !== "string" ||
      !specifier ||
      specifier.length > 500 ||
      /[\0\n]/.test(specifier)
    )
      throw fail("invalid", "Expected an import specifier");
    const guide = await api.requireGuide(key);
    return prData.importTarget(guide, { key, commit: guide.pr.commit, from, specifier });
  });
  orca.panels.handle("file.open", async ({ repo, number, path }) => {
    const guide = await api.store.guide(prKey(repo, number));
    await api.opener.openFile(repo, guide?.pr.headRef ?? null, path);
    return { opened: true };
  });
}

/** A GitHub call's failure as a request error the guide tab can show. */
async function fromGitHub<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    throw fail("unavailable", `GitHub: ${message(e)}`);
  }
}

/** GitHub's Viewed checkbox per file, read and set through `gh` as the person. */
function registerViewed(orca: OrcaWorkerApi, api: WorkerApi): void {
  // The PR's node id from the last read, so ticking a box costs one call.
  const prIds = new Map<string, string>();
  const read = async (key: string): Promise<ViewedFiles> => {
    const { pr } = await api.requireGuide(key);
    const files = await fromGitHub(() => viewedFiles(pr.repo, pr.number));
    prIds.set(key, files.prId);
    return files;
  };
  orca.panels.handle("viewed.get", async ({ key }) => ({ viewed: (await read(key)).viewed }));
  orca.panels.handle("viewed.set", async ({ key, path, viewed }) => {
    if (typeof path !== "string" || !path || path.includes("\0"))
      throw fail("invalid", "Expected a file path");
    if (typeof viewed !== "boolean") throw fail("invalid", "Expected viewed to be true or false");
    const prId = prIds.get(key) ?? (await read(key)).prId;
    await fromGitHub(() => setFileViewed(prId, path, viewed));
    return { viewed };
  });
}

/** The comment a guide tab asks to post, checked: a path, a line or none, an optional range start. */
function asCommentRequest(value: unknown): CommentRequest {
  if (!isObj(value)) throw fail("invalid", "Expected a comment");
  const { path, line, startLine, body } = value;
  if (typeof path !== "string" || !path || path.includes("\0"))
    throw fail("invalid", "Expected a file path");
  if (typeof body !== "string" || !body.trim()) throw fail("invalid", "The comment is empty");
  const lineOk = line === null || (typeof line === "number" && Number.isInteger(line) && line > 0);
  if (!lineOk) throw fail("invalid", "Expected a line number or null");
  if (startLine === undefined || line === null) return { path, line, body };
  if (
    typeof startLine !== "number" ||
    !Number.isInteger(startLine) ||
    startLine < 1 ||
    startLine >= line
  )
    throw fail("invalid", "Expected the range to start above its last line");
  return { path, line, startLine, body };
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
  orca.panels.handle("review.comment", ({ key, comment }) =>
    reviews.comment(key, asCommentRequest(comment)),
  );
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
    // Turning a repository back on is the person's answer to a run that changed its git files.
    if (optIn && api.state.tampered?.repo === repo) {
      api.state.tampered = null;
      await api.store.setTampered(null);
    }
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
  orca.panels.handle("guide.open", ({ key, worktree }) => {
    if (worktree !== undefined && worktree !== "create" && worktree !== "skip")
      throw fail("invalid", "Expected worktree to be create or skip");
    return api.openGuide(key, worktree ?? "may-ask");
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

/** A tab's memory past this size is refused rather than kept. */
const TAB_MEMORY_LIMIT = 200_000;
/** PRs whose tab memory is kept; the oldest goes first. */
const TAB_MEMORY_PRS = 50;

/**
 * How a guide tab was left (scroll, files opened, lines shown), kept in the worker's memory only:
 * Orca reloads a tab that was away, and this lets it come back the same. Gone when Orca restarts.
 */
function registerTabMemory(orca: OrcaWorkerApi): void {
  const kept = new Map<string, unknown>();
  orca.panels.handle("tab.get", ({ key }) => ({ memory: kept.get(key) ?? null }));
  orca.panels.handle("tab.save", ({ key, memory }) => {
    if (typeof key !== "string" || !key) throw fail("invalid", "Expected a PR key");
    if (!isObj(memory) || JSON.stringify(memory).length > TAB_MEMORY_LIMIT)
      throw fail("invalid", "Expected the tab's memory");
    kept.delete(key);
    kept.set(key, memory);
    for (const old of kept.keys()) {
      if (kept.size <= TAB_MEMORY_PRS) break;
      kept.delete(old);
    }
    return { saved: true as const };
  });
}

export function registerRequests(orca: OrcaWorkerApi, api: WorkerApi): void {
  registerTabMemory(orca);
  registerQueue(orca, api);
  registerReview(orca, api);
  registerGuideData(orca, api);
  registerViewed(orca, api);
  registerCommands(orca, api);
  orca.events.on("workspace.changed", ({ context }) => {
    api.focus.set(context ? { workspaceId: context.workspaceId, branch: context.branch } : null);
    void api.focus.showStatusBar();
  });
  orca.settings.onDidChange(() => void api.refresh());
}
