import { assert, test } from "orca/testing";
import { prDetailsFrom } from "./github";
import { manualReason, statusOf } from "./queue-items";
import { parsePrKey, prKey } from "./repo";
import { readSettings } from "./settings";
import { neighbourView } from "./tour";

const details = prDetailsFrom(
  {
    number: 7,
    headRefOid: "abc1234",
    headRefName: "f",
    baseRefName: "main",
    additions: 40,
    deletions: 2,
  },
  "acme/api 7",
);
const settings = readSettings({});

test("why a PR gets no automatic guide", () => {
  const repo = { optIn: true, hasClone: true };
  assert.equal(
    manualReason({ lane: "user", details, owned: null, association: "MEMBER" }, repo, settings),
    null,
  );
  assert.equal(
    manualReason(
      { lane: "user", details, owned: null, association: "MEMBER" },
      { ...repo, hasClone: false },
      settings,
    ),
    "No local clone in Orca",
  );
  assert.equal(
    manualReason(
      { lane: "user", details, owned: null, association: "MEMBER" },
      { ...repo, optIn: null },
      settings,
    ),
    "Repository not turned on yet",
  );
  assert.equal(
    manualReason({ lane: "team", details, owned: 3, association: "MEMBER" }, repo, settings),
    "Under 200 lines",
  );
  assert.equal(
    manualReason({ lane: "team", details, owned: 0, association: "MEMBER" }, repo, {
      ...settings,
      teamMinLines: 0,
    }),
    "No files your teams own",
  );
  assert.equal(
    manualReason(
      { lane: "user", details: { ...details, isDraft: true }, owned: null, association: "MEMBER" },
      repo,
      settings,
    ),
    "Draft",
  );
});

test("only PRs by the repository's owners, members and collaborators get automatic guides", () => {
  const repo = { optIn: true, hasClone: true };
  const reason = (lane: "user" | "authored", association: string | null) =>
    manualReason({ lane, details, owned: null, association }, repo, settings);
  for (const trusted of ["OWNER", "MEMBER", "COLLABORATOR"])
    assert.equal(reason("user", trusted), null, trusted);
  for (const outside of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE"])
    assert.equal(reason("user", outside), "Author is not a collaborator", outside);
  assert.equal(reason("user", null), "Couldn't check the author's access", "fails safe");
  assert.equal(reason("authored", null), null, "your own PRs count as trusted");
});

test("a run under way decides a PR's status before its guide does", () => {
  const base = { guide: null, meta: {}, head: "abc1234", lockfileOnly: false };
  assert.equal(statusOf({ ...base, run: "generating" }), "generating");
  assert.equal(statusOf({ ...base, run: "queued" }), "queued");
  assert.equal(statusOf({ ...base, run: null }), "none");
  assert.equal(statusOf({ ...base, run: null, lockfileOnly: true }), "lockfile");
  assert.equal(
    statusOf({ ...base, run: null, meta: { error: "x", errorCommit: "abc1234" } }),
    "failed",
  );
  assert.equal(
    statusOf({ ...base, run: null, meta: { error: "x", errorCommit: "old0000" } }),
    "none",
    "a failure on an older head is not this head's",
  );
});

test("gh pr view output without a number, head or base is refused", () => {
  assert.throws(() => prDetailsFrom({ number: 7 }, "acme/api 7"));
  assert.throws(() => prDetailsFrom("nope", "acme/api 7"));
  assert.deepEqual(details.files, []);
  assert.equal(details.author, "");
});

test("a PR key names its repo and number", () => {
  assert.equal(prKey("acme/api", 7), "acme/api#7");
  assert.deepEqual(parsePrKey("acme/api#7"), { repo: "acme/api", number: 7 });
  assert.equal(parsePrKey("acme/api"), null);
  assert.equal(parsePrKey("acme/api#x"), null);
});

test("stepping through the tour: overview, each stop, wrap-up", () => {
  assert.equal(neighbourView("overview", 2, true), "stop:0");
  assert.equal(neighbourView("overview", 2, false), null);
  assert.equal(neighbourView("stop:0", 2, true), "stop:1");
  assert.equal(neighbourView("stop:0", 2, false), "overview");
  assert.equal(neighbourView("stop:1", 2, true), "wrapup");
  assert.equal(neighbourView("wrapup", 2, false), "stop:1");
  assert.equal(neighbourView("wrapup", 2, true), null);
  assert.equal(neighbourView("overview", 0, true), "wrapup", "a tour with no stops");
  assert.equal(neighbourView("wrapup", 0, false), "overview");
});
