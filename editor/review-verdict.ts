// The wrap-up's review composer: every pending comment (editable), the summary, the verdict to
// post, a line saying what will be sent, and the button that sends it as one GitHub review.
// Nothing is posted except by a press on "Post to GitHub" here.
import { message } from "../src/errors";
import {
  openFindings,
  reviewProblem,
  suggestedSummary,
  type DraftComment,
  type ReviewEvent,
} from "../src/review";
import type { ComposerState } from "./composer";
import { h } from "./dom";
import { plural } from "./parts";
import { commentList } from "./review-comments";
import type { ReviewSession } from "./review-session";

const EVENT_LABEL: Record<ReviewEvent, string> = {
  COMMENT: "Comment",
  REQUEST_CHANGES: "Request changes",
  APPROVE: "Approve",
};
/** The order the verdict buttons are drawn in: the mildest first. */
const VERDICT_ORDER: readonly ReviewEvent[] = ["COMMENT", "REQUEST_CHANGES", "APPROVE"];

/** "src/a.ts:12–14", or the path and "(whole file)". */
const whereOf = (c: Pick<DraftComment, "path" | "line" | "startLine">): string =>
  c.line === null
    ? `${c.path} (whole file)`
    : `${c.path}:${c.startLine !== undefined && c.startLine < c.line ? `${c.startLine}–` : ""}${c.line}`;

/** The comment with a new line, as a one-line comment (a range does not survive a move). */
const onLine = (c: DraftComment, line: number | null): DraftComment => ({
  id: c.id,
  path: c.path,
  line,
  body: c.body,
  source: c.source,
});

export type Verdict = {
  /** Draws the composer into `into`, replacing what is there. */
  draw: (into: HTMLElement) => void;
};

/** The composer's own state, beside the session's draft. */
/** A review GitHub took: as what, where to see it, what it carried, and what it would not take. */
type Posted = {
  event: ReviewEvent;
  url: string | null;
  /** "2 line comments and the summary", as it stood when Post was pressed. */
  carried: string;
  /** Whole-file comments GitHub refused; they stay in the draft. */
  kept: DraftComment[];
};

type State = {
  readonly session: ReviewSession;
  /** Redraws whatever holds the composer (the review bar, in its inline place). */
  readonly redraw: () => void;
  /** The verdict chosen under "Post as". */
  verdict: ReviewEvent;
  posting: boolean;
  /** The review that just went to GitHub; the composer gives way to it until a new one is begun. */
  posted: Posted | null;
  /** Once the reviewer edits the summary, it is theirs: no more suggested text, even if emptied. */
  summaryTouched: boolean;
  /** Pending comments open for editing in the list, with what is typed so far, by id. */
  editing: Map<string, ComposerState>;
};

/** The summary as it would be posted: what the reviewer wrote, else the suggestion. */
function summaryText(v: State): string {
  const { draft, guide } = v.session;
  return v.summaryTouched ? draft.body : draft.body || suggestedSummary(draft, guide.findings);
}

function summaryField(v: State, id: string, rows: number): HTMLTextAreaElement {
  const { session } = v;
  const summary = h("textarea", { id, rows: String(rows), class: "input" });
  summary.value = summaryText(v);
  summary.addEventListener("input", () => {
    v.summaryTouched = true;
    session.update({ ...session.draft, body: summary.value }, { redraw: false });
  });
  return summary;
}

function removeComment(session: ReviewSession, c: DraftComment): void {
  session.stale.delete(c.id);
  session.update({
    ...session.draft,
    comments: session.draft.comments.filter((x) => x.id !== c.id),
  });
  session.announce(`Comment on ${whereOf(c)} deleted`);
}

/** What a comment the PR moved away from offers: keep its text on the whole file. */
function staleNote(session: ReviewSession, c: DraftComment): Node[] {
  // No line field: a comment moves to a line by deleting it and pressing "+" on the new one,
  // or keeps its text as a whole-file comment.
  const whole = h("button", { type: "button", class: "btn sm" }, "Make it a whole-file comment");
  whole.addEventListener("click", () => {
    session.stale.delete(c.id);
    session.update({
      ...session.draft,
      comments: session.draft.comments.map((x) => (x.id === c.id ? onLine(x, null) : x)),
    });
    session.announce(`The comment on ${c.path} is now on the whole file`);
  });
  return [
    h(
      "p",
      { class: "field-error small" },
      "The PR changed and this line is no longer in its diff. Make it a whole-file comment, or delete it and add it again on a line of the new diff.",
    ),
    h("div", { class: "row" }, whole),
  ];
}

/** Which verdicts this reviewer may post: GitHub takes only comments on your own PR. */
const verdictsFor = (canApprove: boolean): ReviewEvent[] =>
  VERDICT_ORDER.filter((e) => canApprove || e === "COMMENT");

/**
 * "Post as: Comment / Request changes / Approve", one of them chosen. A choice, not an action:
 * nothing is sent until Post to GitHub. Left out when there is only one verdict to pick.
 */
function verdictChoice(v: State, into: HTMLElement): HTMLElement | null {
  const events = verdictsFor(v.session.info.canApprove);
  if (events.length < 2) return null;
  const option = (e: ReviewEvent): HTMLElement => {
    const input = h("input", { type: "radio", name: "verdict", value: e });
    input.checked = v.verdict === e;
    input.disabled = v.posting;
    input.addEventListener("change", () => {
      v.verdict = e;
      v.redraw();
      into.querySelector<HTMLElement>(`input[name="verdict"][value="${e}"]`)?.focus();
    });
    return h("label", { class: "verdict-option" }, input, EVENT_LABEL[e]);
  };
  return h(
    "div",
    { class: "verdict-choice", role: "radiogroup", "aria-labelledby": "verdict-as" },
    h("span", { id: "verdict-as", class: "small muted" }, "Post as"),
    ...events.map(option),
  );
}

/** "2 line comments, 1 file comment and the summary": what a post would carry. */
function carries(v: State, summary: HTMLTextAreaElement): string {
  const { comments } = v.session.draft;
  const lines = comments.filter((c) => c.line !== null).length;
  const files = comments.length - lines;
  const parts = [
    ...(lines ? [plural(lines, "line comment")] : []),
    ...(files ? [plural(files, "file comment")] : []),
    ...(summary.value.trim() ? ["the summary"] : []),
  ];
  const last = parts.pop() ?? "nothing";
  return parts.length ? `${parts.join(", ")} and ${last}` : last;
}

/**
 * What the reviewer has not done yet, as one line by the Post button: "Not done yet: 2 major
 * findings not added or dismissed, 22 files not covered." Null when nothing is left. It warns and
 * never blocks: posting a partial review is the reviewer's call.
 */
function beforePosting(session: ReviewSession): string | null {
  const open = openFindings(session.draft, session.guide.findings);
  const unread = session.nav?.uncovered() ?? 0;
  const blockers = open.filter((f) => f.severity === "blocker").length;
  const majors = open.length - blockers;
  const parts = [
    ...(blockers ? [plural(blockers, "blocker")] : []),
    ...(majors ? [plural(majors, "major finding")] : []),
  ];
  const left = [
    ...(parts.length ? [`${parts.join(" and ")} not added or dismissed`] : []),
    ...(unread ? [`${plural(unread, "file")} not covered`] : []),
  ];
  return left.length ? `Not done yet: ${left.join(", ")}.` : null;
}

/**
 * The end of the review: one line saying what a press will send and where, then the one button
 * that sends it. The button is disabled, with the reason in the line's place, while GitHub would
 * refuse the review as it stands; `watch` are the fields whose typing can change that.
 */
function postRow(
  v: State,
  summary: HTMLTextAreaElement,
  watch: readonly HTMLElement[],
): HTMLElement {
  const { session } = v;
  const { repo, number } = session.guide.pr;
  const ahead = beforePosting(session);
  const what = h("p", { class: "small post-what", role: "status" });
  const postButton = h(
    "button",
    { type: "button", class: "btn primary post-button" },
    v.posting ? h("span", { class: "spinner", "aria-hidden": "true" }) : null,
    v.posting ? "Posting to GitHub…" : "Post to GitHub",
  );
  const sync = (): void => {
    const draft = { ...session.draft, body: summary.value };
    const problem = reviewProblem(draft, v.verdict, summary.value, session.info.canApprove);
    postButton.disabled = v.posting || problem !== null;
    what.textContent =
      problem ??
      `Posts to ${repo} #${number} as ${EVENT_LABEL[v.verdict]}, with ${carries(v, summary)}.`;
  };
  sync();
  for (const field of watch) field.addEventListener("input", sync);
  postButton.addEventListener(
    "click",
    () => void submit(v, { event: v.verdict, body: summary.value, carried: carries(v, summary) }),
  );
  return h(
    "div",
    { class: "post" },
    what,
    ahead ? h("p", { class: "small post-unread" }, ahead) : null,
    h("div", { class: "row" }, postButton),
  );
}

/** Every comment of the review, pending then posted. */
function reviewList(v: State): HTMLElement {
  const { session } = v;
  return commentList(session, {
    editing: v.editing,
    save: (c, body) => {
      session.update({
        ...session.draft,
        comments: session.draft.comments.map((x) => (x.id === c.id ? { ...x, body } : x)),
      });
      session.announce(`Comment on ${whereOf(c)} saved`);
    },
    remove: (c) => {
      v.editing.delete(c.id);
      removeComment(session, c);
    },
    stale: (c) => staleNote(session, c),
    redraw: v.redraw,
  });
}

/**
 * What takes the composer's place once GitHub has the review: that it went, as what and with
 * what, a link to it, and the way to the comments GitHub would not take or to a new review.
 */
function postedPanel(v: State, posted: Posted): HTMLElement[] {
  const { repo, number } = v.session.guide.pr;
  const { url, kept } = posted;
  const open = url ? h("button", { type: "button", class: "btn primary" }, "Open on GitHub") : null;
  if (open && url) open.addEventListener("click", () => void orca.shell?.openExternal(url));
  const again = h(
    "button",
    { type: "button", class: "btn ghost" },
    kept.length ? `Go to the ${plural(kept.length, "kept comment")}` : "Start another review",
  );
  again.addEventListener("click", () => {
    v.posted = null;
    v.redraw();
  });
  return [
    h("h2", { id: "verdict-h", class: "posted-title" }, "✓ Review posted"),
    h("p", {}, `${EVENT_LABEL[posted.event]} on ${repo} #${number}, with ${posted.carried}.`),
    ...(kept.length
      ? [
          h(
            "p",
            { class: "field-error small" },
            `GitHub refused ${plural(kept.length, "file comment")} (${kept.map(whereOf).join(", ")}). They are kept in your draft.`,
          ),
        ]
      : []),
    h("div", { class: "row" }, open, again),
  ];
}

/** Whether the posted review is still what the card should show: nothing new was drafted since. */
const stillPosted = (v: State): v is State & { posted: Posted } =>
  v.posted !== null &&
  !v.session.draft.body &&
  v.session.draft.comments.length === v.posted.kept.length;

function drawVerdict(v: State, into: HTMLElement): void {
  const { session } = v;
  const { canApprove } = session.info;
  into.setAttribute("aria-busy", String(v.posting));
  if (stillPosted(v)) {
    into.replaceChildren(...postedPanel(v, v.posted));
    return;
  }
  v.posted = null;
  const n = session.draft.comments.length;
  const sent = session.posted.length;
  const summary = summaryField(v, "verdict-body", 5);
  const suggested = !v.summaryTouched && !session.draft.body && summary.value !== "";
  const list = reviewList(v);
  const choice = verdictChoice(v, into);
  // While it is on its way, nothing in the review can be changed.
  for (const field of [list, summary, choice]) if (field) field.inert = v.posting;
  const parts: (HTMLElement | null)[] = [
    h("h2", { id: "verdict-h" }, "Your review"),
    canApprove
      ? null
      : h("p", { class: "muted small" }, "Your own PR: GitHub only takes comments here."),
    // With no comments, the hint under it already says so.
    n || sent
      ? h(
          "h3",
          { class: "eyebrow" },
          [...(n ? [`${n} pending`] : []), ...(sent ? [`${sent} posted`] : [])].join(" · "),
        )
      : null,
    list,
    h("label", { for: "verdict-body", class: "small" }, "Summary"),
    summary,
    suggested
      ? h("p", { class: "muted small" }, "Suggested from the findings you added. Edit it freely.")
      : null,
    choice,
    postRow(v, summary, [summary, list]),
    session.status,
  ];
  into.replaceChildren(...parts.filter((x) => x !== null));
}

/** Saves the draft with `body`, then asks the worker to post it; throws what the worker threw. */
async function post(session: ReviewSession, event: ReviewEvent, body: string) {
  const { key } = session;
  await orca.plugin.request("review.save", { key, draft: { ...session.draft, body } });
  return orca.plugin.request("review.submit", { key, event, body }, { timeoutMs: 120_000 });
}

/** The draft after a posted review: what the worker kept, else the comments GitHub refused. */
async function afterPosted(session: ReviewSession, notPosted: DraftComment[]): Promise<void> {
  const fresh = await orca.plugin.request("review.get", { key: session.key }).catch(() => null);
  session.stale = new Set();
  session.draft = fresh?.draft ?? { ...session.draft, body: "", comments: notPosted };
}

async function submit(
  v: State,
  ask: { event: ReviewEvent; body: string; carried: string },
): Promise<void> {
  const { session } = v;
  if (v.posting) return;
  v.posting = true;
  session.cancelSave();
  session.say("");
  v.redraw();
  const result = await post(session, ask.event, ask.body).catch((e: unknown) => message(e));
  v.posting = false;
  if (typeof result === "string" || result.outcome === "refused") {
    v.redraw();
    session.say(`Nothing was posted: ${typeof result === "string" ? result : result.message}`);
    return;
  }
  if (result.outcome === "conflict") {
    session.stale = new Set(result.stale.map((c) => c.id));
    session.redraw();
    session.say(
      `Nothing was posted: the PR changed and ${plural(result.stale.length, "comment")} no longer sit on a line of its diff. Fix them below, then post again.`,
    );
    return;
  }
  v.summaryTouched = false;
  await afterPosted(session, result.notPosted);
  v.posted = { event: result.event, url: result.url, carried: ask.carried, kept: result.notPosted };
  session.redraw();
  session.announce(`Review posted as ${EVENT_LABEL[result.event]}`);
}

/** `redraw` redraws whatever holds the composer (the review bar, in its inline place). */
export function createVerdict(session: ReviewSession, redraw: () => void): Verdict {
  const v: State = {
    session,
    redraw,
    // Comment is the verdict that claims the least, so it is the one chosen to begin with.
    verdict: "COMMENT",
    posting: false,
    posted: null,
    summaryTouched: session.info.draft.body.trim() !== "",
    editing: new Map(),
  };
  return {
    draw: (into) => drawVerdict(v, into),
  };
}
