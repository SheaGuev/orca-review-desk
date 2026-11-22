import { assert, test } from "orca/testing";
import { claudeToolCalls } from "./agent";
import {
  budgetDiff,
  commentableLines,
  coverage,
  fileKind,
  filesReadByAgent,
  inRanges,
  splitDiff,
  toRanges,
  type FileDiff,
} from "./diff";

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
  "similarity index 90%",
  "rename from old/name.ts",
  "rename to new/name.ts",
  "index 3333333..4444444 100644",
  "--- a/old/name.ts",
  "+++ b/new/name.ts",
  "@@ -5 +5 @@",
  "-x",
  "+y",
  "diff --git a/img/logo.png b/img/logo.png",
  "index 5555555..6666666 100644",
  "Binary files a/img/logo.png and b/img/logo.png differ",
  "diff --git a/gone.ts b/gone.ts",
  "deleted file mode 100644",
  "index 7777777..0000000",
  "--- a/gone.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-a",
  "-b",
  "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
  "--- a/pnpm-lock.yaml",
  "+++ b/pnpm-lock.yaml",
  "@@ -1 +1 @@",
  "-a",
  "+b",
  "",
].join("\n");

test("splits a diff into files, following renames and leaving lockfiles out", () => {
  const files = splitDiff(DIFF);
  assert.deepEqual(
    files.map((f) => [f.path, f.oldPath, f.binary, f.additions, f.deletions]),
    [
      ["src/a.ts", null, false, 2, 2],
      ["new/name.ts", "old/name.ts", false, 1, 1],
      ["img/logo.png", null, true, 0, 0],
      ["gone.ts", null, false, 0, 2],
    ],
  );
  assert.ok(files[0]?.text.startsWith("diff --git a/src/a.ts"));
  assert.ok(!files[0]?.text.includes("new/name.ts"), "each file carries only its own text");
});

test("commentable lines are added and context lines on the PR-head side", () => {
  const lines = commentableLines(DIFF);
  // hunk 1: one(1) two!(2) two and a half(3) three(4) four(5); hunk 2: twenty(21) twenty-two(22)
  assert.deepEqual([...(lines.get("src/a.ts") ?? [])], [1, 2, 3, 4, 5, 21, 22]);
  assert.deepEqual([...(lines.get("new/name.ts") ?? [])], [5]);
  assert.equal(lines.get("img/logo.png")?.size, 0, "binary files take no line comments");
  assert.equal(lines.get("gone.ts")?.size, 0, "a deleted file has no PR-head lines");
  assert.equal(lines.has("pnpm-lock.yaml"), false);
  const ranges = toRanges(lines.get("src/a.ts") ?? new Set());
  assert.deepEqual(ranges, [
    [1, 5],
    [21, 22],
  ]);
  assert.ok(inRanges(ranges, 21) && !inRanges(ranges, 6));
});

const file = (path: string, size: number, lines: number): FileDiff => ({
  path,
  oldPath: null,
  text: "x".repeat(size),
  binary: false,
  additions: lines,
  deletions: 0,
});

test("the budget takes whole files: source by size, then config, tests, docs", () => {
  assert.equal(fileKind("src/a.test.ts"), "test");
  assert.equal(fileKind("README.md"), "docs");
  assert.equal(fileKind("package.json"), "config");
  assert.equal(fileKind("src/index.ts"), "source");
  const files = [
    file("README.md", 10, 1),
    file("src/a.test.ts", 30, 50),
    file("src/small.ts", 20, 5),
    file("src/big.ts", 60, 100),
    file("tsconfig.json", 10, 2),
  ];
  const all = budgetDiff(files, 1_000);
  assert.deepEqual(
    all.inPrompt.map((f) => f.path),
    ["src/big.ts", "src/small.ts", "tsconfig.json", "src/a.test.ts", "README.md"],
  );
  // 100: big (60) fits, small (20) fits, tsconfig (10) fits, the test (30) does not, README (10) does.
  const tight = budgetDiff(files, 100);
  assert.deepEqual(
    tight.inPrompt.map((f) => f.path),
    ["src/big.ts", "src/small.ts", "tsconfig.json", "README.md"],
  );
  assert.deepEqual(
    tight.outside.map((f) => f.path),
    ["src/a.test.ts"],
  );
});

test("coverage comes from the files the agent read with its tools", () => {
  const stdout = JSON.stringify([
    { type: "system", subtype: "init" },
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Reading" },
          { type: "tool_use", name: "Read", input: { file_path: "/repo/src/a.ts" } },
          {
            type: "tool_use",
            name: "Read",
            input: { file_path: "/repo/.pr-tour/runs/7/head/0002.txt" },
          },
        ],
      },
    },
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Read",
            input: { file_path: ".pr-tour/runs/7/diffs/0003.diff" },
          },
          {
            type: "tool_use",
            name: "Read",
            input: { file_path: "/repo/.pr-tour/runs/7/index.txt" },
          },
          { type: "tool_use", name: "Grep", input: { pattern: "x", path: "src/c.ts" } },
        ],
      },
    },
    { type: "result", result: "{}" },
  ]);
  const calls = claudeToolCalls(stdout);
  assert.equal(calls.length, 5);
  const changed = ["src/a.ts", "src/b.ts", "src/c.ts", "docs/x.md", "src/d.ts"];
  // The run's index: prepared files by path from the clone, to the PR path each one holds.
  const prepared = new Map([
    [".pr-tour/runs/7/head/0002.txt", "src/b.ts"],
    [".pr-tour/runs/7/diffs/0003.diff", "docs/x.md"],
    [".pr-tour/runs/7/head/0003.txt", "docs/x.md"],
  ]);
  const read = filesReadByAgent(calls, changed, "/repo", prepared);
  assert.deepEqual(read, ["src/a.ts", "src/b.ts", "docs/x.md"]);
  assert.deepEqual(coverage(changed, ["src/a.ts"], read), {
    inPrompt: ["src/a.ts"],
    readByAgent: read,
    notRead: ["src/c.ts", "src/d.ts"],
  });
  // Without an index, only reads of the clone's own paths count.
  assert.deepEqual(filesReadByAgent(calls, changed, "/repo"), ["src/a.ts"]);
  assert.deepEqual(claudeToolCalls('{"type":"result","result":"x"}'), []);
});
