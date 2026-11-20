// `orca plugin check` and `orca plugin shot --scenario` render the panel in each of these states,
// with the worker stood in by `requests`, so no GitHub or agent call happens.
import { defineCheck } from "orca/testing";
import type { QueueItem, QueueState } from "./protocol";
import { buildQueue } from "./queue";

const now = Date.now();
const hours = (n: number) => now - n * 60 * 60_000;

const base: QueueState = {
  queue: [],
  notQueued: [],
  authored: [],
  repos: [],
  checking: false,
  checkedAt: now - 60_000,
  notice: null,
  agentLabel: "Claude Code · claude-opus-5-5",
  includeAuthored: false,
  openKey: null,
};

const item = (over: Partial<QueueItem>): QueueItem => ({
  key: "acme/api#43841",
  repo: "acme/api",
  number: 43841,
  title: "Record why customer sessions end in canonical auth events",
  author: "sam",
  url: "https://github.com/acme/api/pull/43841",
  lane: "user",
  draft: false,
  additions: 1241,
  deletions: 374,
  changedFiles: 35,
  headSha: "abc",
  status: "ready",
  risk: "high",
  riskSummary: "Partner revokes fail with an enum error if code ships before the migration.",
  newSinceYourReview: true,
  ownedFiles: null,
  manualReason: null,
  error: null,
  hasClone: true,
  requestedAt: hours(2),
  team: null,
  position: null,
  repoLabel: "api",
  tour: null,
  pendingComments: 0,
  ...over,
});

const ITEMS: QueueItem[] = [
  item({}),
  item({
    key: "acme/api#43183",
    number: 43183,
    lane: "team",
    team: "acme/identity",
    title: "Move the social redirect allowlist into a config-backed registry",
    risk: "medium",
    newSinceYourReview: false,
    requestedAt: hours(26),
    tour: "18 of 23 files",
    pendingComments: 2,
  }),
  item({
    key: "acme/api#43910",
    number: 43910,
    title: "Add retries to the KYC webhook consumer",
    status: "generating",
    risk: null,
    newSinceYourReview: false,
    requestedAt: hours(0.1),
  }),
  item({
    key: "acme/api#43911",
    number: 43911,
    title: "Drop the legacy session cookie",
    status: "queued",
    risk: null,
    newSinceYourReview: false,
    requestedAt: hours(0.05),
  }),
  item({
    key: "acme/web#812",
    repo: "acme/web",
    repoLabel: "web",
    number: 812,
    title: "Rename the checkout feature flag",
    status: "stale",
    risk: "low",
    newSinceYourReview: false,
    requestedAt: hours(50),
  }),
  item({
    key: "acme/web#815",
    repo: "acme/web",
    number: 815,
    title: "Paginate the orders export",
    status: "failed",
    risk: null,
    newSinceYourReview: false,
    error: "claude exited with 1: API Error: 429 rate limited, retry after 60 s",
    requestedAt: hours(5),
  }),
  item({
    key: "acme/api#43890",
    number: 43890,
    lane: "team",
    team: "acme/payments",
    title: "Round EUR payouts in the ledger, not the client",
    status: "none",
    risk: null,
    newSinceYourReview: false,
    ownedFiles: 0,
    manualReason: "No files your teams own",
    requestedAt: hours(3),
  }),
  item({
    key: "acme/api#43902",
    number: 43902,
    lane: "team",
    team: "acme/payments",
    title: "Bump date-fns to 4.1.0",
    status: "lockfile",
    risk: null,
    newSinceYourReview: false,
    manualReason: "Lockfile only",
    requestedAt: hours(8),
  }),
  item({
    key: "globex/infra#77",
    repo: "globex/infra",
    number: 77,
    title: "Move CI runners to arm64",
    status: "none",
    risk: null,
    newSinceYourReview: false,
    hasClone: false,
    manualReason: "No local clone in Orca",
    requestedAt: hours(30),
  }),
  item({
    key: "acme/api#43950",
    number: 43950,
    lane: "authored",
    title: "Your own change to the session store",
    risk: "low",
    tour: "Reviewed tour",
    newSinceYourReview: false,
    requestedAt: hours(72),
  }),
];

const queue: QueueState = {
  ...base,
  includeAuthored: true,
  repos: [{ repo: "acme/api", optIn: true, hasClone: true, pending: 4 }],
  // The team row's guide is open in the editor: its row reads as current.
  openKey: "acme/api#43183",
  ...buildQueue(ITEMS),
};

/** Nothing waiting for you, but your own PRs are listed: one muted line, not the big empty state. */
const onlyYourPrs: QueueState = {
  ...base,
  includeAuthored: true,
  ...buildQueue([
    item({
      key: "acme/api#43950",
      number: 43950,
      lane: "authored",
      title: "Your own change to the session store",
      risk: "low",
      newSinceYourReview: false,
      requestedAt: hours(229 * 24),
      pendingComments: 1,
    }),
    item({
      key: "acme/web#901",
      repo: "acme/web",
      number: 901,
      lane: "authored",
      title: "Split the checkout page into steps",
      status: "failed",
      risk: null,
      newSinceYourReview: false,
      error: "The agent's guide did not match prguide v2: title: over 12 words",
    }),
  ]),
};

const optIn: QueueState = {
  ...base,
  repos: [{ repo: "acme/api", optIn: null, hasClone: true, pending: 1 }],
  ...buildQueue([
    item({
      status: "none",
      risk: null,
      newSinceYourReview: false,
      manualReason: "Repository not turned on yet",
    }),
  ]),
};

const withNotice = (text: string, tone: "warning" | "danger"): QueueState => ({
  ...queue,
  notice: { tone, text },
});

const answer = (state: QueueState) => ({ "queue.get": state, "queue.refresh": state });

export default defineCheck({
  empty: { requests: answer(base) },
  optIn: { requests: answer(optIn) },
  queue: { requests: answer(queue) },
  queueDark: { requests: answer(queue), theme: "dark" },
  onlyYourPrs: { requests: answer(onlyYourPrs) },
  offline: {
    requests: answer(withNotice("Couldn't reach GitHub · last checked 14:02", "warning")),
  },
  limit: {
    requests: answer(
      withNotice("Automatic guides paused until tomorrow · Generate still works", "warning"),
    ),
  },
  signedOut: {
    requests: answer(
      withNotice("Claude Code is not signed in · sign in from a terminal, then Generate", "danger"),
    ),
  },
});
