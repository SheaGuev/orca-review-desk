import { assert, test } from "orca/testing";
import { enforceCoverage, fullTour, OTHER_HEADLINE } from "./coverage";
import type { Finding, PrGuide, SkipReason, Stop, TourRules } from "./schema";

const stop = (over: Partial<Stop>): Stop => ({
  depth: "deep",
  files: ["a.ts"],
  why: "core",
  areaId: "rt",
  headline: "h",
  ...over,
});
const rules = (
  skipped: Record<string, SkipReason> = {},
  risky: Record<string, string> = {},
): TourRules => ({
  skipped: new Map(Object.entries(skipped)),
  risky: new Map(Object.entries(risky)),
});
const major = (file: string, headline = "Breaks things"): Finding => ({
  id: "f1",
  severity: "major",
  file,
  line: null,
  headline,
  detail: "",
  suggestedComment: null,
});

test("files in no stop go in one skim stop at the end, Other changes", () => {
  const { stops, fixed } = enforceCoverage([stop({})], ["a.ts", "b.ts", "c.ts"], [], rules());
  assert.equal(stops.length, 2);
  assert.deepEqual(stops[1], {
    depth: "skim",
    files: ["b.ts", "c.ts"],
    why: "routine",
    areaId: "other",
    headline: OTHER_HEADLINE,
  });
  assert.equal(fixed.length, 1);
  // Full coverage already: nothing changes.
  const all = [stop({}), stop({ depth: "skim", files: ["b.ts", "c.ts"], why: "repeated" })];
  assert.deepEqual(enforceCoverage(all, ["a.ts", "b.ts", "c.ts"], [], rules()), {
    stops: all,
    fixed: [],
  });
});

test("a missing risky or severe file gets its own deep stop instead", () => {
  const { stops } = enforceCoverage(
    [stop({})],
    ["a.ts", "package.json", "b.ts", "c.ts"],
    [major("b.ts", "Drops the reason")],
    rules({}, { "package.json": "dependency file" }),
  );
  assert.deepEqual(
    stops.map((s) => [s.depth, s.files, s.why, s.headline]),
    [
      ["deep", ["a.ts"], "core", "h"],
      ["deep", ["package.json"], "risky", "Dependency file package.json changed"],
      ["deep", ["b.ts"], "finding", "Drops the reason"],
      ["skim", ["c.ts"], "routine", OTHER_HEADLINE],
    ],
  );
});

test("a file in two stops stays in the first; a stop left empty is dropped", () => {
  const { stops, fixed } = enforceCoverage(
    [stop({}), stop({ files: ["a.ts"], headline: "again" }), stop({ files: ["b.ts", "a.ts"] })],
    ["a.ts", "b.ts"],
    [],
    rules(),
  );
  assert.deepEqual(
    stops.map((s) => [s.files, s.headline]),
    [
      [["a.ts"], "h"],
      [["b.ts"], "h"],
    ],
  );
  assert.equal(fixed.length, 3);
});

test("skipped and unchanged files leave their stop; focus goes with its first file", () => {
  const focus = [{ start: 1, end: 4 }];
  const { stops } = enforceCoverage(
    [
      stop({ depth: "skim", why: "repeated", files: ["bun.lock", "b.ts", "c.ts"], focus }),
      stop({ files: ["gone.ts"] }),
      stop({ files: ["a.ts", "gen.ts"], focus }),
    ],
    ["a.ts", "b.ts", "c.ts", "gen.ts"],
    [],
    rules({ "bun.lock": "lockfile", "gen.ts": "generated" }),
  );
  assert.deepEqual(
    stops.map((s) => [s.files, s.focus ?? null]),
    [
      [["b.ts", "c.ts"], null],
      [["a.ts"], focus],
    ],
  );
});

test("risky and severe files in a skim stop move to deep stops right after it", () => {
  const focus = [{ start: 1, end: 4 }];
  const { stops, fixed } = enforceCoverage(
    [
      stop({ depth: "skim", why: "repeated", files: ["x.ts", "ci.yml", "y.ts", "z.ts"], focus }),
      stop({ files: ["a.ts"] }),
    ],
    ["x.ts", "ci.yml", "y.ts", "z.ts", "a.ts"],
    [major("y.ts", "Wrong guard"), { ...major("y.ts", "Lesser"), severity: "minor" }],
    rules({}, { "ci.yml": "CI/CD file" }),
  );
  assert.deepEqual(
    stops.map((s) => [s.depth, s.files, s.why, s.headline, s.focus ?? null]),
    [
      ["skim", ["x.ts", "z.ts"], "repeated", "h", focus],
      ["deep", ["ci.yml"], "risky", "CI/CD file ci.yml changed", null],
      ["deep", ["y.ts"], "finding", "Wrong guard", null],
      ["deep", ["a.ts"], "core", "h", null],
    ],
  );
  assert.equal(fixed.length, 2);
});

test("a skim stop with only must-be-deep files becomes deep stops; the first keeps its text", () => {
  const focus = [{ start: 1, end: 4 }];
  const { stops } = enforceCoverage(
    [
      stop({
        depth: "skim",
        why: "routine",
        files: ["ci.yml", "deploy.yml"],
        headline: "CI runs on Bun",
        detail: "d",
        differences: "none",
        focus,
      }),
    ],
    ["ci.yml", "deploy.yml"],
    [],
    rules({}, { "ci.yml": "CI/CD file", "deploy.yml": "CI/CD file" }),
  );
  assert.deepEqual(stops, [
    {
      depth: "deep",
      files: ["ci.yml"],
      why: "risky",
      areaId: "rt",
      headline: "CI runs on Bun",
      detail: "d",
      focus,
    },
    {
      depth: "deep",
      files: ["deploy.yml"],
      why: "risky",
      areaId: "rt",
      headline: "CI/CD file deploy.yml changed",
    },
  ]);
  // Stored as plain JSON: nothing undefined.
  assert.deepEqual(JSON.parse(JSON.stringify(stops)), stops);
});

test("a guide from before full coverage gets its missing files and loses skipped ones on load", () => {
  const guide = {
    readingOrder: [stop({}), stop({ files: ["ws.ts"] })],
    files: [
      { path: "a.ts", note: "" },
      { path: "b.ts", note: "" },
      { path: "ws.ts", note: "" },
    ],
    commentable: { "a.ts": [], "b.ts": [], "c.ts": [], "ws.ts": [] },
    areas: [],
    findings: [],
  } as unknown as PrGuide;
  assert.deepEqual(
    fullTour(guide, [{ path: "ws.ts", reason: "whitespace" }]).map((s) => [s.depth, s.files]),
    [
      ["deep", ["a.ts"]],
      ["skim", ["b.ts", "c.ts"]],
    ],
  );
});
