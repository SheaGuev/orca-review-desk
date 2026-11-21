// Shared test data: a reply an agent could write, and the PR it describes.
import type { AgentGuide } from "./schema";

/** The diff the fake git prints: four files, so the guide must note each of them. */
export const DIFF = [
  "diff --git a/src/SessionDataAccess.ts b/src/SessionDataAccess.ts",
  "--- a/src/SessionDataAccess.ts",
  "+++ b/src/SessionDataAccess.ts",
  "@@ -10,3 +10,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " const d = 5;",
  "diff --git a/src/CustomerService.ts b/src/CustomerService.ts",
  "--- a/src/CustomerService.ts",
  "+++ b/src/CustomerService.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git a/src/SessionDataAccess.test.ts b/src/SessionDataAccess.test.ts",
  "--- a/src/SessionDataAccess.test.ts",
  "+++ b/src/SessionDataAccess.test.ts",
  "@@ -1 +1,2 @@",
  " test",
  "+more",
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1,2 @@",
  " # api",
  "+notes",
  "",
].join("\n");

export const AGENT_GUIDE: AgentGuide = {
  title: "Record why customer sessions end in canonical auth events",
  risk: {
    level: "high",
    headline: "Partner revokes fail with an enum error if code ships before the migration.",
    detail: "The `partner_revoked` value is written by the new code path.",
    beforeMerge: [{ headline: "Run the partner_revoked enum migration before this code is live." }],
  },
  summary: {
    what: { headline: "Every server-side session end emits session_revoked with a reason." },
    why: { headline: "We can't tell why customers get logged out." },
    impact: {
      headline: "No user-facing change. One warehouse row per ended session.",
      detail: "Roughly 40k rows a day at current volume.",
    },
  },
  findings: [
    {
      id: "f1",
      severity: "major",
      file: "src/SessionDataAccess.ts",
      line: 11,
      headline: "The revoke reason is dropped when the session row is already gone.",
      detail: "UPDATE … RETURNING returns no row, so no event is emitted.",
      suggestedComment: "Could we emit the event even when no row is returned?",
    },
    {
      id: "f2",
      severity: "nit",
      file: "README.md",
      line: null,
      headline: "README does not mention the new event.",
      detail: "",
      suggestedComment: null,
    },
  ],
  areas: [
    {
      id: "runtime",
      label: "Runtime",
      question: "Does it behave correctly?",
      files: ["src/SessionDataAccess.ts", "src/CustomerService.ts"],
    },
    {
      id: "tests",
      label: "Tests",
      question: "Does it prove the change?",
      files: ["src/SessionDataAccess.test.ts"],
    },
  ],
  readingOrder: [
    {
      depth: "deep",
      files: ["src/SessionDataAccess.ts"],
      why: "finding",
      areaId: "runtime",
      headline: "All invalidations use UPDATE … RETURNING.",
      detail: "Three call sites move from read-then-update to a single statement.",
      focus: [{ start: 11, end: 12 }],
      check: "Is an event emitted when no row comes back?",
    },
    {
      depth: "deep",
      files: ["src/CustomerService.ts"],
      why: "core",
      areaId: "runtime",
      headline: "Deletion revokes after commit.",
      focus: [{ start: 1, end: 1 }],
      check: "Does the revoke run only after the commit?",
    },
    {
      depth: "skim",
      files: ["src/SessionDataAccess.test.ts", "README.md"],
      why: "tests",
      areaId: "tests",
      headline: "A test per revoke reason, and a README line.",
      focus: [{ start: 2, end: 2 }],
    },
  ],
  files: [
    { path: "src/SessionDataAccess.ts", note: "UPDATE … RETURNING and the new event." },
    { path: "src/CustomerService.ts", note: "Revokes after the deletion commits." },
    { path: "src/SessionDataAccess.test.ts", note: "Covers each revoke reason." },
    { path: "README.md", note: "One line about sessions." },
  ],
  flows: [
    {
      title: "How a session end is recorded",
      before: [{ label: "Session ends" }, { label: "Read rows" }, { label: "Update rows" }],
      after: [
        { label: "Session ends" },
        { label: "UPDATE … RETURNING", changed: true },
        { label: "Emit session_revoked", changed: true },
      ],
    },
  ],
  claimsCheck: [
    {
      claim: "No user-facing change.",
      verdict: "matches",
      evidence: "Only events and storage change (SessionDataAccess.ts).",
    },
  ],
  sinceLastReview: null,
};

export const PR_VIEW = {
  number: 7,
  title: "Record session end reasons",
  body: "No user-facing change.",
  author: { login: "sam" },
  url: "https://github.com/acme/api/pull/7",
  headRefOid: "abc1234def5678",
  headRefName: "feat/session-reasons",
  baseRefName: "main",
  isDraft: false,
  additions: 120,
  deletions: 30,
  changedFiles: 4,
  createdAt: "2026-11-17T09:00:00Z",
  files: [
    { path: "src/SessionDataAccess.ts", additions: 60, deletions: 20 },
    { path: "src/CustomerService.ts", additions: 20, deletions: 5 },
    { path: "src/SessionDataAccess.test.ts", additions: 38, deletions: 5 },
    { path: "README.md", additions: 2, deletions: 0 },
  ],
};

/** `list[index]`, failing the test when there is nothing there. */
export function nth<T>(list: readonly T[], index = 0): T {
  const value = list[index];
  if (value === undefined) throw new Error(`nothing at index ${index} of ${list.length}`);
  return value;
}
