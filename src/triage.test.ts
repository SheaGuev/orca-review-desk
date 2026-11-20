import { assert, test } from "orca/testing";
import type { CategoryId } from "./breakdown/types";
import { riskyFiles, skippedFiles } from "./triage";

const classify = (path: string): CategoryId =>
  path.endsWith(".gen.ts")
    ? "generated"
    : path === "package.json" || path === "bun.lock"
      ? "dependencies"
      : path.startsWith(".github/")
        ? "cicd"
        : "runtime";

test("lockfiles, generated files, pure renames and whitespace-only changes are skipped, with why", () => {
  const skipped = skippedFiles({
    numstat: [
      { path: "src/a.ts", added: 3, deleted: 1 },
      { path: "bun.lock", added: 40, deleted: 2 },
      { path: "src/routeTree.gen.ts", added: 9, deleted: 9 },
      { path: "src/moved.ts", added: 0, deleted: 0 },
      { path: "src/edited-move.ts", added: 2, deleted: 1 },
      { path: "src/indent.ts", added: 12, deleted: 12 },
      { path: "logo.png", added: null, deleted: null },
      { path: "src/empty.ts", added: 0, deleted: 0 },
    ],
    nameStatus: [
      { path: "src/moved.ts", oldPath: "src/old.ts", status: "R" },
      { path: "src/edited-move.ts", oldPath: "src/x.ts", status: "R" },
      { path: "src/empty.ts", status: "A" },
    ],
    // `git diff -w --numstat` leaves out files whose only change is whitespace.
    numstatIgnoringSpace: [
      { path: "src/a.ts", added: 3, deleted: 1 },
      { path: "bun.lock", added: 40, deleted: 2 },
      { path: "src/routeTree.gen.ts", added: 9, deleted: 9 },
      { path: "src/moved.ts", added: 0, deleted: 0 },
      { path: "src/edited-move.ts", added: 2, deleted: 1 },
      { path: "logo.png", added: null, deleted: null },
    ],
    classify,
  });
  assert.deepEqual(skipped, [
    { path: "bun.lock", reason: "lockfile" },
    { path: "src/indent.ts", reason: "whitespace" },
    { path: "src/moved.ts", reason: "rename" },
    { path: "src/routeTree.gen.ts", reason: "generated" },
  ]);
});

test("a whitespace-only rename reads as whitespace; a lockfile that is also generated as a lockfile", () => {
  const skipped = skippedFiles({
    numstat: [
      { path: "src/b.ts", added: 2, deleted: 2 },
      { path: "pnpm-lock.yaml", added: 1, deleted: 1 },
    ],
    nameStatus: [{ path: "src/b.ts", oldPath: "src/a.ts", status: "R" }],
    numstatIgnoringSpace: [],
    classify: () => "generated",
  });
  assert.deepEqual(skipped, [
    { path: "pnpm-lock.yaml", reason: "lockfile" },
    { path: "src/b.ts", reason: "generated" },
  ]);
});

test("risky files are those of a risky kind, never lockfiles or skipped ones", () => {
  const risky = riskyFiles(
    ["package.json", "bun.lock", ".github/workflows/ci.yml", "src/a.ts", ".github/old.yml"],
    classify,
    new Set([".github/old.yml"]),
  );
  assert.deepEqual(
    [...risky],
    [
      ["package.json", "dependency file"],
      [".github/workflows/ci.yml", "CI/CD file"],
    ],
  );
});
