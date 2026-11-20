// The guided tour's state: which view the reviewer is on and which stops they have seen, kept per
// PR in the plugin's storage (`tour:<repo#n>`) so the tab reopens where they left off and the
// queue can say how far they got. Pure, so the worker, the guide tab and the tests share it.
//
// The tour covers every changed file: the agent's deep and skim stops, then, when any file was
// skipped by design, one last stop listing those. Stop indices count that last stop too.
import type { PrGuide, Stop } from "./schema";

/** The tour's stops as far as progress goes: each stop's files, then the skipped files' stop. */
export type TourShape = {
  stops: readonly Pick<Stop, "files">[];
  /** Paths skipped by design; when there are any they are the last stop. */
  skipped: readonly string[];
};

/** Stops in the tour, the skipped files' stop included. */
export const stopCount = (t: TourShape): number => t.stops.length + (t.skipped.length ? 1 : 0);

/** The index of the skipped files' stop, or null when nothing was skipped. */
export const skipIndex = (t: TourShape): number | null =>
  t.skipped.length ? t.stops.length : null;

/**
 * Files covered so far: those of every stop shown (the skipped files once their stop was shown),
 * out of every file in the tour.
 */
export function filesCovered(
  visited: readonly number[],
  t: TourShape,
): { covered: number; total: number; skipped: number } {
  const seen = new Set<string>();
  const all = new Set<string>(t.skipped);
  t.stops.forEach((s, i) =>
    s.files.forEach((f) => {
      all.add(f);
      if (visited.includes(i)) seen.add(f);
    }),
  );
  if (t.skipped.length && visited.includes(t.stops.length)) t.skipped.forEach((f) => seen.add(f));
  return { covered: seen.size, total: all.size, skipped: t.skipped.length };
}

/** `overview`, `wrapup`, or `stop:<index>` (from 0). A string, so it stores as plain JSON. */
export type TourView = string;

export type TourState = {
  /** The guide commit the progress belongs to; another commit starts the tour again. */
  commit: string;
  view: TourView;
  /** Indices of the stops shown so far, ascending. */
  visited: number[];
  /** Stops whose file the reviewer collapsed, ascending; a stop's file is open by default. */
  collapsed: number[];
  /**
   * The stop shown most recently, kept while on the overview or wrap-up so "Resume" goes back to
   * it. Null before any stop was shown (and in states stored before it was tracked).
   */
  last: number | null;
};

export type ParsedView =
  | { kind: "overview" }
  | { kind: "wrapup" }
  | { kind: "stop"; index: number };

export const tourKey = (key: string) => `tour:${key}`;
export const stopView = (index: number): TourView => `stop:${index}`;

export function parseView(view: unknown, stops: number): ParsedView {
  if (view === "wrapup") return { kind: "wrapup" };
  const m = typeof view === "string" ? /^stop:(\d+)$/.exec(view) : null;
  const index = m ? Number(m[1]) : -1;
  return index >= 0 && index < stops ? { kind: "stop", index } : { kind: "overview" };
}

export const freshTour = (commit: string): TourState => ({
  commit,
  view: "overview",
  visited: [],
  collapsed: [],
  last: null,
});

/** Stop indices from storage: in range, each once, ascending. */
function indices(value: unknown, stops: number): number[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (i): i is number => typeof i === "number" && Number.isInteger(i) && i >= 0 && i < stops,
      ),
    ),
  ].sort((a, b) => a - b);
}

/**
 * The stored state for a guide at `commit` with `stops` stops: malformed values, or progress made
 * on another commit, start over at the overview. Unknown views and stop indices are dropped.
 */
export function tourState(value: unknown, commit: string, stops: number): TourState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return freshTour(commit);
  const v = value as Record<string, unknown>;
  if (v.commit !== commit) return freshTour(commit);
  const parsed = parseView(v.view, stops);
  return {
    commit,
    view: parsed.kind === "stop" ? stopView(parsed.index) : parsed.kind,
    visited: indices(v.visited, stops),
    // Stored before files could be collapsed: every file open.
    collapsed: indices(v.collapsed, stops),
    // Stored before the last stop was tracked: Resume falls back to the first stop not seen.
    last:
      typeof v.last === "number" && Number.isInteger(v.last) && v.last >= 0 && v.last < stops
        ? v.last
        : null,
  };
}

/** The state with stop `index`'s file collapsed or open again. */
export function setCollapsed(s: TourState, index: number, collapsed: boolean): TourState {
  const rest = s.collapsed.filter((i) => i !== index);
  return { ...s, collapsed: collapsed ? [...rest, index].sort((a, b) => a - b) : rest };
}

/**
 * The state after showing `view`; showing a stop is what visiting it means, and makes it the stop
 * Resume returns to. The overview and wrap-up keep the last stop.
 */
export function showView(s: TourState, view: TourView, stops: number): TourState {
  const parsed = parseView(view, stops);
  if (parsed.kind !== "stop") return { ...s, view: parsed.kind };
  const visited = s.visited.includes(parsed.index)
    ? s.visited
    : [...s.visited, parsed.index].sort((a, b) => a - b);
  return { ...s, view: stopView(parsed.index), visited, last: parsed.index };
}

/**
 * Where "Resume" goes: the stop on screen, else the stop last shown (so a restart then leaving
 * the tour resumes at stop 1), else, for states stored before that was tracked, the first stop not
 * yet seen (the first stop when all were seen). Null before the tour started.
 */
export function resumeStop(s: TourState, stops: number): number | null {
  if (!s.visited.length || stops === 0) return null;
  const parsed = parseView(s.view, stops);
  if (parsed.kind === "stop") return parsed.index;
  if (s.last !== null && s.last >= 0 && s.last < stops) return s.last;
  for (let i = 0; i < stops; i++) if (!s.visited.includes(i)) return i;
  return 0;
}

/**
 * The queue row's progress line: "18 of 23 files" while a tour is under way; "Reviewed tour" once
 * every file was covered; null when it has not started or the progress is for another commit.
 */
export function tourLabel(value: unknown, commit: string, tour: TourShape): string | null {
  const count = stopCount(tour);
  if (count === 0) return null;
  const s = tourState(value, commit, count);
  if (!s.visited.length) return null;
  const { covered, total } = filesCovered(s.visited, tour);
  return covered >= total ? "Reviewed tour" : `${covered} of ${total} files`;
}

/** Lines in the diff a reviewer reads at a stop: its focus ranges in its first file, or all of them. */
export function stopLines(stop: Stop, commentable: PrGuide["commentable"]): number {
  const ranges = commentable[stop.files[0]] ?? [];
  let n = 0;
  for (const [a, b] of ranges)
    for (let line = a; line <= b; line++)
      if (!stop.focus?.length || stop.focus.some((f) => line >= f.start && line <= f.end)) n++;
  return n;
}

/** Lines read per minute in the estimate. */
export const LINES_PER_MINUTE = 40;
/** A skim stop's other files cost a minute per this many: a glance each, to confirm the pattern. */
export const SKIM_FILES_PER_MINUTE = 5;

/**
 * The tour's reading time in minutes: each stop costs a minute to read its explanation, plus its
 * first file's diff lines at 40 a minute; a skim stop adds a minute per 5 more files; skipped
 * files cost nothing. So ceil(Σ (lines / 40 + 1 + others / 5)). Deliberately rough; it sets
 * expectations, not a schedule. Lines are the added and unchanged diff lines (what the guide stores
 * per file), not deletions.
 */
export function tourMinutes(
  guide: { readingOrder: readonly Stop[] } & Pick<PrGuide, "commentable">,
): number {
  const total = guide.readingOrder.reduce(
    (sum, stop) =>
      sum +
      stopLines(stop, guide.commentable) / LINES_PER_MINUTE +
      1 +
      (stop.depth === "skim" ? (stop.files.length - 1) / SKIM_FILES_PER_MINUTE : 0),
    0,
  );
  return Math.ceil(total);
}
