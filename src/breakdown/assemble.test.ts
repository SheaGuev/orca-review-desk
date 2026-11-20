import { assert, test } from "orca/testing";
import { buildBreakdown } from "./assemble";
import { ECOSYSTEMS } from "./categories";
import { createClassifier } from "./classify";
import { parseNameStatusZ, parseNumstatZ } from "./parse";
import { formatShare } from "./share";

const classify = createClassifier({
  ecosystems: ECOSYSTEMS.filter((e) => e.name === "TypeScript/JavaScript"),
});

const numstat = parseNumstatZ(
  [
    "30\t10\tsrc/app.ts",
    "4\t4\t",
    "src/old-name.ts",
    "src/new-name.ts",
    "0\t25\tsrc/gone.ts",
    "8\t0\tsrc/app.test.ts",
    "20\t0\tdrizzle/0003_add.sql",
    "500\t0\tsrc/routeTree.gen.ts",
    "1\t1\tbun.lock",
    "-\t-\tpublic/logo.png",
    "",
  ].join("\0"),
);
const nameStatus = parseNameStatusZ(
  [
    "M",
    "src/app.ts",
    "R092",
    "src/old-name.ts",
    "src/new-name.ts",
    "D",
    "src/gone.ts",
    "M",
    "src/app.test.ts",
    "A",
    "drizzle/0003_add.sql",
    "A",
    "src/routeTree.gen.ts",
    "M",
    "bun.lock",
    "A",
    "public/logo.png",
    "",
  ].join("\0"),
);
const b = buildBreakdown({ headRef: "feat/x", baseRef: "main", numstat, nameStatus, classify });

test("files are grouped in Diff Breakdown's order with git's status letters", () => {
  assert.deepEqual(
    b.categories.map((c) => [c.id, c.files.map((f) => `${f.status} ${f.path}`)]),
    [
      [
        "runtime",
        ["M src/app.ts", "D src/gone.ts", "R src/new-name.ts", "A public/logo.png"].sort((x, y) =>
          x.slice(2).localeCompare(y.slice(2)),
        ),
      ],
      ["tests", ["M src/app.test.ts"]],
      ["migrations", ["A drizzle/0003_add.sql"]],
      ["dependencies", ["M bun.lock"]],
      ["generated", ["A src/routeTree.gen.ts"]],
    ],
  );
});

test("a rename keeps its old path; a binary file counts no lines", () => {
  const files = b.categories[0].files;
  assert.equal(files.find((f) => f.path === "src/new-name.ts")?.oldPath, "src/old-name.ts");
  assert.equal(files.find((f) => f.path === "src/app.ts")?.oldPath, undefined);
  const logo = files.find((f) => f.path === "public/logo.png");
  assert.deepEqual([logo?.additions, logo?.deletions, logo?.binary], [0, 0, true]);
  assert.ok(!("binary" in (files.find((f) => f.path === "src/app.ts") ?? {})));
});

test("Generated is listed but not counted in the totals", () => {
  assert.deepEqual([b.additions, b.deletions], [63, 40]);
  assert.equal(b.fileCount, 8);
  const generated = b.categories.find((c) => c.id === "generated");
  assert.deepEqual([generated?.additions, generated?.deletions], [500, 0]);
});

test("the counted categories' shares make up the whole", () => {
  const total = b.additions + b.deletions;
  const counted = b.categories.filter((c) => c.id !== "generated");
  assert.equal(
    counted.reduce((n, c) => n + c.additions + c.deletions, 0),
    total,
  );
  assert.deepEqual(
    counted.map((c) => formatShare(c.additions + c.deletions, total)),
    ["71%", "8%", "19%", "2%"],
  );
});

test("a category lists at most the cap, and still counts every file", () => {
  const many = Array.from({ length: 5 }, (_, i) => ({
    path: `src/f${i}.ts`,
    added: 1,
    deleted: 0,
  }));
  const capped = buildBreakdown({
    headRef: "h",
    baseRef: "b",
    numstat: many,
    nameStatus: [],
    classify,
    maxFiles: 2,
  });
  const [runtime] = capped.categories;
  assert.deepEqual(
    [runtime.files.length, runtime.omitted, runtime.additions, capped.fileCount],
    [2, 3, 5, 5],
  );
  assert.equal(runtime.files[0].status, "M", "no name-status row reads as modified");
});
