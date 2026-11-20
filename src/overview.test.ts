import { assert, test } from "orca/testing";
import {
  severityCounts,
  sortFindings,
  splitFindings,
  stopForFile,
  stopForFinding,
} from "./overview";
import type { Severity } from "./schema";

const f = (id: string, severity: Severity) => ({ id, severity });

test("findings are listed most severe first, keeping the agent's order within a severity", () => {
  const list = [
    f("a", "nit"),
    f("b", "major"),
    f("c", "minor"),
    f("d", "major"),
    f("e", "blocker"),
  ];
  assert.deepEqual(
    sortFindings(list).map((x) => x.id),
    ["e", "b", "d", "c", "a"],
  );
});

test("the three most severe findings are listed; the rest wait behind Show more", () => {
  const list = [
    ...Array.from({ length: 2 }, (_, i) => f(`n${i}`, "nit")),
    ...Array.from({ length: 2 }, (_, i) => f(`m${i}`, "minor")),
    ...Array.from({ length: 2 }, (_, i) => f(`M${i}`, "major")),
  ];
  const { visible, hidden } = splitFindings(list);
  assert.deepEqual(
    visible.map((x) => x.id),
    ["M0", "M1", "m0"],
  );
  assert.deepEqual(
    hidden.map((x) => x.id),
    ["m1", "n0", "n1"],
  );
  assert.deepEqual(splitFindings([f("a", "minor")]), { visible: [f("a", "minor")], hidden: [] });
});

test("a finding belongs to the stop whose focus covers its line, else the file's first stop", () => {
  const stops = [
    { files: ["a.ts"], focus: [{ start: 1, end: 10 }] },
    { files: ["b.ts", "c.ts"] },
    { files: ["a.ts"], focus: [{ start: 40, end: 60 }] },
  ];
  assert.equal(stopForFinding(stops, { file: "a.ts", line: 45 }), 2);
  assert.equal(stopForFinding(stops, { file: "a.ts", line: 5 }), 0);
  assert.equal(stopForFinding(stops, { file: "a.ts", line: 99 }), 0);
  assert.equal(stopForFinding(stops, { file: "a.ts", line: null }), 0);
  assert.equal(stopForFinding(stops, { file: "b.ts", line: 3 }), 1);
  assert.equal(stopForFinding(stops, { file: "c.ts", line: 3 }), 1, "a skim stop's other file");
  assert.equal(stopForFinding(stops, { file: "d.ts", line: 3 }), null);
  // Focus is on a stop's first file only: a line in it on another file doesn't pick that stop.
  const skim = [{ files: ["x.ts"] }, { files: ["y.ts", "x.ts"], focus: [{ start: 1, end: 9 }] }];
  assert.equal(stopForFinding(skim, { file: "x.ts", line: 5 }), 0);
});

test("severity counts read as text", () => {
  assert.equal(
    severityCounts([f("a", "nit"), f("b", "major"), f("c", "major"), f("d", "minor")]),
    "2 major · 1 minor · 1 nit",
  );
  assert.equal(severityCounts([]), "");
});

test("a file's stop is the first stop holding it; files no stop covers have none", () => {
  const stops = [{ files: ["a.ts"] }, { files: ["d.ts", "b.ts"] }, { files: ["a.ts"] }];
  assert.equal(stopForFile(stops, "a.ts"), 0);
  assert.equal(stopForFile(stops, "b.ts"), 1);
  assert.equal(stopForFile(stops, "c.ts"), null);
});
