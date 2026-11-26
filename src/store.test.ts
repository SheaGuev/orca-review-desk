import { assert, test } from "orca/testing";
import { createStore, localDay } from "./store";

/** A stand-in for Orca's storage: plain JSON by key. */
function fakeStorage(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  const storage: Parameters<typeof createStore>[0] = {
    get: (key) => Promise.resolve((data.get(key) ?? null) as never),
    set: (key, value) => {
      data.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      data.delete(key);
      return Promise.resolve();
    },
    keys: () => Promise.resolve([...data.keys()]),
    onDidChange: () => ({ dispose: () => undefined }),
  };
  return { storage, data };
}

test("a stored value that is not a guide reads as no guide", async () => {
  const { storage } = fakeStorage({
    "guide:acme/api#1": { schema: "prguide/v2", title: 3 },
    "guide:acme/api#2": "not even an object",
  });
  const store = createStore(storage);
  assert.equal(await store.guide("acme/api#1"), null);
  assert.equal(await store.guide("acme/api#2"), null);
  assert.equal(await store.guide("acme/api#3"), null);
});

test("meta keeps only the fields it knows, and undefined ones never reach storage", async () => {
  const { storage, data } = fakeStorage({
    "meta:k": { lastViewedCommit: "abc1234", error: 5, extra: true },
  });
  const store = createStore(storage);
  assert.deepEqual(await store.meta("k"), { lastViewedCommit: "abc1234" });
  assert.deepEqual(await store.meta("none"), {});
  await store.setMeta("k", { lastViewedCommit: undefined, error: "boom" });
  assert.deepEqual(data.get("meta:k"), { error: "boom" });
});

test("automatic runs are counted per local day", async () => {
  const { storage, data } = fakeStorage({ runs: { day: "2001-01-01", count: 9 } });
  const store = createStore(storage);
  assert.equal(await store.runsToday(), 0, "yesterday's count is not today's");
  assert.equal(await store.countRun(), 1);
  assert.equal(await store.countRun(), 2);
  assert.deepEqual(data.get("runs"), { day: localDay(), count: 2 });
});

test("opt-in is null until answered", async () => {
  const { storage } = fakeStorage({ "optin:acme/web": "yes" });
  const store = createStore(storage);
  assert.equal(await store.optIn("acme/api"), null);
  assert.equal(await store.optIn("acme/web"), null, "a value of the wrong type is no answer");
  await store.setOptIn("acme/api", false);
  assert.equal(await store.optIn("acme/api"), false);
});

test("a saved list in any other shape reads as none", async () => {
  const pr = {
    key: "acme/api#7",
    repo: "acme/api",
    number: 7,
    title: "t",
    author: "sam",
    url: "https://github.com/acme/api/pull/7",
    lane: "user",
    draft: false,
    additions: 1,
    deletions: 2,
    changedFiles: 3,
    headSha: "abc",
    hasClone: true,
    requestedAt: 5,
    team: null,
    ownedFiles: null,
    manualReason: null,
    branch: "feature",
  };
  const read = async (value: unknown) =>
    createStore(fakeStorage({ lastCheck: value }).storage).lastCheck();
  assert.deepEqual(await read({ checkedAt: 9, prs: [{ ...pr, extra: 1 }] }), {
    checkedAt: 9,
    prs: [{ ...pr, lastReview: null }],
  });
  const recent = { ...pr, lane: "recent", lastReview: { at: 4, newCommits: true } };
  assert.deepEqual(await read({ checkedAt: 9, prs: [recent] }), { checkedAt: 9, prs: [recent] });
  assert.equal(await read(null), null);
  assert.equal(await read({ checkedAt: "9", prs: [pr] }), null);
  assert.equal(await read({ checkedAt: 9, prs: [{ ...pr, lane: "other" }] }), null);
  assert.equal(await read({ checkedAt: 9, prs: [{ ...pr, branch: undefined }] }), null);
  assert.equal(await read({ checkedAt: 9, items: [] }), null);
});

test("prune keeps the saved list", async () => {
  const { storage, data } = fakeStorage({ lastCheck: { checkedAt: 1, prs: [] } });
  await createStore(storage).prune(() => false, Date.now());
  assert.ok(data.has("lastCheck"));
});
