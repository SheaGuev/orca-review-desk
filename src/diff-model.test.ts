import { assert, test } from "orca/testing";
import { nth } from "./fixtures";
import { splitDiff } from "./diff";
import {
  contextGaps,
  diffRows,
  expand,
  expandControls,
  fileDiffView,
  fileLinesView,
  shownContext,
  focusPieces,
  gutterDigits,
  rowOfLine,
  wordChanges,
} from "./diff-model";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,4 +1,5 @@",
  " one",
  "-two",
  "+two!",
  "+two and a half",
  " three",
  " four",
  "@@ -20,3 +21,2 @@ function x() {",
  " twenty",
  "-gone",
  " twenty-two",
  "\\ No newline at end of file",
  "diff --git a/old/name.ts b/new/name.ts",
  "similarity index 100%",
  "rename from old/name.ts",
  "rename to new/name.ts",
  "diff --git a/img/logo.png b/img/logo.png",
  "new file mode 100644",
  "index 0000000..6666666",
  "Binary files /dev/null and b/img/logo.png differ",
  "diff --git a/gone.ts b/gone.ts",
  "deleted file mode 100644",
  "index 7777777..0000000",
  "--- a/gone.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-a",
  "-b",
  "diff --git a/bun.lock b/bun.lock",
  "--- a/bun.lock",
  "+++ b/bun.lock",
  "@@ -1 +1 @@",
  "-a",
  "+b",
  "",
].join("\n");

const files = splitDiff(DIFF, { keepLockfiles: true });
const file = (path: string) => files.find((f) => f.path === path) ?? null;

test("numbers lines on both sides across hunks", () => {
  const view = fileDiffView(file("src/a.ts"), "src/a.ts", "abc");
  assert.equal(view.status, "modified");
  assert.equal(view.truncated, false);
  assert.equal(view.totalLines, 12);
  assert.equal(view.lines[0], "@@ -1,4 +1,5 @@");
  const rows = diffRows(view.lines);
  const numbered = rows.map((r) => (r.kind === "eof" ? "eof" : `${r.kind} ${r.old} ${r.new}`));
  assert.deepEqual(numbered, [
    "hunk 1 1",
    "ctx 1 1",
    "del 2 null",
    "add null 2",
    "add null 3",
    "ctx 3 4",
    "ctx 4 5",
    "hunk 20 21",
    "ctx 20 21",
    "del 21 null",
    "ctx 22 22",
    "eof",
  ]);
  assert.deepEqual(rows[3], { kind: "add", old: null, new: 2, text: "two!" });
  assert.equal(gutterDigits(rows), 2);
});

test("keeps the no-newline marker as its own row, not a line", () => {
  const rows = diffRows(["@@ -1 +1 @@", "-a", "\\ No newline at end of file", "+a", "+b"]);
  assert.deepEqual(rows.slice(1), [
    { kind: "del", old: 1, new: null, text: "a" },
    { kind: "eof", text: "No newline at end of file" },
    { kind: "add", old: null, new: 1, text: "a" },
    { kind: "add", old: null, new: 2, text: "b" },
  ]);
});

test("finds the row for a PR-head line, never a deleted one", () => {
  const rows = diffRows(fileDiffView(file("src/a.ts"), "src/a.ts", "abc").lines);
  assert.equal(rows[rowOfLine(rows, 3)]?.kind, "add");
  assert.equal(rows[rowOfLine(rows, 22)]?.kind, "ctx");
  assert.equal(rowOfLine(rows, 99), -1);
});

test("binary, renamed-only, deleted and lockfile files", () => {
  const binary = fileDiffView(file("img/logo.png"), "img/logo.png", "abc");
  assert.equal(binary.binary, true);
  assert.equal(binary.status, "added");
  assert.deepEqual(binary.lines, []);
  const renamed = fileDiffView(file("new/name.ts"), "new/name.ts", "abc");
  assert.equal(renamed.status, "renamed");
  assert.equal(renamed.oldPath, "old/name.ts");
  assert.deepEqual(renamed.lines, []);
  const deleted = fileDiffView(file("gone.ts"), "gone.ts", "abc");
  assert.equal(deleted.status, "deleted");
  assert.equal(deleted.deletions, 2);
  assert.ok(file("bun.lock"), "lockfiles are kept when asked for");
  assert.equal(
    splitDiff(DIFF).some((f) => f.path === "bun.lock"),
    false,
  );
});

test("a path with no changes answers an empty diff", () => {
  const none = fileDiffView(null, "src/none.ts", "abc");
  assert.deepEqual(
    [none.path, none.lines, none.totalLines, none.truncated],
    ["src/none.ts", [], 0, false],
  );
});

test("cuts long diffs at a line boundary and says so", () => {
  const big = [
    "diff --git a/big.ts b/big.ts",
    "--- a/big.ts",
    "+++ b/big.ts",
    "@@ -0,0 +1,500 @@",
    ...Array.from({ length: 500 }, (_, i) => `+line ${i}\t"quoted"`),
    "",
  ].join("\n");
  const f = nth(splitDiff(big));
  const byLines = fileDiffView(f, "big.ts", "abc", { lines: 100 });
  assert.equal(byLines.lines.length, 100);
  assert.equal(byLines.totalLines, 501);
  assert.equal(byLines.truncated, true);
  const byChars = fileDiffView(f, "big.ts", "abc", { chars: 1_000 });
  assert.ok(byChars.truncated);
  assert.ok(JSON.stringify(byChars.lines).length <= 1_000 + 2);
  const rows = diffRows(byChars.lines);
  assert.equal(rows[rows.length - 1]?.kind, "add", "a cut diff still numbers what it has");
});

/** Two hunks, far apart: lines 1-12 (a change at 6-7) and 40-47 (a change at 44). */
const TWO_HUNKS = [
  "@@ -1,11 +1,12 @@ function first() {",
  " l1",
  " l2",
  " l3",
  " l4",
  " l5",
  "-old6",
  "+new6",
  "+new7",
  " l8",
  " l9",
  " l10",
  " l11",
  " l12",
  "@@ -39,8 +40,8 @@ function second() {",
  " l40",
  " l41",
  " l42",
  " l43",
  "-old44",
  "+new44",
  " l45",
  " l46",
  " l47",
];

const lineOf = (rows: ReturnType<typeof diffRows>, i: number) => {
  const r = rows[i];
  return r?.kind === "hunk"
    ? "hunk"
    : r?.kind === "eof"
      ? "eof"
      : `${r?.kind}:${r?.old ?? ""}/${r?.new ?? ""}`;
};

test("a focus range shows its lines, what they replaced and two lines of context", () => {
  const rows = diffRows(TWO_HUNKS);
  const { focused, pieces } = focusPieces(rows, [{ start: 6, end: 7 }]);
  assert.equal(focused, true);
  assert.deepEqual(
    pieces.map((p) => p.kind),
    ["gap", "show", "gap"],
  );
  const [lead, shown, tail] = pieces;
  // Lines 1-3 hidden (with the hunk header), 4-5 context, -old6, +6, +7, 8-9 context shown.
  assert.deepEqual(lead, { kind: "gap", from: 0, to: 4, lines: 3 });
  assert.deepEqual(
    rows.slice(shown?.from, shown?.to).map((_, i) => lineOf(rows, (shown?.from ?? 0) + i)),
    ["ctx:4/4", "ctx:5/5", "del:6/", "add:/6", "add:/7", "ctx:7/8", "ctx:8/9"],
  );
  // The rest of hunk one and all of hunk two: 3 + 9 code lines, the second header included.
  assert.deepEqual(tail, { kind: "gap", from: 11, to: rows.length, lines: 12 });
});

test("ranges in two hunks show both with a gap between; a hunk header shows when adjacent", () => {
  const rows = diffRows(TWO_HUNKS);
  const { pieces } = focusPieces(rows, [
    { start: 1, end: 2 },
    { start: 44, end: 44 },
  ]);
  assert.deepEqual(
    pieces.map((p) => [p.kind, p.from, p.to, p.kind === "gap" ? p.lines : null]),
    [
      ["show", 0, 5, null], // hunk one's header, 1, 2, then 3-4 as context
      ["gap", 5, 17, 11], // 5-12 of hunk one, hunk two's header, 40-41
      ["show", 17, 23, null], // 42-43, -old44, +44, 45-46
      ["gap", 23, 24, 1], // 47
    ],
  );
  assert.equal(rows[0]?.kind, "hunk");
  assert.equal(lineOf(rows, 22), "ctx:45/46");
});

test("no focus, or a focus on no row, shows the whole file", () => {
  const rows = diffRows(TWO_HUNKS);
  for (const ranges of [undefined, null, [], [{ start: 200, end: 300 }]]) {
    const { focused, pieces } = focusPieces(rows, ranges);
    assert.equal(focused, false);
    assert.deepEqual(pieces, [{ kind: "show", from: 0, to: rows.length }]);
  }
  assert.deepEqual(focusPieces([], [{ start: 1, end: 2 }]).pieces, []);
});

test("overlapping ranges and a range touching the end merge into one run", () => {
  const rows = diffRows(TWO_HUNKS);
  const { pieces } = focusPieces(rows, [
    { start: 44, end: 47 },
    { start: 45, end: 46 },
  ]);
  assert.deepEqual(
    pieces.map((p) => p.kind),
    ["gap", "show"],
  );
  assert.equal(pieces[1]?.to, rows.length);
});

test("a changed line pair marks only the words that changed", () => {
  const rows = diffRows([
    "@@ -1,3 +1,3 @@",
    ' "ring-1 bg-card rounded-2xl py-6 text-sm"',
    '-"ring-1 bg-card rounded-2xl py-6 text-sm"',
    '+"bg-card border py-6 text-sm"',
  ]);
  const marks = wordChanges(rows);
  const del = nth(rows, 2).text;
  const add = nth(rows, 3).text;
  assert.deepEqual(
    (marks.get(2) ?? []).map(([a, b]) => del.slice(a, b)),
    ["ring-1", "rounded-2xl"],
  );
  assert.deepEqual(
    (marks.get(3) ?? []).map(([a, b]) => add.slice(a, b)),
    ["border"],
  );
  assert.equal(marks.has(1), false, "context lines are never marked");
});

test("lines with nothing in common, or with no partner, get no word marks", () => {
  const rows = diffRows(["@@ -1,2 +1,3 @@", "-alpha beta", "+gamma delta", "+extra line"]);
  assert.equal(wordChanges(rows).size, 0);
});

test("gaps sit above each hunk and after the last, numbered on both sides", () => {
  const rows = diffRows(fileDiffView(file("src/a.ts"), "src/a.ts", "abc").lines);
  // The second hunk's file ends with no newline, so nothing follows it.
  assert.deepEqual(contextGaps(rows, "modified"), [{ at: 7, start: 6, end: 20, offset: -1 }]);
  const open = diffRows(["@@ -5,2 +5,3 @@", " a", "+b", " c"]);
  assert.deepEqual(contextGaps(open, "modified"), [
    { at: 0, start: 1, end: 4, offset: 0 },
    { at: 4, start: 8, end: null, offset: -1 },
  ]);
  assert.deepEqual(contextGaps(open, "added"), [{ at: 0, start: 1, end: 4, offset: 0 }]);
  assert.deepEqual(contextGaps(open, "deleted"), []);
});

test("expand arrows step 20 lines at a time from either side, as on GitHub", () => {
  const between = { at: 9, start: 30, end: 79, offset: 2 };
  const none = { top: 0, bottom: 0 };
  assert.deepEqual(expandControls(between, none, null, 20), ["down", "up"]);
  const down = expand(between, none, "down", 200);
  assert.deepEqual(down, { top: 20, bottom: 0 });
  const both = expand(between, down, "up", 200);
  assert.deepEqual(both, { top: 20, bottom: 20 });
  // 10 left: one press shows them all.
  assert.deepEqual(expandControls(between, both, null, 20), ["all"]);
  const all = expand(between, both, "up", 200);
  assert.deepEqual(expandControls(between, all, null, 20), []);
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
  const shown = shownContext(between, both, lines);
  assert.equal(shown.above.length, 20);
  assert.deepEqual(shown.above[0], { kind: "ctx", old: 32, new: 30, text: "line 30" });
  assert.deepEqual(shown.below.at(-1), { kind: "ctx", old: 81, new: 79, text: "line 79" });
  assert.ok(!shown.open);
  assert.ok(shownContext(between, all, lines).open);
  // The top of the file only goes up; the end only down, its length unknown until loaded.
  assert.deepEqual(expandControls({ at: 0, start: 1, end: 40, offset: 0 }, none, null, 9), ["up"]);
  const end = { at: 9, start: 50, end: null, offset: 0 };
  assert.deepEqual(expandControls(end, none, null, 9), ["down"]);
  assert.deepEqual(expandControls(end, none, 55, 9), ["all"]);
  assert.deepEqual(expandControls(end, none, 49, 9), []);
});

test("a file's text comes back as lines, cut to the limits, empty when binary", () => {
  assert.deepEqual(fileLinesView("a\nb\n"), { lines: ["a", "b"], truncated: false });
  assert.deepEqual(fileLinesView("a\nb"), { lines: ["a", "b"], truncated: false });
  assert.deepEqual(fileLinesView("a\u0000b"), { lines: [], truncated: false });
  assert.deepEqual(fileLinesView(null), { lines: [], truncated: false });
  assert.deepEqual(fileLinesView("a\nb\nc", { lines: 2 }), { lines: ["a", "b"], truncated: true });
});
