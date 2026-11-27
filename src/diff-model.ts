// One file's diff as the guide tab shows it: what the worker sends for `diff.get` (raw unified
// diff lines, capped to stay far below Orca's 1 MiB request limit), and the numbered rows the tab
// draws from them. Pure, so the worker, the editor and the tests share it.
import type { FileDiff } from "./diff";
import type { LineRange } from "./schema";

/** What `diff.get` answers: the diff body as text lines, numbered by the tab with `diffRows`. */
export type DiffFile = {
  path: string;
  /** The base-side path when git saw a rename, else null. */
  oldPath: string | null;
  /** The PR-head commit the diff was taken at. */
  commit: string;
  status: "modified" | "added" | "deleted" | "renamed";
  binary: boolean;
  /** Lines from the first hunk header on, each starting with "@@", " ", "+", "-" or "\". */
  lines: string[];
  /** Lines in the whole diff body; more than `lines.length` when `truncated`. */
  totalLines: number;
  additions: number;
  deletions: number;
  /** The diff was cut to fit the answer; `lines` is the start of it. */
  truncated: boolean;
};

export type LineKind = "add" | "del" | "ctx";

export type DiffRow =
  | { kind: "hunk"; text: string; old: number; new: number }
  | { kind: LineKind; old: number | null; new: number | null; text: string }
  /** git's "\ No newline at end of file", about the line just before it. */
  | { kind: "eof"; text: string };

/** Answers stay well under the 1 MiB plugin.request limit, counted as JSON. */
export const DIFF_ANSWER_LIMIT = 600_000;
/** And never more lines than a tab would want to draw. */
export const DIFF_LINE_LIMIT = 20_000;

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** The answer for a path with no changes at that commit. */
const noChanges = (path: string, commit: string): DiffFile => ({
  path,
  oldPath: null,
  commit,
  status: "modified",
  binary: false,
  lines: [],
  totalLines: 0,
  additions: 0,
  deletions: 0,
  truncated: false,
});

/** The leading lines of `body` that fit both limits. */
function withinLimits(body: readonly string[], lineLimit: number, charLimit: number): string[] {
  const lines: string[] = [];
  let used = 0;
  for (const line of body) {
    // JSON length, since escapes (tabs, quotes) grow a line on the wire.
    const size = JSON.stringify(line).length + 1;
    if (lines.length >= lineLimit || used + size > charLimit) break;
    lines.push(line);
    used += size;
  }
  return lines;
}

/** What happened to the file, from the lines git prints before its first hunk. */
function statusFrom(header: readonly string[], renamed: boolean): DiffFile["status"] {
  if (header.some((l) => l.startsWith("new file mode"))) return "added";
  if (header.some((l) => l.startsWith("deleted file mode"))) return "deleted";
  return renamed ? "renamed" : "modified";
}

/** The answer for one path; `file` is null when the path has no changes at that commit. */
export function fileDiffView(
  file: FileDiff | null,
  path: string,
  commit: string,
  limits: { chars?: number; lines?: number } = {},
): DiffFile {
  if (!file) return noChanges(path, commit);
  const all = file.text.split("\n");
  const start = all.findIndex((l) => l.startsWith("@@"));
  const header = start === -1 ? all : all.slice(0, start);
  // The text ends with a newline, so the last split piece is empty, not a line.
  const body = start === -1 ? [] : all.slice(start, all[all.length - 1] === "" ? -1 : undefined);
  const charLimit = limits.chars ?? DIFF_ANSWER_LIMIT;
  const lineLimit = limits.lines ?? DIFF_LINE_LIMIT;
  const lines = withinLimits(body, lineLimit, charLimit);
  return {
    path: file.path,
    oldPath: file.oldPath,
    commit,
    status: statusFrom(header, file.oldPath !== null && file.oldPath !== ""),
    binary: file.binary,
    lines,
    totalLines: body.length,
    additions: file.additions,
    deletions: file.deletions,
    truncated: lines.length < body.length,
  };
}

/** Numbers each line on both sides, from the hunk headers. Lines before any hunk are ignored. */
export function diffRows(lines: readonly string[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldN = 0;
  let newN = 0;
  let inHunk = false;
  for (const line of lines) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldN = Number(hunk[1]);
      newN = Number(hunk[2]);
      inHunk = true;
      rows.push({ kind: "hunk", text: line, old: oldN, new: newN });
      continue;
    }
    if (!inHunk) continue;
    const sign = line[0];
    const text = line.slice(1);
    if (sign === "+") rows.push({ kind: "add", old: null, new: newN++, text });
    else if (sign === "-") rows.push({ kind: "del", old: oldN++, new: null, text });
    else if (sign === " " || line === "")
      rows.push({ kind: "ctx", old: oldN++, new: newN++, text });
    else if (sign === "\\") rows.push({ kind: "eof", text: line.slice(1).trim() });
  }
  return rows;
}

/** A changed span in a line's text: [start, end), end excluded. */
export type Span = readonly [number, number];

/** Words, runs of spaces, and single punctuation: the units a line pair is compared in. */
const TOKEN = /[\w-]+|\s+|[^\w\s]/g;

/** Past this many token pairs a line pair is left unmarked, so a huge line can't stall drawing. */
const WORD_DIFF_LIMIT = 250_000;

/** Below this share of its text in common, a pair is a rewrite and word marks would only be noise. */
const MIN_COMMON = 0.25;

const solid = (t: string) => t.trim().length;

/** For each token of `a` and of `b`, whether it is outside their longest common subsequence. */
function unmatched(a: readonly string[], b: readonly string[]): [boolean[], boolean[]] {
  const w = b.length + 1;
  const len = new Uint32Array((a.length + 1) * w);
  const at = (i: number, j: number): number => len[i * w + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      len[i * w + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  const outA = a.map(() => true);
  const outB = b.map(() => true);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      outA[i++] = false;
      outB[j++] = false;
    } else if (at(i + 1, j) >= at(i, j + 1)) i++;
    else j++;
  }
  return [outA, outB];
}

/** The changed tokens as character spans, joined when adjacent, with spaces trimmed off the ends. */
function changedSpans(text: string, tokens: readonly string[], out: readonly boolean[]): Span[] {
  const result: [number, number][] = [];
  let at = 0;
  tokens.forEach((t, k) => {
    const end = at + t.length;
    if (out[k] && solid(t)) {
      const last = result.at(-1);
      if (last && !solid(text.slice(last[1], at))) last[1] = end;
      else result.push([at, end]);
    }
    at = end;
  });
  return result;
}

/** The words changed between a removed line and the added line that replaced it, or null. */
function linePair(del: string, add: string): [Span[], Span[]] | null {
  const a = del.match(TOKEN) ?? [];
  const b = add.match(TOKEN) ?? [];
  if (a.length * b.length > WORD_DIFF_LIMIT) return null;
  const [outA, outB] = unmatched(a, b);
  const common = a.reduce((n, t, k) => (outA[k] ? n : n + solid(t)), 0);
  const longest = Math.max(solid(del), solid(add));
  if (!longest || common / longest < MIN_COMMON) return null;
  const marks: [Span[], Span[]] = [changedSpans(del, a, outA), changedSpans(add, b, outB)];
  return marks[0].length || marks[1].length ? marks : null;
}

/**
 * Word-level changes, by row index: each run of removed lines followed by added lines is paired
 * line by line (the n-th removed with the n-th added), and each pair that still shares most of
 * its text marks only the words that differ, as GitHub does.
 */
export function wordChanges(rows: readonly DiffRow[]): Map<number, Span[]> {
  const marks = new Map<number, Span[]>();
  let i = 0;
  while (i < rows.length) {
    if (rows[i]?.kind !== "del") {
      i++;
      continue;
    }
    const delFrom = i;
    while (rows[i]?.kind === "del") i++;
    const addFrom = i;
    while (rows[i]?.kind === "add") i++;
    const pairs = Math.min(addFrom - delFrom, i - addFrom);
    for (let k = 0; k < pairs; k++) {
      const del = rows[delFrom + k];
      const add = rows[addFrom + k];
      const pair = del && add ? linePair(del.text, add.text) : null;
      if (!pair) continue;
      if (pair[0].length) marks.set(delFrom + k, pair[0]);
      if (pair[1].length) marks.set(addFrom + k, pair[1]);
    }
  }
  return marks;
}

/** The row showing PR-head line `line` (an added or context line), or -1. */
export function rowOfLine(rows: readonly DiffRow[], line: number): number {
  return rows.findIndex((r) => (r.kind === "add" || r.kind === "ctx") && r.new === line);
}

/** Digits in the largest line number, to size the gutter. */
export function gutterDigits(rows: readonly DiffRow[]): number {
  let max = 1;
  for (const r of rows) if (r.kind !== "eof") max = Math.max(max, r.old ?? 0, r.new ?? 0);
  return String(max).length;
}

/** Unchanged rows kept around a focused range, so the change reads in its place. */
export const FOCUS_CONTEXT = 2;

/**
 * What a tour stop draws: runs of rows to show, and the hidden rows between them as a gap the
 * reviewer can open. `from`/`to` are row indices, `to` excluded; `lines` counts the code lines a
 * gap hides (hunk headers and no-newline markers are not lines).
 */
export type FocusPiece =
  | { kind: "show"; from: number; to: number }
  | { kind: "gap"; from: number; to: number; lines: number };

const isLine = (r: DiffRow) => r.kind === "add" || r.kind === "del" || r.kind === "ctx";

/**
 * The rows a stop shows for its focus ranges: every row from the first to the last PR-head line in
 * each range (deleted lines between them included), the deleted lines just above it (what it
 * replaced), and `context` unchanged rows on each side within the hunk. Everything else becomes a
 * gap. `focused` is false when there are no ranges or none of them lands on a row, and then the
 * whole file is one run, as a stop without focus shows it.
 */
/**
 * The first and last row a range of PR-head lines covers, widened to the change around it: the
 * deletions it replaced, a trailing "no newline" marker, and `context` unchanged lines each side.
 * Null when the range lands on no row.
 */
function rowsOfRange(
  rows: readonly DiffRow[],
  range: LineRange,
  context: number,
): { first: number; last: number } | null {
  const inRange = (r: DiffRow): boolean =>
    (r.kind === "add" || r.kind === "ctx") &&
    r.new !== null &&
    r.new >= range.start &&
    r.new <= range.end;
  let first = rows.findIndex(inRange);
  if (first === -1) return null;
  let last = first;
  rows.forEach((r, i) => {
    if (inRange(r)) last = i;
  });
  // What the first line replaced: the deleted rows straight above it.
  while (first > 0 && rows[first - 1]?.kind === "del") first--;
  // Deletions right after the last line belong to the same change.
  while (last + 1 < rows.length && rows[last + 1]?.kind === "del") last++;
  // A trailing "no newline" marker describes the line above it.
  if (last + 1 < rows.length && rows[last + 1]?.kind === "eof") last++;
  for (let n = 0, i = first - 1; n < context && i >= 0 && rows[i]?.kind === "ctx"; n++, i--)
    first = i;
  for (let n = 0, i = last + 1; n < context && i < rows.length && rows[i]?.kind === "ctx"; n++, i++)
    last = i;
  return { first, last };
}

/** Runs of rows kept and rows hidden, in order, as pieces. */
function piecesOf(rows: readonly DiffRow[], keep: readonly boolean[]): FocusPiece[] {
  const pieces: FocusPiece[] = [];
  let i = 0;
  while (i < rows.length) {
    const shown = keep[i];
    let j = i;
    let lines = 0;
    while (j < rows.length && keep[j] === shown) {
      const row = rows[j];
      if (row && isLine(row)) lines++;
      j++;
    }
    // A hidden run with no code lines in it (a lone marker) is not worth a gap: show it.
    pieces.push(
      shown || lines === 0
        ? { kind: "show", from: i, to: j }
        : { kind: "gap", from: i, to: j, lines },
    );
    i = j;
  }
  return pieces;
}

export function focusPieces(
  rows: readonly DiffRow[],
  ranges: readonly LineRange[] | null | undefined,
  context = FOCUS_CONTEXT,
): { focused: boolean; pieces: FocusPiece[] } {
  const whole = {
    focused: false,
    pieces: rows.length ? [{ kind: "show" as const, from: 0, to: rows.length }] : [],
  };
  const spans = (ranges ?? []).flatMap((range) => rowsOfRange(rows, range, context) ?? []);
  if (!spans.length) return whole;
  const keep: boolean[] = Array.from({ length: rows.length }, () => false);
  for (const { first, last } of spans) for (let i = first; i <= last; i++) keep[i] = true;
  // The hunk header right above a shown run stays: it names the function the lines sit in.
  for (let i = 1; i < rows.length; i++)
    if (keep[i] && !keep[i - 1] && rows[i - 1]?.kind === "hunk") keep[i - 1] = true;
  return { focused: true, pieces: mergeShows(piecesOf(rows, keep)) };
}

/** Neighbouring show runs become one. */
function mergeShows(pieces: FocusPiece[]): FocusPiece[] {
  const out: FocusPiece[] = [];
  for (const p of pieces) {
    const prev = out[out.length - 1];
    if (prev?.kind === "show" && p.kind === "show") prev.to = p.to;
    else out.push({ ...p });
  }
  return out;
}

/** The PR-head file's text as `file.lines` answers it, for drawing unchanged lines between hunks. */
export type FileLines = {
  /** The file's lines at the commit, without their newlines; empty for a binary or missing file. */
  lines: string[];
  /** The file was cut to fit the answer; `lines` is the start of it. */
  truncated: boolean;
};

/** The answer for a file's text: split into lines and cut to the same limits as a diff. */
export function fileLinesView(
  text: string | null,
  limits: { chars?: number; lines?: number } = {},
): FileLines {
  // A NUL byte is how git tells binary content apart; there is nothing to draw.
  if (text === null || text.includes("\0")) return { lines: [], truncated: false };
  const all = text.split("\n");
  if (all[all.length - 1] === "") all.pop();
  const lines = withinLimits(
    all,
    limits.lines ?? DIFF_LINE_LIMIT,
    limits.chars ?? DIFF_ANSWER_LIMIT,
  );
  return { lines, truncated: lines.length < all.length };
}

/** Lines one press of an expand arrow shows, as on GitHub. */
export const EXPAND_STEP = 20;

/**
 * Unchanged PR-head lines the diff leaves out: above a hunk (`at` is its header's row) or after
 * the last hunk (`at` is `rows.length`, and `end` is null until the file's length is known).
 */
export type ContextGap = {
  at: number;
  start: number;
  end: number | null;
  /** A hidden line's base-side number is its PR-head number plus this. */
  offset: number;
};

/** How much of a gap the reviewer opened: lines from its top (below the hunk before) and bottom. */
export type Expansion = { top: number; bottom: number };

const HUNK_COUNTS = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A hunk's first line on one side: git numbers an empty side by the line before it. */
const firstLine = (start: string | undefined, count: string | undefined): number =>
  Number(start) + (count === "0" ? 1 : 0);

/** The gaps of a file's rows; a deleted file has none, an added one nothing after its last line. */
export function contextGaps(rows: readonly DiffRow[], status: DiffFile["status"]): ContextGap[] {
  if (status === "deleted") return [];
  const gaps: ContextGap[] = [];
  let nextNew = 1;
  let nextOld = 1;
  let hunks = 0;
  // git's "no newline" marker after a PR-head line means the file ends with that line.
  let headEnds = false;
  rows.forEach((r, at) => {
    if (r.kind === "eof") {
      const before = rows[at - 1];
      if (before?.kind === "add" || before?.kind === "ctx") headEnds = true;
      return;
    }
    headEnds = false;
    if (r.kind !== "hunk") {
      if (r.new !== null) nextNew = r.new + 1;
      if (r.old !== null) nextOld = r.old + 1;
      return;
    }
    hunks++;
    const m = HUNK_COUNTS.exec(r.text);
    if (!m) return;
    const newFirst = firstLine(m[3], m[4]);
    const oldFirst = firstLine(m[1], m[2]);
    if (newFirst > nextNew)
      gaps.push({ at, start: nextNew, end: newFirst - 1, offset: oldFirst - newFirst });
    nextNew = newFirst;
    nextOld = oldFirst;
  });
  if (hunks && status !== "added" && !headEnds)
    gaps.push({ at: rows.length, start: nextNew, end: null, offset: nextOld - nextNew });
  return gaps;
}

/** The gap's last line, once the file's length (`total`) is known for the one after the last hunk. */
const gapEnd = (g: ContextGap, total: number | null): number | null => g.end ?? total;

/** Lines of the gap still hidden; null while that depends on a file length not loaded yet. */
export function hiddenCount(g: ContextGap, e: Expansion, total: number | null): number | null {
  const end = gapEnd(g, total);
  return end === null ? null : Math.max(0, end - g.start + 1 - e.top - e.bottom);
}

/**
 * The arrows a gap offers, as GitHub draws them: one to show everything when what is hidden fits a
 * step, else up (above the next hunk) for the top of the file, down (below the hunk before) for the
 * end, and both between hunks. Empty once the gap is open.
 */
export function expandControls(
  g: ContextGap,
  e: Expansion,
  total: number | null,
  rowCount: number,
): ("up" | "down" | "all")[] {
  const hidden = hiddenCount(g, e, total);
  if (hidden === 0) return [];
  if (hidden !== null && hidden <= EXPAND_STEP) return ["all"];
  if (g.at === rowCount) return ["down"];
  if (g.start === 1) return ["up"];
  return ["down", "up"];
}

/** The expansion after a press; `total` is the file's line count, needed once the file is loaded. */
export function expand(
  g: ContextGap,
  e: Expansion,
  dir: "up" | "down" | "all",
  total: number,
): Expansion {
  const hidden = hiddenCount(g, e, total) ?? 0;
  if (dir === "all" || hidden <= EXPAND_STEP) return { top: e.top + hidden, bottom: e.bottom };
  return dir === "down"
    ? { top: e.top + EXPAND_STEP, bottom: e.bottom }
    : { top: e.top, bottom: e.bottom + EXPAND_STEP };
}

/**
 * The PR-head lines a gap shows now, as unchanged rows: those opened from its top, those opened
 * from its bottom, and whether nothing is left hidden (its hunk header then goes, as on GitHub).
 * Lines past the loaded text (`lines`, a truncated file) are left out.
 */
export function shownContext(
  g: ContextGap,
  e: Expansion,
  lines: readonly string[],
): { above: DiffRow[]; below: DiffRow[]; open: boolean } {
  const end = Math.min(gapEnd(g, lines.length) ?? lines.length, lines.length);
  const row = (n: number): DiffRow => ({
    kind: "ctx",
    old: n + g.offset,
    new: n,
    text: lines[n - 1] ?? "",
  });
  const topEnd = Math.min(end, g.start + e.top - 1);
  const bottomStart = Math.max(topEnd + 1, end - e.bottom + 1);
  const above: DiffRow[] = [];
  const below: DiffRow[] = [];
  for (let n = g.start; n <= topEnd; n++) above.push(row(n));
  for (let n = bottomStart; n <= end; n++) below.push(row(n));
  return { above, below, open: hiddenCount(g, e, lines.length) === 0 };
}
