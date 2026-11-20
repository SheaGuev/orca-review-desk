import { assert, test } from "orca/testing";
import { pendingByStop, pendingOrder, stopForComment } from "./pending";

const stops = [
  { files: ["src/a.ts"], focus: [{ start: 1, end: 20 }] },
  { files: ["src/b.ts"] },
  { files: ["src/a.ts"], focus: [{ start: 50, end: 60 }] },
];

test("a comment belongs to the stop whose focus covers its line, else its file's first stop", () => {
  assert.equal(stopForComment(stops, { path: "src/a.ts", line: 55 }), 2);
  assert.equal(stopForComment(stops, { path: "src/a.ts", line: 5 }), 0);
  assert.equal(stopForComment(stops, { path: "src/a.ts", line: 99 }), 0);
  assert.equal(stopForComment(stops, { path: "src/a.ts", line: null }), 0, "whole file");
  assert.equal(stopForComment(stops, { path: "docs/x.md", line: 3 }), null, "not in the tour");
});

test("pending comments are counted per stop; files outside the tour count for none", () => {
  assert.deepEqual(
    pendingByStop(stops, [
      { path: "src/a.ts", line: 55 },
      { path: "src/a.ts", line: 56 },
      { path: "src/b.ts", line: null },
      { path: "docs/x.md", line: 3 },
    ]),
    [0, 1, 2],
  );
  assert.deepEqual(pendingByStop(stops, []), [0, 0, 0]);
});

test("the bar steps through comments in tour order, then the files outside it", () => {
  const order = pendingOrder(stops, [
    { id: "x", path: "docs/x.md", line: 3 },
    { id: "late", path: "src/a.ts", line: 58 },
    { id: "early", path: "src/a.ts", line: 52 },
    { id: "file", path: "src/b.ts", line: 9 },
    { id: "whole", path: "src/b.ts", line: null },
    { id: "a", path: "a.md", line: 1 },
    { id: "top", path: "src/a.ts", line: 2 },
  ]);
  assert.deepEqual(
    order.map((c) => c.id),
    ["top", "whole", "file", "early", "late", "a", "x"],
  );
});

test("with the skipped files' stop passed last, a comment on a skipped file belongs to it", () => {
  const all = [...stops, { files: ["bun.lock", "src/gen.ts"] }];
  assert.equal(stopForComment(all, { path: "bun.lock", line: 3 }), 3);
  assert.deepEqual(pendingByStop(all, [{ path: "src/gen.ts", line: null }]), [0, 0, 0, 1]);
});
