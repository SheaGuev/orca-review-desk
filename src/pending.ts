// Where the review's pending comments sit in the tour: the stop each belongs to, counts per stop
// for the rail, and the order the review bar's ‹ › step through them. Pure, so it is tested
// without a DOM.
import { stopForFinding, type StopLike } from "./overview";
import type { DraftComment } from "./review";

/** The stop that shows a comment (as for a finding on the same line); null when no stop has its file. */
export const stopForComment = (
  stops: readonly StopLike[],
  c: Pick<DraftComment, "path" | "line">,
): number | null => stopForFinding(stops, { file: c.path, line: c.line });

/** Pending comments per stop, by stop index; comments on files in no stop count for none. */
export function pendingByStop(
  stops: readonly StopLike[],
  comments: readonly Pick<DraftComment, "path" | "line">[],
): number[] {
  const counts = stops.map(() => 0);
  for (const c of comments) {
    const at = stopForComment(stops, c);
    if (at !== null) counts[at] = (counts[at] ?? 0) + 1;
  }
  return counts;
}

/**
 * The comments in tour order: by stop, then files in no stop (none, once the skipped files' stop is
 * passed in), then
 * whole-file comments before line comments and lines top to bottom. Ties keep the draft's order.
 */
export function pendingOrder<C extends Pick<DraftComment, "path" | "line">>(
  stops: readonly StopLike[],
  comments: readonly C[],
): C[] {
  const rank = (c: C) => stopForComment(stops, c) ?? stops.length;
  return comments
    .map((c, i) => ({ c, i }))
    .sort(
      (a, b) =>
        rank(a.c) - rank(b.c) ||
        (rank(a.c) === stops.length ? a.c.path.localeCompare(b.c.path) : 0) ||
        (a.c.line ?? 0) - (b.c.line ?? 0) ||
        a.i - b.i,
    )
    .map(({ c }) => c);
}
