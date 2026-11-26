// Opening a guide from the panel when no worktree is on the PR's branch: the panel asks, and the
// answer goes back to the worker with the open.
import { assert, mockHost, mount, test } from "orca/testing";
import * as panel from "./panel";
import type { QueueItem, QueueState } from "./protocol";
import { buildQueue } from "./queue";

const ITEM: QueueItem = {
  key: "acme/api#7",
  repo: "acme/api",
  number: 7,
  title: "Record why sessions end",
  author: "sam",
  url: "https://github.com/acme/api/pull/7",
  lane: "user",
  draft: false,
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  headSha: "abc",
  status: "ready",
  risk: "low",
  riskSummary: "Small.",
  newSinceYourReview: false,
  ownedFiles: null,
  manualReason: null,
  error: null,
  hasClone: true,
  requestedAt: Date.now(),
  team: null,
  position: null,
  repoLabel: "api",
  tour: null,
  pendingComments: 0,
  lastReview: null,
};

const STATE: QueueState = {
  recentDays: 14,
  repos: [],
  checking: false,
  checkedAt: Date.now(),
  notice: null,
  agentLabel: "Claude Code",
  includeAuthored: false,
  openKey: null,
  ...buildQueue([ITEM]),
};

test("the panel asks about a worktree, then opens with the answer and shows what happened", async () => {
  const asked: unknown[] = [];
  const host = mockHost({
    requests: {
      "queue.get": STATE,
      "guide.open": (input) => {
        asked.push(input);
        return input.worktree
          ? { opened: true, notes: ["Orca's setup script didn't run in /x."] }
          : { opened: false, ask: { branch: "feat/x" } };
      },
    },
  });
  const view = await mount(panel, { host });
  const asks = () => view.summary().some((line) => line.includes("No worktree on feat/x"));
  await view.press({ text: "Review →" });
  assert.ok(asks(), view.summary().join("\n"));
  await view.press({ text: "Create worktree" });
  assert.deepEqual(asked, [{ key: ITEM.key }, { key: ITEM.key, worktree: "create" }]);
  assert.ok(!asks(), "the question is gone");
  assert.ok(view.find({ text: "Orca's setup script didn't run in /x." }));
  assert.deepEqual(view.errors, []);
});

test("tabs split the reviews you owe, the ones to re-review and your own; each PR is a card", async () => {
  const recent: QueueItem = {
    ...ITEM,
    key: "acme/api#8",
    number: 8,
    title: "Tidy retries",
    lane: "recent",
    status: "none",
    risk: null,
    lastReview: { at: Date.now() - 60_000, newCommits: true },
  };
  const state: QueueState = { ...STATE, ...buildQueue([ITEM, recent]) };
  const host = mockHost({ requests: { "queue.get": state } });
  const view = await mount(panel, { host });
  const summary = () => view.summary().join("\n");
  assert.ok(view.find({ text: "Record why sessions end" }), summary());
  assert.ok(view.find({ text: "Review →" }), "a card with a guide offers Review");
  assert.ok(view.find({ text: "Low risk" }), summary());

  await view.select({ type: "Tabs" }, "rereview");
  assert.ok(view.find({ text: "Tidy retries" }), summary());
  assert.ok(view.find({ text: "Generate guide" }), "a card with no guide offers Generate guide");
  assert.ok(view.find({ text: "New commits since your review" }));

  await view.select({ type: "Tabs" }, "mine");
  assert.ok(view.find({ text: "Your own PRs are hidden" }), summary());
  assert.ok(view.find({ text: "Show my own PRs" }));
  assert.deepEqual(view.errors, []);
});
