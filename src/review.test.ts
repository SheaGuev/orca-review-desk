import { assert, test } from "orca/testing";
import {
  asDraft,
  commentPlace,
  emptyDraft,
  fileCommentPayloads,
  reviewPayload,
  rangeProblem,
  reviewProblem,
  staleComments,
  suggestedSummary,
  type Draft,
} from "./review";
import { AGENT_GUIDE } from "./fixtures";

const draft: Draft = {
  commitId: "c0",
  body: "",
  comments: [
    { id: "a", path: "src/a.ts", line: 3, body: " Why? ", source: "manual" },
    { id: "b", path: "src/a.ts", line: null, body: "Split this file.", source: "finding:f2" },
    { id: "c", path: "src/b.ts", line: 40, body: "Off by one.", source: "finding:f1" },
  ],
  dismissedFindings: [],
};

test("line comments go in the review, on the RIGHT side of the PR head", () => {
  assert.deepEqual(reviewPayload(draft, "REQUEST_CHANGES", " Fix the bound. ", "c1"), {
    commit_id: "c1",
    event: "REQUEST_CHANGES",
    body: "Fix the bound.",
    comments: [
      { path: "src/a.ts", line: 3, side: "RIGHT", body: "Why?" },
      { path: "src/b.ts", line: 40, side: "RIGHT", body: "Off by one." },
    ],
  });
});

test("whole-file comments are split out, to post one at a time", () => {
  assert.deepEqual(
    fileCommentPayloads(draft, "c1").map((x) => [x.comment.id, x.payload]),
    [["b", { commit_id: "c1", path: "src/a.ts", body: "Split this file.", subject_type: "file" }]],
  );
});

test("comments whose line left the diff, or whose file did, are reported", () => {
  const lines: Record<string, number[]> = { "src/a.ts": [1, 2, 3] };
  const isCommentable = (p: string, l: number) => lines[p]?.includes(l) ?? false;
  assert.deepEqual(
    staleComments(draft, isCommentable, ["src/a.ts", "src/b.ts"]).map((c) => c.id),
    ["c"],
  );
  assert.deepEqual(
    staleComments(draft, isCommentable, ["src/b.ts"]).map((c) => c.id),
    ["a", "b", "c"],
    "a file the PR no longer changes takes no comments, not even whole-file ones",
  );
});

test("refuses what GitHub would refuse, before sending", () => {
  assert.equal(
    reviewProblem(draft, "APPROVE", "", false),
    "GitHub does not let you approve or request changes on your own PR.",
  );
  assert.equal(reviewProblem(draft, "APPROVE", "", true), null);
  assert.equal(
    reviewProblem(emptyDraft("c"), "REQUEST_CHANGES", " ", true),
    "Say what needs to change in the summary.",
  );
  assert.equal(
    reviewProblem(emptyDraft("c"), "COMMENT", "", true),
    "Write a summary or add a line comment.",
  );
  assert.equal(reviewProblem(draft, "COMMENT", "", false), null);
  assert.equal(
    reviewProblem(
      { ...draft, comments: [{ ...draft.comments[0], body: "  " }] },
      "COMMENT",
      "x",
      true,
    ),
    "A comment in this review is empty.",
  );
});

test("a draft from storage keeps only well-formed comments", () => {
  const raw = {
    commitId: "c9",
    body: "b",
    comments: [
      draft.comments[0],
      { id: "x", path: "", line: 1, body: "no path", source: "manual" },
      { id: "y", path: "a", line: 0, body: "bad line", source: "manual" },
      { id: "z", path: "a", line: 2, body: "bad source", source: "robot" },
      { ...draft.comments[1], extra: true },
    ],
    dismissedFindings: ["f1", 3],
  };
  const d = asDraft(raw, "fallback");
  assert.deepEqual(
    d.comments.map((c) => c.id),
    ["a", "b"],
  );
  assert.equal("extra" in d.comments[1], false);
  assert.deepEqual(d.dismissedFindings, ["f1"]);
  assert.deepEqual(asDraft(null, "h"), emptyDraft("h"));
});

test("the suggested summary lists the findings added to the review, most severe first", () => {
  const findings = [
    {
      ...AGENT_GUIDE.findings[1],
      id: "f2",
      file: "src/a.ts",
      line: null,
      headline: "Split this file.",
    },
    { ...AGENT_GUIDE.findings[0], id: "f1", file: "src/b.ts", line: 40, headline: "Off by one." },
    { ...AGENT_GUIDE.findings[0], id: "f3", headline: "Not added." },
  ];
  assert.equal(
    suggestedSummary(draft, findings),
    [
      "A few things to look at before this merges:",
      "- Off by one. (`src/b.ts:40`)",
      "- Split this file. (`src/a.ts`)",
    ].join("\n"),
  );
  assert.equal(
    suggestedSummary({ ...draft, comments: draft.comments.slice(0, 1) }, findings),
    "",
    "manual comments alone suggest nothing",
  );
  assert.ok(
    suggestedSummary({ ...draft, comments: draft.comments.slice(2) }, findings).startsWith(
      "One thing",
    ),
  );
});

// Two hunks of src/a.ts on the PR-head side: lines 10-14 and 30-33.
const hunks: Record<string, [number, number][]> = {
  "src/a.ts": [
    [10, 14],
    [30, 33],
  ],
};
const inHunks = (p: string, l: number) => hunks[p]?.some(([a, b]) => l >= a && l <= b) ?? false;

test("a range comment needs both lines commentable and in one hunk", () => {
  assert.equal(rangeProblem(inHunks, "src/a.ts", 10, 14), null);
  assert.equal(rangeProblem(inHunks, "src/a.ts", 14, 10), null, "either order");
  assert.equal(rangeProblem(inHunks, "src/a.ts", 12, 12), null, "one line");
  assert.equal(
    rangeProblem(inHunks, "src/a.ts", 12, 31),
    "Lines 12 and 31 are in different hunks: GitHub takes a range only within one hunk.",
  );
  assert.equal(
    rangeProblem(inHunks, "src/a.ts", 9, 12),
    "Line 9 is not an added or unchanged line of this diff.",
  );
  assert.equal(
    rangeProblem(inHunks, "src/a.ts", 30, 40),
    "Line 40 is not an added or unchanged line of this diff.",
  );
});

test("a range comment posts start_line and start_side; a one-line comment does not", () => {
  const ranged: Draft = {
    ...emptyDraft("c0"),
    comments: [
      { id: "r", path: "src/a.ts", line: 14, startLine: 11, body: "These four.", source: "manual" },
      { id: "o", path: "src/a.ts", line: 31, body: "This one.", source: "manual" },
    ],
  };
  assert.deepEqual(reviewPayload(ranged, "COMMENT", "", "c1").comments, [
    {
      path: "src/a.ts",
      line: 14,
      side: "RIGHT",
      start_line: 11,
      start_side: "RIGHT",
      body: "These four.",
    },
    { path: "src/a.ts", line: 31, side: "RIGHT", body: "This one." },
  ]);
  assert.equal(commentPlace(ranged.comments[0]), "lines 11–14");
  assert.equal(commentPlace(ranged.comments[1]), "line 31");
  assert.equal(commentPlace({ line: null }), "the whole file");
});

test("a range that spans hunks after the PR moved is stale; a stored range is kept", () => {
  const d: Draft = {
    ...emptyDraft("c0"),
    comments: [
      { id: "ok", path: "src/a.ts", line: 13, startLine: 10, body: "x", source: "manual" },
      { id: "split", path: "src/a.ts", line: 31, startLine: 13, body: "x", source: "manual" },
    ],
  };
  assert.deepEqual(
    staleComments(d, inHunks, ["src/a.ts"]).map((c) => c.id),
    ["split"],
  );
  const stored = asDraft(JSON.parse(JSON.stringify(d)), "c0");
  assert.equal(stored.comments[0].startLine, 10);
  const bad = asDraft(
    {
      ...d,
      comments: [
        { ...d.comments[0], startLine: 13, line: 10 },
        { ...d.comments[0], id: "f", line: null },
      ],
    },
    "c0",
  );
  assert.deepEqual(
    bad.comments,
    [],
    "a start after its end, or on a whole-file comment, is refused",
  );
  assert.equal("startLine" in asDraft(draft, "c0").comments[0], false, "no undefined field");
});
