// Guides PR Tour wrote are taken into Review Desk's storage the first time a PR without its own
// guide is opened, and the files PR Tour wrote are never changed.
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, test } from "orca/testing";
import { splitDiff } from "./diff";
import { AGENT_GUIDE, DIFF, PR_VIEW } from "./fixtures";
import { importPrTourGuide } from "./pr-tour-import";
import { createStore } from "./store";

const files = splitDiff(DIFF, { keepLockfiles: true });
const guide = (number: number) => ({
  schema: "prguide/v2",
  ...AGENT_GUIDE,
  pr: {
    repo: "acme/api",
    number,
    url: PR_VIEW.url,
    author: "sam",
    commit: PR_VIEW.headRefOid,
    baseRef: "main",
    headRef: PR_VIEW.headRefName,
    additions: 120,
    deletions: 30,
    fileCount: 4,
    requestedAt: null,
    hasDescription: true,
  },
  generatedBy: { harness: "claude", model: null, at: "2026-11-19T10:00:00Z" },
  reviewRequest: "user",
  areas: AGENT_GUIDE.areas.map((a) => ({ ...a, additions: 1, deletions: 0 })),
  sinceLastReview: null,
  coverage: null,
  commentable: Object.fromEntries(files.map((f) => [f.path, [[1, 40]]])),
  skipped: [],
});

type Stored = Parameters<Parameters<typeof createStore>[0]["set"]>[1];

function memoryStore() {
  const data = new Map<string, Stored>();
  const store = createStore({
    get: (key) => Promise.resolve(structuredClone(data.get(key) ?? null)),
    set: (key, value) => Promise.resolve(void data.set(key, value)),
    delete: (key) => Promise.resolve(void data.delete(key)),
    keys: () => Promise.resolve([...data.keys()]),
    onDidChange: () => ({ dispose: () => undefined }),
  });
  return { store, data };
}

async function cloneWith(contents: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "pr-tour-import-"));
  for (const [rel, text] of Object.entries(contents)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return { dir, clones: { find: async () => ({ path: dir, projectId: "p1" }) } };
}

test("a guide PR Tour wrote under .orca/ is stored as Review Desk's, the file left as it was", async () => {
  const text = JSON.stringify(guide(7));
  const { dir, clones } = await cloneWith({ ".orca/pr-tour/pr-7.prtour.json": text });
  try {
    const { store, data } = memoryStore();
    const got = await importPrTourGuide(store, clones, "acme/api#7");
    assert.equal(got?.pr.number, 7);
    assert.ok(data.has("guide:acme/api#7"));
    assert.equal(await readFile(join(dir, ".orca/pr-tour/pr-7.prtour.json"), "utf8"), text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the older .pr-tour/ layout is read too; another PR's guide or a broken file is not", async () => {
  const { dir, clones } = await cloneWith({
    ".pr-tour/7.prtour.json": JSON.stringify(guide(7)),
    ".pr-tour/pr-8.prtour.json": JSON.stringify(guide(9)),
    ".orca/pr-tour/pr-10.prtour.json": "{ not json",
  });
  try {
    const { store } = memoryStore();
    assert.equal((await importPrTourGuide(store, clones, "acme/api#7"))?.pr.number, 7);
    assert.equal(await importPrTourGuide(store, clones, "acme/api#8"), null, "names another PR");
    assert.equal(await importPrTourGuide(store, clones, "acme/api#10"), null);
    assert.equal(await importPrTourGuide(store, clones, "not a key"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a guide folder that is a link is not read", async () => {
  const elsewhere = await mkdtemp(join(tmpdir(), "pr-tour-elsewhere-"));
  await writeFile(join(elsewhere, "pr-7.prtour.json"), JSON.stringify(guide(7)));
  const { dir, clones } = await cloneWith({});
  try {
    await symlink(elsewhere, join(dir, ".pr-tour"));
    const { store } = memoryStore();
    assert.equal(await importPrTourGuide(store, clones, "acme/api#7"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});
