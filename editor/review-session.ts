// One review in progress in a guide tab: the draft, saved through the worker so it survives
// closing the tab, and everything on the page that redraws when the draft changes.
import { message } from "../src/errors";
import type { StopLike } from "../src/overview";
import type { ReviewInfo } from "../src/protocol";
import { prKey } from "../src/repo";
import type { Draft, DraftComment, PostedComment } from "../src/review";
import type { PrGuide } from "../src/schema";
import { h } from "./dom";

/** Where the tour goes for the review: the wrap-up, or a pending comment's line. */
export type ReviewNav = {
  finish: () => void;
  jump: (c: DraftComment) => void;
  /** Files of the PR the reviewer has not been through yet. */
  uncovered: () => number;
};

/** How long typing rests before the draft is saved. */
const SAVE_AFTER_MS = 300;

export type ReviewSession = {
  readonly key: string;
  readonly guide: PrGuide;
  /** What the worker said when the tab opened: whether Approve is allowed, the PR head. */
  readonly info: ReviewInfo;
  /** The tour's stops in order, the skipped files' stop included, for tour order. */
  readonly stops: readonly StopLike[];
  /** Speaks through the tab's status line (comment added, deleted, where a jump went). */
  readonly announce: (text: string) => void;
  /** The draft as it is now. Change it through `update`, which saves and redraws. */
  draft: Draft;
  /** Comments the worker reported as off the diff after the PR moved, by id. */
  stale: Set<string>;
  /** Comments posted on their own (Comment, not Add to review), oldest first; never in the draft. */
  posted: PostedComment[];
  nav: ReviewNav | null;
  /** The review's own status line: saving failed, posted, why nothing was posted. */
  readonly status: HTMLElement;
  say: (text: string) => void;
  /** Replaces the draft and saves it; redraws unless told not to (typing redraws nothing). */
  update: (next: Draft, opts?: { redraw?: boolean }) => void;
  /** Redraws every slot still on the page, the bar, then tells the listeners. */
  redraw: () => void;
  /** A piece of the page that redraws itself when the draft changes; `run` redraws just this one. */
  slot: (draw: (el: HTMLElement) => void) => { el: HTMLElement; run: () => void };
  /** Called after any change that redraws the review (add, remove, dismiss, post). */
  onChange: (listener: () => void) => () => void;
  /** Drops a save that has not gone out yet, for a caller that saves the draft itself. */
  cancelSave: () => void;
  /** The bar's redraw, set by the bar once it exists. */
  drawBar: () => void;
};

/** Saves the draft through the worker once typing rests; a newer change restarts the wait. */
function createSaver(): { later: (session: ReviewSession) => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    later: (session) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        orca.plugin
          .request("review.save", { key: session.key, draft: session.draft })
          .catch((e: unknown) => session.say(`Couldn’t save the draft: ${message(e)}`));
      }, SAVE_AFTER_MS);
    },
    cancel: () => clearTimeout(timer),
  };
}

/** Parts of the page that redraw when the draft changes; dropped once taken off the page. */
function createSlots(): { add: ReviewSession["slot"]; redraw: () => void } {
  const slots = new Map<HTMLElement, () => void>();
  return {
    add: (draw) => {
      const el = h("div", { class: "review-slot" });
      const run = () => draw(el);
      slots.set(el, run);
      run();
      return { el, run };
    },
    redraw: () => {
      // Slots are made on the page synchronously, so one off it now was replaced (a diff redrawn).
      for (const [el, draw] of slots)
        if (el.isConnected) draw();
        else slots.delete(el);
    },
  };
}

export function createSession(input: {
  guide: PrGuide;
  info: ReviewInfo;
  stops: readonly StopLike[];
  announce: (text: string) => void;
}): ReviewSession {
  const { guide, info } = input;
  const key = prKey(guide.pr.repo, guide.pr.number);
  const slots = createSlots();
  const listeners = new Set<() => void>();
  const status = h("p", { class: "review-status", role: "status" });
  const saver = createSaver();

  const session: ReviewSession = {
    key,
    guide,
    info,
    stops: input.stops,
    announce: input.announce,
    draft: info.draft,
    stale: new Set(),
    posted: info.posted ?? [],
    nav: null,
    status,
    say: (text) => {
      status.textContent = text;
    },
    update: (next, opts = {}) => {
      session.draft = next;
      saver.later(session);
      if (opts.redraw !== false) session.redraw();
    },
    redraw: () => {
      slots.redraw();
      session.drawBar();
      for (const listener of listeners) listener();
    },
    slot: slots.add,
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cancelSave: saver.cancel,
    drawBar: () => undefined,
  };
  return session;
}
