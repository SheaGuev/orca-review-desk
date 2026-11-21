// Drawing a diff view from its state: the rows on screen, the notes under them (findings, pending
// comments, open composers), and moving to a line. The state is one object, changed here and in
// editor/diff-view.ts (loading, open and closed) and editor/diff-composers.ts (composers).
import { rowOfLine, type DiffFile, type DiffRow, type FocusPiece } from "../src/diff-model";
import { commentPlace } from "../src/review";
import type { Finding, LineRange, PrGuide } from "../src/schema";
import type { ComposerState } from "./composer";
import { drawFullToggle, type DiffFrame } from "./diff-frame";
import {
  drawMarks,
  fileNotes,
  findingCard,
  findingHead,
  layoutNotes,
  renderPieces,
  type Note,
} from "./diff-rows";
import { h } from "./dom";
import { plural } from "./parts";
import { cardOf, type Review } from "./review";

/** Rows drawn at first in a whole file; the rest wait for "Show remaining". */
export const RENDER_FIRST = 2_000;

/** An open composer on a line or a range: the first line pressed is the range's anchor. */
export type LineComposer = {
  anchor: number;
  start: number;
  end: number;
  state: ComposerState;
  error: string | null;
  el: HTMLElement;
};

/** One diff view: what it was made with, its elements, and what it shows now. */
export type View = {
  readonly guide: PrGuide;
  readonly review: Review | null;
  /** A tour stop's ranges, or null for a whole file. */
  readonly focus: readonly LineRange[] | null;
  readonly frame: DiffFrame;
  /** The path shown, or null before the first `show`. */
  current: string | null;
  data: DiffFile | null;
  rows: DiffRow[];
  /** Focused hunks, or the whole file once Full file is on (or when there is no focus). */
  full: boolean;
  pieces: FocusPiece[];
  /** Gaps the reviewer opened, by their first row. */
  readonly revealed: Set<number>;
  /** Whole file: rows drawn so far (the rest behind "Show remaining"). */
  limit: number;
  /** PR-head line → its row element, for the rows drawn now. */
  rowEl: Map<number, HTMLElement>;
  lineComposer: LineComposer | null;
  fileComposer: HTMLElement | null;
  /** A pending comment to focus once the diff is drawn (the review bar's ‹ ›). */
  focusComment: string | null;
  /** Finding cards the reviewer opened or closed by hand, by finding and what became of it. */
  readonly findingOpen: Map<string, boolean>;
};

/** The "+" of PR-head line `line`, when that line is drawn and takes a comment. */
export const plusOf = (v: View, line: number): HTMLButtonElement | null =>
  v.rowEl.get(line)?.querySelector<HTMLButtonElement>("button.plus") ?? null;

/** What is on screen now, as row runs; gaps the reviewer opened count as shown. */
function visiblePieces(v: View): FocusPiece[] {
  if (v.full)
    return v.rows.length ? [{ kind: "show", from: 0, to: Math.min(v.rows.length, v.limit) }] : [];
  return v.pieces.map((p) =>
    p.kind === "gap" && v.revealed.has(p.from) ? { kind: "show", from: p.from, to: p.to } : p,
  );
}

export function drawBody(v: View): void {
  const { lines, moreBox, scroller } = v.frame;
  const drawn = renderPieces(
    visiblePieces(v),
    v.rows,
    // Whether GitHub takes a comment on that PR-head line of the file shown.
    (line) => v.review !== null && v.current !== null && v.review.canComment(v.current, line),
  );
  v.rowEl = drawn.rowEl;
  lines.replaceChildren(drawn.nodes);
  moreBox.replaceChildren();
  if (!v.full || v.limit >= v.rows.length) return;
  const rest = v.rows.length - v.limit;
  const button = h(
    "button",
    { type: "button", class: "btn sm" },
    `Show remaining ${plural(rest, "line")}`,
  );
  button.addEventListener("click", () => {
    v.limit = v.rows.length;
    drawBody(v);
    drawNotes(v);
    scroller.focus();
  });
  moreBox.append(button);
}

/** Shows the whole file (or the stop's lines again), drawn far enough to include `line`. */
export function setFull(v: View, on: boolean, line: number | null = null): void {
  v.full = on || v.focus === null;
  drawFullToggle(v.frame.fullToggle, v.full);
  if (v.full && line !== null) v.limit = Math.max(v.limit, rowOfLine(v.rows, line) + 1);
  drawBody(v);
  drawNotes(v);
  v.frame.announce.textContent = v.full
    ? "Showing the whole file"
    : "Showing the stop’s lines only";
}

export function highlight(v: View, line: number | null): void {
  const { lines, announce } = v.frame;
  lines.querySelectorAll(".dl.target").forEach((old) => old.classList.remove("target"));
  if (line === null) return;
  const row = v.rowEl.get(line);
  if (!row) {
    announce.textContent = `Line ${line} is not in this diff`;
    return;
  }
  row.classList.add("target");
  row.scrollIntoView({ block: "center" });
  announce.textContent = `Line ${line}`;
}

/** A link that opens the whole file at `line`, for an item the stop's hunks do not show. */
function showLine(v: View, line: number): HTMLElement {
  const b = h("button", { type: "button", class: "btn sm ghost" }, `Show line ${line}`);
  b.addEventListener("click", () => {
    setFull(v, true, line);
    highlight(v, line);
  });
  return b;
}

/**
 * A finding's card: open while its suggested comment waits for a decision, folded to one line
 * once it is in the review or dismissed, unless the reviewer opened or closed it by hand since.
 */
function findingNote(v: View, f: Finding): HTMLElement {
  const state = v.review?.findingState(f) ?? "open";
  const key = `${f.id}:${state}`;
  return findingCard(f, v.review, {
    state,
    open: v.findingOpen.get(key) ?? state === "open",
    onToggle: (open) => v.findingOpen.set(key, open),
  });
}

/** Everything that sits under a line of `path` or above its rows, as it is now. */
function notesFor(v: View, path: string): Note[] {
  const { review } = v;
  // A finding whose suggested comment is in the review is left out: the comment stands for it.
  const findings = v.guide.findings.filter(
    (f) => f.file === path && review?.findingState(f) !== "added",
  );
  const comments = review ? review.comments(path) : [];
  return [
    ...findings.map((f) => ({
      line: f.line,
      node: findingNote(v, f),
      summary: () => h("span", { class: "row wrap" }, ...findingHead(f)),
    })),
    ...comments.flatMap((c) =>
      review
        ? [
            {
              line: c.line,
              node: review.commentCard(c, () =>
                (c.line === null ? v.frame.toggle : plusOf(v, c.line))?.focus(),
              ),
              summary: () =>
                h("span", { class: "muted" }, `Your pending comment on ${commentPlace(c)}`),
            },
          ]
        : [],
    ),
    ...(v.lineComposer
      ? [
          {
            line: v.lineComposer.end,
            node: v.lineComposer.el,
            summary: () => h("span", {}, "Your comment"),
          },
        ]
      : []),
  ];
}

/** Findings, pending comments and open composers, each under its line (or the file). */
export function drawNotes(v: View): void {
  if (v.current === null || !v.data) return;
  const { lines, fileBox, moreBox, pendingMeta } = v.frame;
  lines.querySelectorAll(":scope > .annot").forEach((old) => old.remove());
  const comments = v.review ? v.review.comments(v.current) : [];
  const { top, byLine, elsewhere } = layoutNotes(
    notesFor(v, v.current),
    (line) => v.rowEl.has(line),
    (line) => rowOfLine(v.rows, line) !== -1,
  );
  drawMarks(lines, v.rowEl, comments, v.lineComposer);
  // The header's pending count, beside +/−.
  pendingMeta.textContent = comments.length ? `${comments.length} pending` : "";
  for (const [line, nodes] of byLine)
    v.rowEl.get(line)?.after(h("div", { class: "annot" }, ...nodes));
  if (v.fileComposer) top.push(v.fileComposer);
  fileBox.replaceChildren(...fileNotes(v.data), ...top);
  // "Show remaining" stays last.
  moreBox.querySelectorAll(":scope > .also").forEach((old) => old.remove());
  if (!elsewhere.length) return;
  moreBox.prepend(
    h(
      "div",
      { class: "also" },
      h("p", { class: "eyebrow" }, v.full ? "Further down" : "Also in this file"),
      h(
        "ul",
        { class: "also-list" },
        ...elsewhere.map((e) => h("li", {}, e.summary, showLine(v, e.line))),
      ),
    ),
  );
}

/** The header's path and +/− counts. */
export function drawHeader(v: View, path: string): void {
  const { pathText, meta, pendingMeta } = v.frame;
  pathText.textContent = path;
  meta.replaceChildren(
    ...(v.data
      ? [
          h("span", { class: "add mono" }, `+${v.data.additions}`),
          " ",
          h("span", { class: "del mono" }, `−${v.data.deletions}`),
        ]
      : []),
    pendingMeta,
  );
}

/**
 * Draws a line the stop hides: the gap holding it opens (keeping the stop's focus), or on a file
 * without gaps there, the whole file.
 */
function reveal(v: View, line: number): void {
  const at = rowOfLine(v.rows, line);
  if (at === -1 || v.rowEl.has(line)) return;
  const gap = v.full
    ? undefined
    : v.pieces.find((p) => p.kind === "gap" && at >= p.from && at < p.to);
  if (!gap) {
    setFull(v, true, line);
    return;
  }
  v.revealed.add(gap.from);
  drawBody(v);
  drawNotes(v);
}

/** Puts focus on the pending comment the review bar asked for, once it is drawn. */
function landOnComment(v: View): void {
  if (!v.focusComment) return;
  const card = cardOf(v.focusComment);
  v.focusComment = null;
  if (!card) return;
  card.focus({ preventScroll: true });
  card.scrollIntoView({ block: "center" });
}

/** Goes to `line` of the file already drawn (null: nowhere in particular), then to the comment asked for. */
export function arriveAt(v: View, line: number | null): void {
  if (line !== null) reveal(v, line);
  highlight(v, line);
  landOnComment(v);
}
