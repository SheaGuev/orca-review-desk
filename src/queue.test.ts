import { assert, test } from "orca/testing";
import type { QueueItem } from "./protocol";
import { buildQueue, compareQueue, repoLabels } from "./queue";

const item = (over: Partial<QueueItem>): QueueItem => ({
  key: "acme/api#1",
  repo: "acme/api",
  number: 1,
  title: "t",
  author: "sam",
  url: "u",
  lane: "user",
  draft: false,
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  headSha: "h",
  status: "ready",
  risk: "medium",
  riskSummary: null,
  newSinceYourReview: false,
  ownedFiles: null,
  manualReason: null,
  error: null,
  hasClone: true,
  requestedAt: 1_000,
  team: null,
  position: null,
  repoLabel: "",
  tour: null,
  pendingComments: 0,
  ...over,
});

test("orders by new commits, then risk, then who waited longest", () => {
  const items = [
    item({ key: "low-old", risk: "low", requestedAt: 1 }),
    item({ key: "high-new", risk: "high", requestedAt: 900 }),
    item({ key: "none-mid", risk: null, status: "generating", requestedAt: 500 }),
    item({ key: "medium-old", risk: "medium", requestedAt: 100 }),
    item({ key: "pushed-low", risk: "low", newSinceYourReview: true, requestedAt: 999 }),
    item({ key: "high-old", risk: "high", requestedAt: 50 }),
  ];
  const { queue } = buildQueue(items);
  assert.deepEqual(
    queue.map((i) => [i.key, i.position]),
    [
      ["pushed-low", 1],
      ["high-old", 2],
      ["high-new", 3],
      ["medium-old", 4],
      ["none-mid", 5],
      ["low-old", 6],
    ],
  );
  // Full ties fall back to the key, so the order never flickers between checks.
  assert.ok(compareQueue(item({ key: "a" }), item({ key: "b" })) < 0);
});

test("groups into queue, not queued and your PRs", () => {
  const { queue, notQueued, authored } = buildQueue([
    item({ key: "direct" }),
    item({ key: "team", lane: "team", team: "acme/payments" }),
    item({
      key: "off",
      status: "none",
      risk: null,
      manualReason: "Repository not turned on yet",
      requestedAt: 5,
    }),
    item({
      key: "lock",
      lane: "team",
      status: "lockfile",
      risk: null,
      manualReason: "Lockfile only",
      requestedAt: 1,
    }),
    // A manual guide exists, so it is queued even though nothing is automatic for it.
    item({ key: "manual-guide", manualReason: "Draft", status: "stale", risk: "low" }),
    item({ key: "mine", lane: "authored" }),
  ]);
  assert.deepEqual(
    queue.map((i) => i.key),
    ["direct", "team", "manual-guide"],
  );
  assert.deepEqual(
    notQueued.map((i) => [i.key, i.position]),
    [
      ["lock", null],
      ["off", null],
    ],
  );
  assert.deepEqual(
    authored.map((i) => [i.key, i.position]),
    [["mine", null]],
  );
});

test("repo labels drop the owner unless two repos share a name", () => {
  assert.deepEqual(
    [...repoLabels(["acme/api", "other/api", "acme/web"])],
    [
      ["acme/api", "acme/api"],
      ["other/api", "other/api"],
      ["acme/web", "web"],
    ],
  );
  const { queue } = buildQueue([item({ repo: "acme/web" })]);
  assert.equal(queue[0].repoLabel, "web");
});
