// The review controls. As a bar fixed to the bottom of the tab: the comment count, Previous and
// Next comment to step through them, and Finish review. Inline, in the wrap-up: the full composer
// (editor/review-verdict.ts). Same element, same draft; `place` switches between the two.
import { FINISH, plural } from "./parts";
import { pendingOrder } from "../src/pending";
import { commentPlace } from "../src/review";
import { h } from "./dom";
import type { ReviewSession } from "./review-session";
import { createVerdict } from "./review-verdict";

export type ReviewBar = {
  el: HTMLElement;
  place: (where: "bar" | "inline") => void;
  draw: () => void;
};

/** What each step button says: in words, since bare ‹ › read as tour navigation. */
const STEP_TEXT = { [-1]: "‹ Previous comment", 1: "Next comment ›" } as const;

/**
 * The compact bar's one line. It only counts and steps through comments; verdicts and posting
 * are in the wrap-up, so nothing here reads like the composer's "Add to review".
 */
function barLine(
  session: ReviewSession,
  stepButton: (by: 1 | -1, text?: string) => HTMLElement,
): HTMLElement {
  const n = session.draft.comments.length;
  const finish = h("button", { type: "button", class: "btn sm primary" }, `${FINISH} →`);
  finish.addEventListener("click", () => session.nav?.finish());
  return h(
    "div",
    { class: "bar-line" },
    h(
      "div",
      { class: "row" },
      h("strong", { class: "small" }, "Review"),
      h("span", { class: "muted small" }, n ? `· ${plural(n, "comment")}` : "· No comments yet"),
      // One comment has no previous or next: one button goes to it.
      ...(n === 1 ? [stepButton(1, "Go to comment ›")] : n ? [stepButton(-1), stepButton(1)] : []),
    ),
    finish,
  );
}

export function createReviewBar(session: ReviewSession): ReviewBar {
  const el = h("section", { class: "review-bar", role: "region", "aria-label": "Review" });
  let placement: "bar" | "inline" = "bar";
  /** The comment ‹ › last went to. */
  let cursor: string | null = null;
  const verdict = createVerdict(session, () => session.drawBar());

  /** Goes to the next (1) or previous (-1) pending comment, in tour order, wrapping around. */
  function step(by: 1 | -1): void {
    const order = pendingOrder(session.stops, session.draft.comments);
    if (!order.length || !session.nav) return;
    const at = order.findIndex((c) => c.id === cursor);
    const fromEnd = by === 1 ? 0 : order.length - 1;
    const next = at === -1 ? fromEnd : (at + by + order.length) % order.length;
    const c = order[next];
    if (!c) return;
    cursor = c.id;
    session.nav.jump(c);
    session.announce(
      `Pending comment ${next + 1} of ${order.length}: ${commentPlace(c)} of ${c.path}`,
    );
  }

  function stepButton(by: 1 | -1, text: string = STEP_TEXT[by]): HTMLElement {
    const b = h("button", { type: "button", class: "btn sm ghost" }, text);
    b.addEventListener("click", () => step(by));
    return b;
  }

  const draw = (): void => {
    el.classList.toggle("inline", placement === "inline");
    el.setAttribute("aria-label", placement === "inline" ? "Your review" : "Review");
    if (placement === "inline") {
      verdict.draw(el);
      return;
    }
    el.replaceChildren(barLine(session, stepButton), session.status);
  };

  return {
    el,
    draw,
    place: (where) => {
      if (where === placement) return;
      placement = where;
      draw();
    },
  };
}
