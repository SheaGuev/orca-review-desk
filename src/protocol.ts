// The panel <-> worker contract. src/panel.tsx, src/worker.ts and editor/main.ts all read it.
import type { Breakdown } from "./breakdown/assemble";
import type { DiffFile, FileLines } from "./diff-model";
import type { ImportTarget } from "./import-resolve";
import type { Draft, DraftComment, PostedComment, ReviewEvent } from "./review";
import type { RiskLevel, SkippedFile } from "./schema";
import type { TourState } from "./tour";

export type Lane = "user" | "team" | "authored" | "recent";

/**
 * none: no guide yet; queued / generating: an agent run is waiting or running; ready: the guide
 * matches the PR head; stale: the author pushed since the guide was made; failed: the last run
 * failed; lockfile: only lockfiles changed, nothing to explain.
 */
export type ItemStatus =
  | "none"
  | "queued"
  | "generating"
  | "ready"
  | "stale"
  | "failed"
  | "lockfile";

export type QueueItem = {
  key: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  url: string;
  lane: Lane;
  draft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  headSha: string;
  status: ItemStatus;
  risk: RiskLevel | null;
  riskSummary: string | null;
  /** The author pushed since you last opened this guide. */
  newSinceYourReview: boolean;
  /** Team lane: files your teams own, or null when the repo has no local clone or CODEOWNERS. */
  ownedFiles: number | null;
  /** Why no guide is made automatically, in a few words; null when it is (or one exists). */
  manualReason: string | null;
  error: string | null;
  hasClone: boolean;
  /** When your review was asked for (ms): the latest request, else ready for review, else opened. */
  requestedAt: number;
  /** Team lane: the team whose request brought it here (`org/team`). */
  team: string | null;
  /** Place in the queue, from 1; null in Not queued and Your PRs. */
  position: number | null;
  /** `repo` without the owner, unless two listed repos share a name. */
  repoLabel: string;
  /** Guided tour progress on the current guide: "18 of 23 files", "Reviewed tour", or null. */
  tour: string | null;
  /** Comments in your review draft for this PR, not yet posted. */
  pendingComments: number;
  /** Recently reviewed lane: your latest review on GitHub, and whether the author pushed since. */
  lastReview: { at: number; newCommits: boolean } | null;
};

export type RepoState = { repo: string; optIn: boolean | null; hasClone: boolean; pending: number };

export type Notice = {
  tone: "warning" | "danger";
  text: string;
  /** The repository the notice offers to turn automatic guides back on for. */
  turnOn?: string;
};

/** The panel's answer when asked about a worktree: check the PR's branch out, or open without. */
export type WorktreeChoice = "create" | "skip";

/** Opened (with notes on where and why), or a question: no worktree is on the PR's branch. */
export type OpenResult =
  | { opened: true; notes: string[] }
  | { opened: false; ask: { branch: string } };

export type QueueState = {
  /** The reviews you owe, in the order to do them. */
  queue: QueueItem[];
  /** Requests with no automatic guide, each with its reason. */
  notQueued: QueueItem[];
  authored: QueueItem[];
  /** Open PRs you reviewed lately and aren't requested on now, latest review first. */
  recent: QueueItem[];
  /** How far back Recently reviewed looks, in days (the `recentDays` setting). */
  recentDays: number;
  repos: RepoState[];
  checking: boolean;
  checkedAt: number | null;
  /** The one status line the panel shows: GitHub unreachable, agent signed out, daily limit. */
  notice: Notice | null;
  /** Named in the opt-in question, since turning a repo on spends this agent's runs. */
  agentLabel: string;
  includeAuthored: boolean;
  /**
   * The guide last opened from the panel or moved through in a guide tab, so its row reads as the
   * current one. Orca tells plugins nothing about editor focus, so this is the best guess.
   */
  openKey: string | null;
};

export type ReviewInfo = {
  draft: Draft;
  /** False on your own PR: GitHub refuses Approve and Request changes there. */
  canApprove: boolean;
  /** The PR head as last seen; the draft's line comments are checked against it on submit. */
  head: string;
  /** Comments already posted on their own from the guide tab; absent from older workers. */
  posted?: PostedComment[];
};

/** A comment the guide tab asks to post now, on its own: where and what. */
export type CommentRequest = Pick<DraftComment, "path" | "line" | "startLine" | "body">;

export type ReviewCommentResult =
  | { outcome: "posted"; comment: PostedComment }
  /** Nothing was posted: GitHub's or the plugin's reason. */
  | { outcome: "refused"; message: string };

export type ReviewSubmitResult =
  | {
      outcome: "posted";
      event: ReviewEvent;
      url: string | null;
      /** File comments GitHub refused after the review went in; kept in the draft. */
      notPosted: DraftComment[];
    }
  /** The PR moved and these line comments no longer sit on a line of its diff; nothing was posted. */
  | { outcome: "conflict"; head: string; stale: DraftComment[] }
  /** Nothing was posted: GitHub's or the plugin's reason, and the draft is kept. */
  | { outcome: "refused"; message: string };

declare module "orca" {
  interface PluginRequests {
    "queue.get": { output: QueueState };
    "queue.refresh": { output: QueueState };
    "repo.setOptIn": { input: { repo: string; optIn: boolean }; output: QueueState };
    /** Turns the Your PRs lane (the `includeAuthored` setting) on or off. */
    "lane.showAuthored": { input: { show: boolean }; output: QueueState };
    "guide.generate": { input: { key: string }; output: QueueState };
    "guide.open": {
      input: { key: string; worktree?: WorktreeChoice };
      output: OpenResult;
    };
    "review.get": { input: { key: string }; output: ReviewInfo };
    "review.save": { input: { key: string; draft: Draft }; output: { saved: true } };
    /** Posts the stored draft as one GitHub review; only ever called from a press in the guide tab. */
    "review.submit": {
      input: { key: string; event: ReviewEvent; body: string };
      output: ReviewSubmitResult;
    };
    /** Posts one comment now, outside any review; only ever called from a press in the guide tab. */
    "review.comment": {
      input: { key: string; comment: CommentRequest };
      output: ReviewCommentResult;
    };
    /**
     * One file's diff at the guide's commit (default: the stored guide's), for the guide tab's
     * diff pane. Capped well under the request limit; `truncated` says when it was cut.
     */
    "diff.get": { input: { key: string; path: string; commit?: string }; output: DiffFile };
    /**
     * One file's PR-head text at the guide's commit (default: the stored guide's), for the
     * unchanged lines between hunks. Capped like a diff; `truncated` says when it was cut.
     */
    "file.lines": { input: { key: string; path: string; commit?: string }; output: FileLines };
    /**
     * The PR's changed files grouped by kind, as Diff Breakdown groups a branch, at the guide's
     * commit (default: the stored guide's). Lockfiles included. Computed from the local clone.
     */
    "breakdown.get": { input: { key: string; commit?: string }; output: Breakdown };
    /**
     * The changed files the tour skips by design (lockfiles, generated, whitespace-only, pure
     * renames) at the guide's commit, for a guide written before it stored them.
     */
    "skipped.get": { input: { key: string; commit?: string }; output: SkippedFile[] };
    /**
     * The guide tab's tour progress for the guide at `commit` (default: the stored guide's), with
     * `stops` counting the skipped files' stop; progress from another commit comes back as a fresh
     * tour at the overview.
     */
    "tour.get": { input: { key: string; commit?: string; stops: number }; output: TourState };
    "tour.save": { input: { key: string; state: TourState }; output: { saved: true } };
    /** How the guide tab was left (scroll, files opened, lines shown), from the worker's memory. */
    "tab.get": { input: { key: string }; output: { memory: unknown } };
    "tab.save": { input: { key: string; memory: object }; output: { saved: true } };
    /** The PR's files you ticked Viewed on GitHub (not those viewed before they changed again). */
    "viewed.get": { input: { key: string }; output: { viewed: string[] } };
    /** Ticks or unticks Viewed on one file on GitHub; only ever called from a press in the guide tab. */
    "viewed.set": {
      input: { key: string; path: string; viewed: boolean };
      output: { viewed: boolean };
    };
    "file.open": {
      input: { repo: string; number: number; path: string };
      output: { opened: boolean };
    };
    /** The file an import in `from` points to at the guide's commit, from the clone's git. */
    "import.resolve": {
      input: { key: string; from: string; specifier: string };
      output: ImportTarget;
    };
  }
  interface PluginPanelEvents {
    "queue.changed": QueueState;
  }
}
