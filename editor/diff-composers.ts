// Opening a comment composer in a diff view: under a line ("+"), over a range of lines
// (Shift+"+" on a second line), or for the whole file.
import {
  drawBody,
  drawNotes,
  expandGap,
  plusOf,
  remember,
  type LineComposer,
  type View,
} from "./diff-draw";
import { cardOf } from "./review";

/** The composer a press on `line` leads to: a new one there, or the open one stretched to it. */
function nextComposer(
  v: View,
  path: string,
  line: number,
  extend: boolean,
): Omit<LineComposer, "el"> {
  const prior = v.lineComposer;
  if (!v.review || !extend || !prior || prior.anchor === line)
    return {
      anchor: line,
      start: line,
      end: line,
      state: prior?.state ?? { typed: "" },
      error: null,
    };
  const start = Math.min(prior.anchor, line);
  const end = Math.max(prior.anchor, line);
  const problem = v.review.rangeProblem(path, start, end);
  v.frame.announce.textContent = problem ?? `Lines ${start} to ${end} selected`;
  return problem
    ? { ...prior, error: problem }
    : { anchor: prior.anchor, start, end, state: prior.state, error: null };
}

/**
 * "+" on a line opens the composer under it. With `extend`, and a composer already open, it makes
 * the composer a range from the first line pressed to this one (in either direction), if GitHub
 * would take it: both lines in the same hunk. Typed text carries over.
 */
export function openLine(v: View, line: number, extend: boolean): void {
  const { review } = v;
  if (!review || v.current === null) return;
  const next = nextComposer(v, v.current, line, extend);
  const made: LineComposer = {
    ...next,
    el: review.composer({
      path: v.current,
      span: { start: next.start, end: next.end },
      state: next.state,
      error: next.error,
      onClose: (added) => {
        v.lineComposer = null;
        drawNotes(v);
        (added ? cardOf(added.id) : plusOf(v, next.end))?.focus();
      },
    }),
  };
  v.lineComposer = made;
  drawNotes(v);
  made.el.querySelector("textarea")?.focus();
}

/** Opens the whole-file composer above the rows, or goes back to the one already open. */
export function openFileComposer(v: View): void {
  const { commentFile } = v.frame;
  if (!v.review || v.current === null) return;
  v.fileComposer ??= v.review.composer({
    path: v.current,
    span: null,
    state: { typed: "" },
    onClose: (added) => {
      v.fileComposer = null;
      commentFile.setAttribute("aria-expanded", "false");
      drawNotes(v);
      (added ? cardOf(added.id) : commentFile)?.focus();
    },
  });
  commentFile.setAttribute("aria-expanded", "true");
  drawNotes(v);
  v.fileComposer.querySelector("textarea")?.focus();
}

/** Opens the gap that starts at row `from`: its lines are drawn from now on. */
function openGap(v: View, from: number): void {
  v.revealed.add(from);
  drawBody(v);
  drawNotes(v);
  remember(v);
  v.frame.scroller.focus();
  v.frame.announce.textContent = "Lines shown";
}

/** The PR-head line of the row a "+" sits in; 0 when it has none. */
const lineOf = (button: Element): number =>
  Number(button.closest(".dl")?.getAttribute("data-line")) || 0;

/**
 * One listener for every line's comment button and gap, rather than one per row; Shift+Enter on a
 * focused "+" is the keyboard's Shift+click.
 */
export function wireRows(v: View): void {
  const { lines } = v.frame;
  lines.addEventListener("click", (e) => {
    if (!(e.target instanceof Element)) return;
    const arrow = e.target.closest<HTMLElement>("button.expand");
    if (arrow) {
      const dir = arrow.dataset.dir;
      if (dir === "up" || dir === "down" || dir === "all")
        void expandGap(v, Number(arrow.dataset.at), dir);
      return;
    }
    const gap = e.target.closest("button.gap");
    if (gap) {
      openGap(v, Number(gap.getAttribute("data-from")));
      return;
    }
    const button = e.target.closest("button.plus");
    const line = button ? lineOf(button) : 0;
    if (line) openLine(v, line, e.shiftKey);
  });
  lines.addEventListener("keydown", (e) => {
    const button = e.target instanceof Element ? e.target.closest("button.plus") : null;
    if (!button || e.key !== "Enter" || !e.shiftKey) return;
    e.preventDefault();
    const line = lineOf(button);
    if (line) openLine(v, line, true);
  });
}
