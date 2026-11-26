// Syntax colours in the guide's diffs: which files get them, how each side of a diff is
// tokenized, and how colours and changed-word marks share a row.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { assert, test } from "orca/testing";
import { grammarFor, highlightRows, sides } from "../editor/highlight";
import { codeThemeOf, nextCodeTheme } from "../editor/code-theme";
import type { DiffRow } from "./diff-model";

const rows: DiffRow[] = [
  { kind: "hunk", text: "@@ -1,2 +1,2 @@", old: 1, new: 1 },
  { kind: "ctx", old: 1, new: 1, text: "/* a comment" },
  { kind: "del", old: 2, new: null, text: 'const a = "old"' },
  { kind: "add", old: null, new: 2, text: 'end */ const a = "new"' },
];

test("files get a grammar by extension or name; others stay plain", () => {
  assert.equal(grammarFor("packages/a/src/resolveCheckIn.ts"), "typescript");
  assert.equal(grammarFor("App.TSX"), "tsx");
  assert.equal(grammarFor("schema/check-in.graphql"), "graphql");
  assert.equal(grammarFor("infra/Dockerfile"), "dockerfile");
  assert.equal(grammarFor("bun.lock"), null);
  assert.equal(grammarFor(".env"), null);
});

test("the PR head side is unchanged and added rows; the base side is removed rows", () => {
  const { head, base } = sides(rows);
  assert.deepEqual(head.rows, [1, 3]);
  assert.deepEqual(base.rows, [2]);
});

test("a comment opened on an unchanged line colours the added line it closes on", async () => {
  const tokens = await highlightRows("a.ts", rows);
  assert.equal(tokens.has(0), false, "hunk headers are not code");
  const added = tokens.get(3) ?? [];
  const comment = added.find((t) => t.start === 0);
  assert.equal(comment?.styles["cursor-dark"]?.color?.toLowerCase(), "#9a9a9a");
  assert.equal(comment?.styles["cursor-dark"]?.italic, true);
});

test("each theme colours the same token its own way", async () => {
  const tokens = await highlightRows("a.ts", rows);
  const removed = tokens.get(2) ?? [];
  const keyword = removed.find((t) => t.start === 0 && t.end === 5);
  assert.equal(keyword?.styles["cursor-dark"]?.color?.toLowerCase(), "#83d2ce");
  assert.ok(keyword?.styles.armada?.color, "Armada colours `const` too");
  const text = 'const a = "old"';
  const covered = removed.reduce((n, t) => n + (t.end - t.start), 0);
  assert.equal(covered, text.length, "runs cover the whole line");
});

test("a row draws its colour runs, cut where a changed word starts and ends", async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  try {
    const { rowNode } = await import("../editor/diff-rows");
    const tokens = await highlightRows("a.ts", rows);
    const row = rows[2];
    assert.ok(row);
    const el = rowNode(row, () => false, [[11, 14]], tokens.get(2));
    const code = el.querySelector(".code");
    assert.equal(code?.textContent, 'const a = "old"');
    const word = code?.querySelector(".word");
    assert.equal(word?.textContent, "old");
    const tok = word?.querySelector<HTMLElement>(".tok");
    assert.ok(tok?.style.getPropertyValue("--tc-cursor-dark"), "the changed word keeps its colour");
  } finally {
    await GlobalRegistrator.unregister();
  }
});

test("the code colors setting falls back to Cursor Dark and cycles through every choice", () => {
  assert.equal(codeThemeOf(undefined), "cursor-dark");
  assert.equal(codeThemeOf("removed-theme"), "cursor-dark");
  assert.equal(codeThemeOf("armada"), "armada");
  assert.equal(nextCodeTheme("cursor-dark"), "armada");
  assert.equal(nextCodeTheme("armada"), "none");
  assert.equal(nextCodeTheme("none"), "cursor-dark");
});
