// Reviewing from the guide tab: suggested comments to add or dismiss, the comment composer that
// opens under a line, a range of lines or a file header, pending comments drawn in place, and the
// review bar. The bar steps through pending comments and leads to the wrap-up, where the review is
// posted as one GitHub review. The draft lives in the worker
// (review.save), so it survives closing the tab; nothing is posted except by a press on
// "Post to GitHub" in the wrap-up.
//
// This file draws what sits in the diffs (suggestions, composers, pending cards) and hands the
// rest out: editor/review-session.ts keeps the draft, editor/review-bar.ts and
// editor/review-verdict.ts draw the controls.
import { inRanges } from "../src/diff";
import { message } from "../src/errors";
import type { StopLike } from "../src/overview";
import type { CommentRequest, ReviewCommentResult, ReviewInfo } from "../src/protocol";
import { prKey } from "../src/repo";
import {
  commentPlace,
  emptyDraft,
  openFindings,
  rangeProblem,
  type DraftComment,
  type PostedComment,
} from "../src/review";
import type { Finding, PrGuide } from "../src/schema";
import { composerBox, newId, type ComposerState } from "./composer";
import { h, prose } from "./dom";
import { SEVERITY_LABEL } from "./parts";
import { createReviewBar } from "./review-bar";
import { createSession, type ReviewNav, type ReviewSession } from "./review-session";

/** Lines a composer comments on, first to last; null for the whole file. */
export type LineSpan = { start: number; end: number } | null;

export type ComposerOptions = {
  path: string;
  span: LineSpan;
  state: ComposerState;
  /** Shown under the text, such as why a range was refused. */
  error?: string | null;
  /** Told after the comment is added (with it) or the composer is cancelled (null). */
  onClose: (added: DraftComment | null) => void;
};

export type Review = {
  /** A finding's suggested comment to add or dismiss; `compact` folds the comment under its buttons. */
  finding: (f: Finding, o?: { compact?: boolean }) => Node | null;
  /** What became of a finding's suggested comment: still open, added to the review, or dismissed. */
  findingState: (f: Finding) => "open" | "added" | "dismissed";
  /** The blocker and major findings not added to the review or dismissed, as the draft is now. */
  openFindings: () => Finding[];
  /**
   * The review controls. As a bar (fixed to the bottom of the tab): the pending count, ‹ › to step
   * through pending comments, and Finish review. Inline (the wrap-up): the full composer with every
   * pending comment, the summary and the verdicts. Same element, same draft; `place` switches it.
   */
  bar: HTMLElement;
  place: (where: "bar" | "inline") => void;
  /** The comment composer: under a line or range, or under a file's header for the whole file. */
  composer: (o: ComposerOptions) => HTMLElement;
  /** Draft comments on `path`, as they are now. */
  comments: (path: string) => DraftComment[];
  /** Every draft comment, as they are now. */
  all: () => DraftComment[];
  /** Comments on `path` posted on their own (Comment), oldest first. */
  postedOn: (path: string) => PostedComment[];
  /** A posted comment as a quiet card: Posted, its text and a link to it on GitHub. */
  postedCard: (c: PostedComment) => HTMLElement;
  /**
   * One pending comment as a card (Edit reopens the composer in its place, Delete removes it), for
   * drawing under its line. `afterRemove` puts focus somewhere sensible once the card is gone.
   */
  commentCard: (c: DraftComment, afterRemove: () => void) => HTMLElement;
  /** Whether GitHub would take a comment on this PR-head line. */
  canComment: (path: string, line: number) => boolean;
  /** Why GitHub would refuse a comment on lines `start`..`end`, or null. */
  rangeProblem: (path: string, start: number, end: number) => string | null;
  /** What the draft holds, so a reset can say what it would discard. */
  held: () => { comments: number; summary: boolean; dismissed: number };
  /** Empties the draft (comments, summary, dismissed findings) and saves it, for starting over. */
  reset: () => void;
  /** Called after any change that redraws the review (add, remove, dismiss, post). */
  onChange: (listener: () => void) => () => void;
  /** Connects the bar and the wrap-up's jump links to the tour. */
  bind: (nav: ReviewNav) => void;
};

/** The card (or open editor) of a pending comment, once it is on the page. */
export const cardOf = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-comment="${CSS.escape(id)}"]`);

/** Focuses a pending comment's card once a redraw has put it on the page. */
function focusCard(id: string): void {
  const card = cardOf(id);
  card?.focus({ preventScroll: true });
  card?.scrollIntoView({ block: "nearest" });
}

/** "Suggested comment dismissed · Undo". */
function dismissedNote(session: ReviewSession, f: Finding): HTMLElement {
  const undo = h(
    "button",
    {
      type: "button",
      class: "link small",
      "aria-label": "Undo dismissing the suggested comment",
    },
    "Undo",
  );
  undo.addEventListener("click", () =>
    session.update({
      ...session.draft,
      dismissedFindings: session.draft.dismissedFindings.filter((id) => id !== f.id),
    }),
  );
  return h("p", { class: "muted small" }, "Suggested comment dismissed · ", undo);
}

/**
 * The suggested comment with Add to review and Dismiss. Compact (the wrap-up's list): the buttons
 * first and the comment folded behind "Read the suggested comment", since the decision is the point
 * there and the comment stays editable in the review once added.
 */
function offer(session: ReviewSession, f: Finding, text: string, compact: boolean): HTMLElement {
  const add = h("button", { type: "button", class: "btn sm primary" }, "Add to review");
  add.addEventListener("click", () => {
    const comment: DraftComment = {
      id: newId(),
      path: f.file,
      line: f.line,
      body: text,
      source: `finding:${f.id}`,
    };
    session.update({ ...session.draft, comments: [...session.draft.comments, comment] });
    // The redraw put its card under the line: go there, so the next step is editing it.
    focusCard(comment.id);
    session.announce(`Comment added on ${commentPlace(comment)}. Edit it on its card.`);
  });
  const dismiss = h("button", { type: "button", class: "btn sm ghost" }, "Dismiss");
  dismiss.addEventListener("click", () =>
    session.update({
      ...session.draft,
      dismissedFindings: [...session.draft.dismissedFindings, f.id],
    }),
  );
  if (compact)
    return h(
      "div",
      { class: "suggestion compact" },
      h("div", { class: "row" }, add, dismiss),
      h(
        "details",
        { class: "suggestion-fold" },
        h("summary", { class: "small" }, "Read the suggested comment"),
        h("p", {}, prose(text)),
      ),
    );
  return h(
    "div",
    { class: "suggestion" },
    h("div", { class: "eyebrow" }, "Suggested comment"),
    h("p", {}, prose(text)),
    h("div", { class: "row" }, add, dismiss),
  );
}

/** A finding's suggested comment: Add to review or Dismiss, then what became of it. */
function suggestion(
  session: ReviewSession,
  f: Finding,
  text: string,
  compact: boolean,
): HTMLElement {
  return session.slot((el) => {
    const { draft } = session;
    // In the review: the card's own first line says so, and the comment sits under it.
    if (draft.comments.some((c) => c.source === `finding:${f.id}`)) el.replaceChildren();
    else if (draft.dismissedFindings.includes(f.id)) el.replaceChildren(dismissedNote(session, f));
    else el.replaceChildren(offer(session, f, text, compact));
  }).el;
}

/** The composer for a new comment on `o.span` of `o.path`. */
function composer(session: ReviewSession, o: ComposerOptions): HTMLElement {
  const { span } = o;
  const range = span !== null && span.start < span.end ? { startLine: span.start } : {};
  const place = span === null ? "the whole file" : commentPlace({ line: span.end, ...range });
  return composerBox({
    title: `Comment on ${place}`,
    state: o.state,
    action: "Add to review",
    error: o.error,
    submit: (body) => {
      const comment: DraftComment = {
        id: newId(),
        path: o.path,
        line: span?.end ?? null,
        ...range,
        body,
        source: "manual",
      };
      o.state.typed = "";
      session.update({ ...session.draft, comments: [...session.draft.comments, comment] });
      session.announce(`Comment added on ${place}`);
      // After the redraw, so the caller's focus lands on what is on the page now.
      o.onClose(comment);
    },
    cancel: () => {
      o.state.typed = "";
      o.onClose(null);
    },
    post: (body) => postNow(session, o, { path: o.path, line: span?.end ?? null, ...range, body }),
  });
}

const refused = (e: unknown): ReviewCommentResult => ({ outcome: "refused", message: message(e) });

/** "Comment": posts it to GitHub now, outside the review; resolves with why not, or null. */
async function postNow(
  session: ReviewSession,
  o: ComposerOptions,
  comment: CommentRequest,
): Promise<string | null> {
  const result = await orca.plugin
    .request("review.comment", { key: session.key, comment }, { timeoutMs: 120_000 })
    .catch(refused);
  if (result.outcome === "refused") return result.message;
  o.state.typed = "";
  session.posted = [...session.posted, result.comment];
  session.announce(`Comment posted on ${commentPlace(comment)}`);
  o.onClose(null);
  session.redraw();
  return null;
}

/** A comment posted on its own: Posted, where, its text, and the way to it on GitHub. */
function postedCard(c: PostedComment): HTMLElement {
  const place = commentPlace(c);
  const link = c.url
    ? h(
        "button",
        {
          type: "button",
          class: "btn sm ghost",
          "aria-label": `Open the comment on ${place} on GitHub`,
        },
        "View on GitHub ↗",
      )
    : null;
  link?.addEventListener("click", () => void orca.shell?.openExternal(c.url));
  return h(
    "div",
    {
      class: "posted-card",
      tabindex: "-1",
      "data-comment": `posted-${c.id}`,
      "aria-label": `Your posted comment on ${place}`,
    },
    h(
      "div",
      { class: "row between wrap" },
      h(
        "div",
        { class: "row wrap" },
        h("strong", { class: "small" }, "Your comment"),
        h("span", { class: "tag posted" }, "Posted"),
        c.startLine === undefined ? null : h("span", { class: "muted small" }, place),
      ),
      link,
    ),
    h("p", { class: "draft-body" }, prose(c.body)),
  );
}

/** Pending comments open for editing in place, with the text typed so far. */
type Editing = Map<string, ComposerState>;

/** The composer that Edit opens in a pending comment's place, with its text. */
function cardEditor(
  session: ReviewSession,
  editing: Editing,
  c: DraftComment,
  typed: ComposerState,
): HTMLElement {
  const place = commentPlace(c);
  const box = composerBox({
    title: `Edit your comment on ${place}`,
    state: typed,
    action: "Save",
    submit: (body) => {
      editing.delete(c.id);
      session.update({
        ...session.draft,
        comments: session.draft.comments.map((x) => (x.id === c.id ? { ...x, body } : x)),
      });
      session.announce(`Comment on ${place} saved`);
      focusCard(c.id);
    },
    cancel: () => {
      editing.delete(c.id);
      session.redraw();
      focusCard(c.id);
    },
  });
  box.setAttribute("data-comment", c.id);
  return box;
}

/** "⚑ Nit" on a comment that began as a finding's suggestion; the finding's headline is its tooltip. */
function fromFinding(session: ReviewSession, c: DraftComment): HTMLElement | null {
  if (c.source === "manual") return null;
  const id = c.source.slice("finding:".length);
  const f = session.guide.findings.find((x) => x.id === id);
  if (!f) return null;
  return h(
    "span",
    { class: `tag sev ${f.severity}`, title: `From the finding: ${f.headline}` },
    `⚑ ${SEVERITY_LABEL[f.severity]}`,
  );
}

/** Edit and Delete for a pending comment's card. */
function cardActions(
  session: ReviewSession,
  editing: Editing,
  c: DraftComment,
  afterRemove: () => void,
): HTMLElement {
  const place = commentPlace(c);
  const edit = h(
    "button",
    { type: "button", class: "btn sm ghost", "aria-label": `Edit your comment on ${place}` },
    "Edit",
  );
  edit.addEventListener("click", () => {
    editing.set(c.id, { typed: c.body });
    session.redraw();
    cardOf(c.id)?.querySelector("textarea")?.focus();
  });
  const remove = h(
    "button",
    {
      type: "button",
      class: "btn sm ghost danger",
      "aria-label": `Delete your comment on ${place}`,
    },
    "Delete",
  );
  remove.addEventListener("click", () => {
    session.stale.delete(c.id);
    session.update({
      ...session.draft,
      comments: session.draft.comments.filter((x) => x.id !== c.id),
    });
    session.announce(`Comment on ${place} deleted`);
    afterRemove();
  });
  return h("div", { class: "row" }, edit, remove);
}

function commentCard(
  session: ReviewSession,
  editing: Editing,
  c: DraftComment,
  afterRemove: () => void,
): HTMLElement {
  const place = commentPlace(c);
  const typed = editing.get(c.id);
  if (typed) return cardEditor(session, editing, c, typed);
  return h(
    "div",
    {
      class: "draft-card",
      tabindex: "-1",
      "data-comment": c.id,
      "aria-label": `Your pending comment on ${place}`,
    },
    h(
      "div",
      { class: "row between wrap" },
      h(
        "div",
        { class: "row wrap" },
        h("strong", { class: "small" }, "Your comment"),
        h("span", { class: "tag pending" }, "Pending"),
        fromFinding(session, c),
        c.startLine === undefined ? null : h("span", { class: "muted small" }, place),
      ),
      cardActions(session, editing, c, afterRemove),
    ),
    h("p", { class: "draft-body" }, prose(c.body)),
  );
}

/** What became of a finding's suggested comment: still open, added to the review, or dismissed. */
function findingState(session: ReviewSession, f: Finding): "open" | "added" | "dismissed" {
  if (session.draft.comments.some((c) => c.source === `finding:${f.id}`)) return "added";
  return session.draft.dismissedFindings.includes(f.id) ? "dismissed" : "open";
}

/**
 * Loads the draft and builds the review controls; null when the worker has no guide for it.
 * `announce` speaks through the tab's status line (comment added, deleted, where a jump went).
 * `stops` are the tour's stops in order, the skipped files' stop included, for tour order.
 */
export async function startReview(
  guide: PrGuide,
  announce: (text: string) => void,
  stops: readonly StopLike[],
): Promise<Review | null> {
  const key = prKey(guide.pr.repo, guide.pr.number);
  const info: ReviewInfo | null = await orca.plugin
    .request("review.get", { key })
    .catch(() => null);
  if (!info) return null;
  const session = createSession({ guide, info, stops, announce });
  const bar = createReviewBar(session);
  session.drawBar = bar.draw;
  const editing: Editing = new Map();
  const ranges = guide.commentable;
  const canComment = (path: string, line: number): boolean => inRanges(ranges[path] ?? [], line);
  bar.draw();
  return {
    finding: (f, o) =>
      f.suggestedComment ? suggestion(session, f, f.suggestedComment, o?.compact === true) : null,
    findingState: (f) => findingState(session, f),
    openFindings: () => openFindings(session.draft, guide.findings),
    bar: bar.el,
    place: bar.place,
    composer: (o) => composer(session, o),
    comments: (path) => session.draft.comments.filter((c) => c.path === path),
    all: () => session.draft.comments,
    postedOn: (path) => session.posted.filter((c) => c.path === path),
    postedCard,
    commentCard: (c, afterRemove) => commentCard(session, editing, c, afterRemove),
    canComment,
    rangeProblem: (path, start, end) => rangeProblem(canComment, path, start, end),
    held: () => ({
      comments: session.draft.comments.length,
      summary: session.draft.body.trim() !== "",
      dismissed: session.draft.dismissedFindings.length,
    }),
    reset: () => {
      // Open editors and stale marks belong to comments that are about to be gone.
      editing.clear();
      session.stale.clear();
      session.update(emptyDraft(session.draft.commitId));
    },
    onChange: session.onChange,
    bind: (nav) => {
      session.nav = nav;
      bar.draw();
    },
  };
}
