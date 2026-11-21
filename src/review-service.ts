// The review a guide tab drafts and posts: reading the draft, saving it, and submitting it after
// checking it against the PR as it is now. Whatever is not posted stays in the draft.
import type { Clones } from "./clones";
import { inRanges } from "./diff";
import { message } from "./errors";
import { fetchPr, prFiles } from "./git";
import { currentLogin, prDetails, type PrDetails } from "./github";
import { postReview } from "./post-review";
import type { ReviewInfo, ReviewSubmitResult } from "./protocol";
import { reviewProblem, staleComments, type Draft, type ReviewEvent } from "./review";
import { SCHEMA_ID, type DiffContext } from "./schema";
import type { Store, StoredGuide } from "./store";

export type ReviewService = {
  info: (key: string) => Promise<ReviewInfo>;
  save: (key: string, draft: Draft) => Promise<void>;
  submit: (key: string, event: ReviewEvent, body: string) => Promise<ReviewSubmitResult>;
};

type Deps = {
  store: Store;
  clones: Clones;
  /** The stored guide for `key`; throws `unavailable` when there is none. */
  requireGuide: (key: string) => Promise<StoredGuide>;
  /** The PR head the queue last saw for `key`, if it is in the queue. */
  headOf: (key: string) => string | undefined;
  /** Told how many comments the stored draft holds after each change to it. */
  onPending: (key: string, count: number) => void;
  /** Told after a review went to GitHub. */
  onPosted: (key: string) => void;
  log: (text: string) => void;
};

async function save(deps: Deps, key: string, draft: Draft): Promise<void> {
  await deps.store.setDraft(key, draft);
  deps.onPending(key, draft.comments.length);
}

/** The diff's files and comment lines at `head`: from the guide when it is current, else git. */
async function diffAt(deps: Deps, guide: StoredGuide, d: PrDetails): Promise<DiffContext> {
  if (guide.schema === SCHEMA_ID && guide.pr.commit === d.headRefOid) {
    const ranges = guide.commentable;
    return {
      changed: Object.keys(ranges),
      isCommentable: (path, line) => inRanges(ranges[path] ?? [], line),
    };
  }
  const clone = await deps.clones.find(guide.pr.repo);
  if (!clone) throw new Error(`No local clone of ${guide.pr.repo} in Orca to check the diff`);
  return (await prFiles(clone.path, await fetchPr(clone, d))).ctx;
}

async function info(deps: Deps, key: string): Promise<ReviewInfo> {
  const guide = await deps.requireGuide(key);
  const me = await currentLogin().catch(() => "");
  return {
    draft: await deps.store.draft(key, guide.pr.commit),
    canApprove: !me || guide.pr.author.toLowerCase() !== me.toLowerCase(),
    head: deps.headOf(key) ?? guide.pr.commit,
  };
}

/**
 * Why the draft cannot be posted as it is, checked against the PR as it is now: refused with a
 * reason, or in conflict because line comments no longer sit on the diff. Null when it can go.
 */
function blocked(
  draft: Draft,
  ask: { event: ReviewEvent; body: string },
  now: { details: PrDetails; me: string; ctx: DiffContext },
): ReviewSubmitResult | null {
  const mayApprove = now.details.author.toLowerCase() !== now.me.toLowerCase();
  const problem = reviewProblem(draft, ask.event, ask.body, mayApprove);
  if (problem) return { outcome: "refused", message: problem };
  const stale = staleComments(draft, now.ctx.isCommentable, now.ctx.changed);
  return stale.length ? { outcome: "conflict", head: now.details.headRefOid, stale } : null;
}

/** After GitHub took the review: what it refused stays as the draft, and the head counts as seen. */
async function settleDraft(deps: Deps, key: string, left: Draft, head: string): Promise<void> {
  if (left.comments.length) await save(deps, key, left);
  else {
    await deps.store.deleteDraft(key);
    deps.onPending(key, 0);
  }
  const meta = await deps.store.meta(key);
  await deps.store.setMeta(key, { ...meta, lastViewedCommit: head });
  deps.onPosted(key);
}

async function submit(
  deps: Deps,
  key: string,
  event: ReviewEvent,
  body: string,
): Promise<ReviewSubmitResult> {
  const guide = await deps.requireGuide(key);
  const draft = { ...(await deps.store.draft(key, guide.pr.commit)), body };
  const { repo, number } = guide.pr;
  const keepDraft = async (result: ReviewSubmitResult): Promise<ReviewSubmitResult> => {
    await save(deps, key, draft);
    return result;
  };
  const now = await Promise.all([prDetails(repo, number), currentLogin()])
    .then(async ([details, me]) => ({ details, me, ctx: await diffAt(deps, guide, details) }))
    .catch((e: unknown) => message(e));
  if (typeof now === "string") return keepDraft({ outcome: "refused", message: now });
  const stop = blocked(draft, { event, body }, now);
  if (stop) return keepDraft(stop);
  const head = now.details.headRefOid;
  const posted = await postReview({
    repo,
    number,
    draft,
    event,
    body,
    head,
    log: (text) => deps.log(`${key}: ${text}`),
  }).catch((e: unknown) => message(e));
  if (typeof posted === "string") return keepDraft({ outcome: "refused", message: posted });
  deps.log(`${key}: posted a ${event} review with ${draft.comments.length} comment(s)`);
  await settleDraft(
    deps,
    key,
    {
      commitId: head,
      body: "",
      comments: posted.notPosted,
      dismissedFindings: draft.dismissedFindings,
    },
    head,
  );
  return { outcome: "posted", event, url: posted.url, notPosted: posted.notPosted };
}

export function createReviewService(deps: Deps): ReviewService {
  return {
    info: (key) => info(deps, key),
    save: (key, draft) => save(deps, key, draft),
    submit: (key, event, body) => submit(deps, key, event, body),
  };
}
