// Reviewing from the guide tab: suggested comments to add or dismiss, the comment composer that
// opens under a line, a range of lines or a file header, pending comments drawn in place, and the
// review bar. The bar steps through pending comments and leads to the wrap-up, where the review is
// posted as one GitHub review after a confirmation step. The draft lives in the worker
// (review.save), so it survives closing the tab; nothing is posted except by a press on
// "Post to GitHub" in the wrap-up.
import { inRanges } from "../src/diff";
import type { StopLike } from "../src/overview";
import { pendingOrder } from "../src/pending";
import type { ReviewInfo, ReviewSubmitResult } from "../src/protocol";
import {
  commentPlace,
  rangeProblem,
  suggestedSummary,
  type Draft,
  type DraftComment,
  type ReviewEvent,
} from "../src/review";
import type { Finding, PrGuide } from "../src/schema";
import { h, prose } from "./dom";

const EVENT_LABEL: Record<ReviewEvent, string> = {
  COMMENT: "Comment",
  REQUEST_CHANGES: "Request changes",
  APPROVE: "Approve",
};

const newId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const where = (c: Pick<DraftComment, "path" | "line" | "startLine">) =>
  c.line === null
    ? `${c.path} (whole file)`
    : `${c.path}:${c.startLine !== undefined && c.startLine < c.line ? `${c.startLine}–` : ""}${c.line}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** The comment with a new line, as a one-line comment (a range does not survive a move). */
const onLine = (c: DraftComment, line: number | null): DraftComment => ({
  id: c.id,
  path: c.path,
  line,
  body: c.body,
  source: c.source,
});

/** Lines a composer comments on, first to last; null for the whole file. */
export type LineSpan = { start: number; end: number } | null;

/** What a composer keeps while it is redrawn (a range extended, the diff redrawn): the text. */
export type ComposerState = { typed: string };

export type ComposerOptions = {
  path: string;
  span: LineSpan;
  state: ComposerState;
  /** Shown under the text, such as why a range was refused. */
  error?: string | null;
  /** Told after the comment is added (with it) or the composer is cancelled (null). */
  onClose: (added: DraftComment | null) => void;
};

/** Where the tour goes for the review: the wrap-up, or a pending comment's line. */
export type ReviewNav = {
  finish: () => void;
  jump: (c: DraftComment) => void;
};

export type Review = {
  finding: (f: Finding) => Node | null;
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
  /**
   * One pending comment as a card (Edit reopens the composer in its place, Delete removes it), for
   * drawing under its line. `afterRemove` puts focus somewhere sensible once the card is gone.
   */
  commentCard: (c: DraftComment, afterRemove: () => void) => HTMLElement;
  /** Whether GitHub would take a comment on this PR-head line. */
  canComment: (path: string, line: number) => boolean;
  /** Why GitHub would refuse a comment on lines `start`..`end`, or null. */
  rangeProblem: (path: string, start: number, end: number) => string | null;
  /** Called after any change that redraws the review (add, remove, dismiss, post). */
  onChange: (listener: () => void) => () => void;
  /** Connects the bar and the wrap-up's jump links to the tour. */
  bind: (nav: ReviewNav) => void;
};

/** The card (or open editor) of a pending comment, once it is on the page. */
export const cardOf = (id: string) =>
  document.querySelector<HTMLElement>(`[data-comment="${CSS.escape(id)}"]`);

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
  const key = `${guide.pr.repo}#${guide.pr.number}`;
  let info: ReviewInfo;
  try {
    info = await orca.plugin.request("review.get", { key });
  } catch {
    return null;
  }
  let draft: Draft = info.draft;
  /** Comments the worker reported as off the diff after the PR moved, by id. */
  let stale = new Set<string>();
  let confirming: ReviewEvent | null = null;
  let posting = false;
  let placement: "bar" | "inline" = "bar";
  /** Once the reviewer edits the summary, it is theirs: no more suggested text, even if emptied. */
  let summaryTouched = info.draft.body.trim() !== "";
  /** Parts of the page that redraw when the draft changes; dropped once taken off the page. */
  const slots = new Map<HTMLElement, () => void>();
  const listeners = new Set<() => void>();
  let nav: ReviewNav | null = null;
  /** Pending comments open for editing in place, with the text typed so far. */
  const editing = new Map<string, ComposerState>();
  /** The comment the bar's ‹ › last went to. */
  let cursor: string | null = null;

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const status = h("p", { class: "review-status", role: "status" });
  const say = (text: string) => (status.textContent = text);

  function save(): void {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      orca.plugin.request("review.save", { key, draft }).catch((e: unknown) => {
        say(`Couldn’t save the draft: ${e instanceof Error ? e.message : String(e)}`);
      });
    }, 300);
  }

  function update(next: Draft, opts: { redraw?: boolean } = {}): void {
    draft = next;
    save();
    if (opts.redraw !== false) redraw();
  }

  function redraw(): void {
    // Slots are made on the page synchronously, so one off it now was replaced (a diff redrawn).
    for (const [el, draw] of slots)
      if (el.isConnected) draw();
      else slots.delete(el);
    drawBar();
    for (const listener of listeners) listener();
  }

  /** A slot that redraws itself when the draft changes; `run` redraws just this one. */
  function slot(draw: (el: HTMLElement) => void): { el: HTMLElement; run: () => void } {
    const el = h("div", { class: "review-slot" });
    const run = () => draw(el);
    slots.set(el, run);
    run();
    return { el, run };
  }

  const ranges = guide.commentable;
  const canComment = (path: string, line: number) =>
    Boolean(ranges[path]) && inRanges(ranges[path], line);

  // ------------------------------------------------------------ suggested comments

  function finding(f: Finding): Node | null {
    if (!f.suggestedComment) return null;
    const suggestion = f.suggestedComment;
    const source = `finding:${f.id}` as const;
    return slot((el) => {
      const added = draft.comments.some((c) => c.source === source);
      const dismissed = draft.dismissedFindings.includes(f.id);
      if (added) {
        el.replaceChildren(h("p", { class: "muted small in-review" }, "✓ In your review"));
        return;
      }
      if (dismissed) {
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
          update({
            ...draft,
            dismissedFindings: draft.dismissedFindings.filter((id) => id !== f.id),
          }),
        );
        el.replaceChildren(
          h("p", { class: "muted small" }, "Suggested comment dismissed · ", undo),
        );
        return;
      }
      const add = h("button", { type: "button", class: "btn sm primary" }, "Add to review");
      add.addEventListener("click", () => {
        const comment: DraftComment = {
          id: newId(),
          path: f.file,
          line: f.line,
          body: suggestion,
          source,
        };
        update({ ...draft, comments: [...draft.comments, comment] });
        // The redraw put its card under the line: go there, so the next step is editing it.
        const card = cardOf(comment.id);
        card?.focus({ preventScroll: true });
        card?.scrollIntoView({ block: "nearest" });
        announce(`Comment added on ${commentPlace(comment)}. Edit it on its card.`);
      });
      const dismiss = h("button", { type: "button", class: "btn sm ghost" }, "Dismiss");
      dismiss.addEventListener("click", () =>
        update({ ...draft, dismissedFindings: [...draft.dismissedFindings, f.id] }),
      );
      el.replaceChildren(
        h(
          "div",
          { class: "suggestion" },
          h("div", { class: "eyebrow" }, "Suggested comment"),
          h("p", {}, prose(suggestion)),
          h("div", { class: "row" }, add, dismiss),
        ),
      );
    }).el;
  }

  // ------------------------------------------------------------ the composer

  /** Grows a textarea with its text, from its `rows` up to `max` rows, then scrolls inside. */
  function autosize(text: HTMLTextAreaElement, max = 12): () => void {
    const fit = () => {
      const style = getComputedStyle(text);
      const line = parseFloat(style.lineHeight) || 20;
      const chrome =
        parseFloat(style.paddingTop) +
        parseFloat(style.paddingBottom) +
        parseFloat(style.borderTopWidth) +
        parseFloat(style.borderBottomWidth);
      text.style.height = "auto";
      const limit = line * max + chrome;
      text.style.height = `${Math.min(text.scrollHeight + parseFloat(style.borderTopWidth) * 2, limit)}px`;
      text.style.overflowY = text.scrollHeight + chrome > limit ? "auto" : "hidden";
    };
    text.addEventListener("input", fit);
    // Measured once it is on the page.
    requestAnimationFrame(fit);
    return fit;
  }

  /**
   * One composer for a line, a range of lines, the whole file, or editing a pending comment in
   * place. No line field: where it sits says where the comment goes.
   */
  function composerBox(o: {
    title: string;
    state: ComposerState;
    action: string;
    error?: string | null;
    submit: (body: string) => void;
    cancel: () => void;
  }): HTMLElement {
    const id = newId();
    const text = h("textarea", {
      id: `${id}-body`,
      rows: "3",
      class: "input autosize",
      "aria-describedby": `${id}-hint ${id}-err`,
    }) as HTMLTextAreaElement;
    text.value = o.state.typed;
    const add = h("button", { type: "button", class: "btn sm primary" }, o.action);
    const cancel = h("button", { type: "button", class: "btn sm ghost" }, "Cancel");
    const sync = () => {
      o.state.typed = text.value;
      add.toggleAttribute("disabled", !text.value.trim());
    };
    text.addEventListener("input", sync);
    sync();
    autosize(text);
    const submit = () => {
      if (!text.value.trim()) return;
      o.submit(text.value.trim());
    };
    add.addEventListener("click", submit);
    cancel.addEventListener("click", () => o.cancel());
    const box = h(
      "div",
      { class: "composer", tabindex: "-1" },
      h("label", { for: text.id, class: "composer-title" }, o.title),
      text,
      h("p", { id: `${id}-err`, class: "field-error small", role: "alert" }, o.error ?? ""),
      h(
        "div",
        { class: "composer-foot" },
        h(
          "span",
          { id: `${id}-hint`, class: "muted small" },
          `⌘↩ ${o.action === "Save" ? "save" : "add"} · Esc cancel`,
        ),
        h("div", { class: "row" }, cancel, add),
      ),
    );
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        // Never the tour's Esc (exit tour) while a composer has focus.
        e.preventDefault();
        e.stopPropagation();
        // Esc never throws typed text away: with text, it leaves the field for Cancel.
        if (!text.value.trim()) o.cancel();
        else if (e.target === text) cancel.focus();
      }
    });
    return box;
  }

  function composer(o: ComposerOptions): HTMLElement {
    const span = o.span;
    const place =
      span === null
        ? "the whole file"
        : commentPlace({
            line: span.end,
            startLine: span.start < span.end ? span.start : undefined,
          });
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
          ...(span && span.start < span.end ? { startLine: span.start } : {}),
          body,
          source: "manual",
        };
        o.state.typed = "";
        update({ ...draft, comments: [...draft.comments, comment] });
        announce(`Comment added on ${place}`);
        // After the redraw, so the caller's focus lands on what is on the page now.
        o.onClose(comment);
      },
      cancel: () => {
        o.state.typed = "";
        o.onClose(null);
      },
    });
  }

  // ------------------------------------------------------------ pending comments in place

  /** Focuses a pending comment's card once a redraw has put it on the page. */
  function focusCard(id: string): void {
    const card = cardOf(id);
    card?.focus({ preventScroll: true });
    card?.scrollIntoView({ block: "nearest" });
  }

  function commentCard(c: DraftComment, afterRemove: () => void): HTMLElement {
    const place = commentPlace(c);
    const typed = editing.get(c.id);
    if (typed) {
      // Edit reopened the composer in the card's place, with the comment's text.
      const box = composerBox({
        title: `Edit your comment on ${place}`,
        state: typed,
        action: "Save",
        submit: (body) => {
          editing.delete(c.id);
          update({
            ...draft,
            comments: draft.comments.map((x) => (x.id === c.id ? { ...x, body } : x)),
          });
          announce(`Comment on ${place} saved`);
          focusCard(c.id);
        },
        cancel: () => {
          editing.delete(c.id);
          redraw();
          focusCard(c.id);
        },
      });
      box.setAttribute("data-comment", c.id);
      return box;
    }
    const edit = h(
      "button",
      { type: "button", class: "btn sm ghost", "aria-label": `Edit your comment on ${place}` },
      "Edit",
    );
    edit.addEventListener("click", () => {
      editing.set(c.id, { typed: c.body });
      redraw();
      cardOf(c.id)?.querySelector("textarea")?.focus();
    });
    const remove = h(
      "button",
      { type: "button", class: "btn sm ghost", "aria-label": `Delete your comment on ${place}` },
      "Delete",
    );
    remove.addEventListener("click", () => {
      stale.delete(c.id);
      update({ ...draft, comments: draft.comments.filter((x) => x.id !== c.id) });
      announce(`Comment on ${place} deleted`);
      afterRemove();
    });
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
          h("span", { class: "tag pending" }, "Pending"),
          h("strong", { class: "small" }, "You"),
          c.startLine !== undefined ? h("span", { class: "muted small" }, place) : null,
        ),
        h("div", { class: "row" }, edit, remove),
      ),
      h("p", { class: "draft-body" }, prose(c.body)),
    );
  }

  const checkRange = (path: string, start: number, end: number) =>
    rangeProblem(canComment, path, start, end);

  function onChange(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // ------------------------------------------------------------ the review bar

  const bar = h("section", { class: "review-bar", role: "region", "aria-label": "Review" });

  /** Goes to the next (1) or previous (-1) pending comment, in tour order, wrapping around. */
  function step(by: 1 | -1): void {
    const order = pendingOrder(stops, draft.comments);
    if (!order.length || !nav) return;
    const at = order.findIndex((c) => c.id === cursor);
    const next =
      at === -1 ? (by === 1 ? 0 : order.length - 1) : (at + by + order.length) % order.length;
    const c = order[next];
    cursor = c.id;
    nav.jump(c);
    announce(`Pending comment ${next + 1} of ${order.length}: ${commentPlace(c)} of ${c.path}`);
  }

  function place(where: "bar" | "inline"): void {
    if (where === placement) return;
    placement = where;
    confirming = null;
    drawBar();
  }

  /** The summary as it would be posted: what the reviewer wrote, else the suggestion. */
  const summaryText = () =>
    summaryTouched ? draft.body : draft.body || suggestedSummary(draft, guide.findings);

  function summaryField(id: string, rows: number): HTMLTextAreaElement {
    const summary = h("textarea", {
      id,
      rows: String(rows),
      class: "input",
    }) as HTMLTextAreaElement;
    summary.value = summaryText();
    summary.addEventListener("input", () => {
      summaryTouched = true;
      update({ ...draft, body: summary.value }, { redraw: false });
    });
    return summary;
  }

  function commentEditor(c: DraftComment): HTMLElement {
    const id = `edit-${c.id}`;
    // Tall enough to read the whole comment without scrolling inside it.
    const rows = Math.min(
      8,
      Math.max(2, Math.ceil(c.body.length / 90) + c.body.split("\n").length),
    );
    const text = h("textarea", { id, rows: String(rows), class: "input" }) as HTMLTextAreaElement;
    text.value = c.body;
    text.addEventListener("input", () =>
      update(
        {
          ...draft,
          comments: draft.comments.map((x) => (x.id === c.id ? { ...x, body: text.value } : x)),
        },
        { redraw: false },
      ),
    );
    const remove = h(
      "button",
      { type: "button", class: "btn sm ghost", "aria-label": `Delete the comment on ${where(c)}` },
      "Delete",
    );
    remove.addEventListener("click", () => {
      stale.delete(c.id);
      update({ ...draft, comments: draft.comments.filter((x) => x.id !== c.id) });
      announce(`Comment on ${where(c)} deleted`);
    });
    const go = h(
      "button",
      {
        type: "button",
        class: "btn sm ghost",
        "aria-label": `Show the comment on ${where(c)} in its diff`,
      },
      "Show in diff →",
    );
    go.addEventListener("click", () => nav?.jump(c));
    const parts: Node[] = [
      h(
        "div",
        { class: "row between" },
        h("label", { for: id, class: "mono small" }, where(c)),
        h("div", { class: "row" }, nav ? go : null, remove),
      ),
      text,
    ];
    if (stale.has(c.id)) {
      // No line field: a comment moves to a line by deleting it and pressing "+" on the new one,
      // or keeps its text as a whole-file comment.
      const whole = h(
        "button",
        { type: "button", class: "btn sm" },
        "Make it a whole-file comment",
      );
      whole.addEventListener("click", () => {
        stale.delete(c.id);
        update({
          ...draft,
          comments: draft.comments.map((x) => (x.id === c.id ? onLine(x, null) : x)),
        });
        announce(`The comment on ${c.path} is now on the whole file`);
      });
      parts.push(
        h(
          "p",
          { class: "field-error small" },
          "The PR changed and this line is no longer in its diff. Make it a whole-file comment, or delete it and add it again on a line of the new diff.",
        ),
        h("div", { class: "row" }, whole),
      );
    }
    return h("li", { class: stale.has(c.id) ? "pending stale" : "pending" }, ...parts);
  }

  function drawBar(): void {
    bar.classList.toggle("inline", placement === "inline");
    bar.setAttribute("aria-label", placement === "inline" ? "Your review" : "Review");
    if (placement === "inline") {
      drawVerdict();
      return;
    }
    // The bar only counts and steps through comments; verdicts and posting are in the wrap-up, so
    // nothing here reads like the composer's "Add to review".
    const n = draft.comments.length;
    const stepButton = (by: 1 | -1) => {
      const b = h(
        "button",
        {
          type: "button",
          class: "btn sm icon",
          "aria-label": by === 1 ? "Next pending comment" : "Previous pending comment",
          title: by === 1 ? "Next pending comment" : "Previous pending comment",
        },
        by === 1 ? "›" : "‹",
      );
      b.addEventListener("click", () => step(by));
      return b;
    };
    const finish = h("button", { type: "button", class: "btn sm primary" }, "Finish review →");
    finish.addEventListener("click", () => nav?.finish());
    bar.replaceChildren(
      h(
        "div",
        { class: "bar-line" },
        h(
          "div",
          { class: "row" },
          h("strong", { class: "small" }, "Review"),
          h("span", { class: "muted small" }, n ? `· ${n} pending` : "· No comments yet"),
          ...(n ? [stepButton(-1), stepButton(1)] : []),
        ),
        finish,
      ),
      status,
    );
  }

  /** The verdict drawn as the main action: Approve, or Comment where it is the only one. */
  const primaryEvent = (): ReviewEvent => (info.canApprove ? "APPROVE" : "COMMENT");

  /** Which verdicts this reviewer may post: GitHub takes only comments on your own PR. */
  const events = () =>
    (["COMMENT", "REQUEST_CHANGES", "APPROVE"] as const).filter(
      (e) => info.canApprove || e === "COMMENT",
    );

  /** The wrap-up's composer: every pending comment, the summary, then the verdict to post. */
  function drawVerdict(): void {
    const n = draft.comments.length;
    const summary = summaryField("verdict-body", 5);
    const suggested = !summaryTouched && !draft.body && summary.value !== "";
    const buttons = events().map((e) => {
      const b = h(
        "button",
        {
          type: "button",
          class: `btn v-${e}${confirming === e ? " on" : ""}${e === primaryEvent() ? " primary" : ""}`,
          "aria-pressed": String(confirming === e),
        },
        EVENT_LABEL[e],
      );
      b.addEventListener("click", () => {
        confirming = confirming === e ? null : e;
        drawBar();
        // Opening the confirmation moves to Post; closing it returns to the verdict pressed.
        bar
          .querySelector<HTMLElement>(
            confirming ? ".confirm-line .btn.primary" : `.verdict-actions .v-${e}`,
          )
          ?.focus();
      });
      return b;
    });
    const children: Node[] = [
      h("h2", { id: "verdict-h" }, "Your review"),
      !info.canApprove
        ? h("p", { class: "muted small" }, "Your own PR: GitHub only takes comments here.")
        : null,
      h("h3", { class: "eyebrow" }, n ? `${plural(n, "comment")} pending` : "No comments yet"),
      n
        ? h(
            "ul",
            { class: "pending-list" },
            // Tour order, the same order the bar's ‹ › step through.
            ...pendingOrder(stops, draft.comments).map(commentEditor),
          )
        : h(
            "p",
            { class: "muted small" },
            "Add comments from the stops: a suggested comment’s Add to review, or + on a line.",
          ),
      h("label", { for: "verdict-body", class: "small" }, "Summary"),
      summary,
      suggested
        ? h(
            "p",
            { class: "muted small" },
            "Suggested from the findings you added. Edit it freely: nothing is posted until you confirm.",
          )
        : null,
      h("div", { class: "row wrap verdict-actions" }, ...buttons),
    ].filter((x): x is HTMLElement => x !== null);
    if (confirming) {
      const event = confirming;
      const lines = draft.comments.filter((c) => c.line !== null).length;
      const files = n - lines;
      const post = h("button", { type: "button", class: "btn primary" }, "Post to GitHub");
      if (posting) post.setAttribute("disabled", "");
      post.addEventListener("click", () => void submit(event, summary.value));
      const cancel = h("button", { type: "button", class: "btn ghost" }, "Cancel");
      cancel.addEventListener("click", () => {
        confirming = null;
        drawBar();
      });
      children.push(
        h(
          "div",
          { class: "confirm confirm-line" },
          h(
            "p",
            {},
            h("strong", {}, EVENT_LABEL[event]),
            ` on ${guide.pr.repo} #${guide.pr.number}, with ${plural(lines, "line comment")}${files ? ` and ${plural(files, "file comment")}` : ""}${summary.value.trim() ? " and the summary above" : ""}.`,
          ),
          h("div", { class: "row" }, post, cancel),
        ),
      );
    }
    children.push(status);
    bar.replaceChildren(...children);
  }

  async function submit(event: ReviewEvent, body: string): Promise<void> {
    if (posting) return;
    posting = true;
    clearTimeout(saveTimer);
    say("Posting to GitHub…");
    drawBar();
    try {
      await orca.plugin.request("review.save", { key, draft: { ...draft, body } });
      const result: ReviewSubmitResult = await orca.plugin.request(
        "review.submit",
        { key, event, body },
        { timeoutMs: 120_000 },
      );
      posting = false;
      if (result.outcome === "posted") {
        confirming = null;
        stale = new Set();
        summaryTouched = false;
        const fresh = await orca.plugin.request("review.get", { key }).catch(() => null);
        draft = fresh?.draft ?? { ...draft, body: "", comments: result.notPosted };
        redraw();
        const link = result.url
          ? h("button", { type: "button", class: "link small" }, "Open on GitHub")
          : null;
        link?.addEventListener("click", () => void orca.shell?.openExternal(result.url as string));
        status.replaceChildren(
          `Posted your review (${EVENT_LABEL[result.event]}). `,
          ...(result.notPosted.length
            ? [
                `GitHub refused ${plural(result.notPosted.length, "file comment")}, kept in your draft: ${result.notPosted.map(where).join(", ")}. `,
              ]
            : []),
          link ?? "",
        );
      } else if (result.outcome === "conflict") {
        stale = new Set(result.stale.map((c) => c.id));
        redraw();
        say(
          `Nothing was posted: the PR changed and ${plural(result.stale.length, "comment")} no longer sit on a line of its diff. Fix them below, then post again.`,
        );
      } else {
        drawBar();
        say(`Nothing was posted: ${result.message}`);
      }
    } catch (e) {
      posting = false;
      drawBar();
      say(`Nothing was posted: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  drawBar();
  return {
    finding,
    bar,
    place,
    composer,
    comments: (path) => draft.comments.filter((c) => c.path === path),
    all: () => draft.comments,
    commentCard,
    canComment,
    rangeProblem: checkRange,
    onChange,
    bind: (next) => {
      nav = next;
      drawBar();
    },
  };
}
