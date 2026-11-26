// The PR-branch worktree with real git, in throwaway repositories under the temp folder: a bare
// "origin", a clone of it, and Orca's workspace list played by a plain list.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, assert, test } from "orca/testing";
import { setRunner } from "./exec";
import { hideOwnFolders } from "./git";
import {
  checkedOutAt,
  createPrWorktrees,
  FORK_NOTE,
  freeWorktreePath,
  type ListHost,
} from "./pr-worktree";

const exec = promisify(execFile);
const GIT_ID = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main"];

let root = "";
afterEach(async () => {
  setRunner(null);
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

const git = (cwd: string, ...args: string[]) =>
  exec("git", [...GIT_ID, "-C", cwd, ...args]).then((r) => r.stdout.trim());

/** origin.git with main and the PR's branch `feat/x`, and `api`, a clone of it on main. */
async function repos(): Promise<{ origin: string; clone: string }> {
  root = await realpath(await mkdtemp(join(tmpdir(), "pr-worktree-")));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  await exec("git", [...GIT_ID, "init", "--bare", origin]);
  await exec("git", [...GIT_ID, "init", seed]);
  await writeFile(join(seed, "a.txt"), "a\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "main");
  await git(seed, "checkout", "-b", "feat/x");
  await writeFile(join(seed, "b.txt"), "b\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "pr");
  await git(seed, "push", origin, "main", "feat/x");
  const clone = join(root, "api");
  await exec("git", [...GIT_ID, "clone", "--quiet", origin, clone]);
  return { origin, clone };
}

/** Real git, with the fetch from GitHub pointed at the local origin. */
function realGit(origin: string): void {
  setRunner(async (cmd, args) => {
    const real = args.map((a) => (a === "https://github.com/acme/api.git" ? origin : a));
    try {
      const { stdout, stderr } = await exec(cmd, [...GIT_ID, ...real]);
      return { stdout, stderr, code: 0 };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      const code = "code" in err && typeof err.code === "number" ? err.code : 1;
      const stderr = "stderr" in err && typeof err.stderr === "string" ? err.stderr : err.message;
      return { stdout: "", stderr, code };
    }
  });
}

type Row = Awaited<ReturnType<ListHost["call"]>>["workspaces"][number];

/** Orca's list: the clone, plus `rows`; a test pushes onto `listed` once "Orca" has seen a worktree. */
function orcaList(clone: string, rows: Row[] = []) {
  const listed: Row[] = [
    { id: "w1", projectId: "p1", path: clone, branch: "main", hostId: "local" },
    ...rows,
  ];
  const host: ListHost = { call: async () => ({ workspaces: listed }) };
  return { host, listed };
}

const head =
  (fromFork = false) =>
  async () => ({ branch: "feat/x", fromFork });
const clonesOf = (clone: string) => ({
  refresh: async () => new Map(),
  find: async () => ({ path: clone, projectId: "p1" }),
});

test("a worktree on the PR's branch is reused, not made again", async () => {
  const { clone } = await repos();
  const { host } = orcaList(clone, [
    { id: "w2", projectId: "p1", path: "/x", branch: "feat/x", hostId: "local" },
  ]);
  const wt = createPrWorktrees({ host, clones: clonesOf(clone), head: head() });
  assert.deepEqual(await wt.plan("acme/api", 7), {
    kind: "found",
    workspace: { id: "w2", path: "/x" },
  });
});

test("with no local branch, the worktree tracks origin's and Orca's listing is waited for", async () => {
  const { origin, clone } = await repos();
  realGit(origin);
  const { host, listed } = orcaList(clone);
  const wt = createPrWorktrees({ host, clones: clonesOf(clone), head: head(), pollMs: 10 });
  assert.deepEqual(await wt.plan("acme/api", 7), { kind: "missing", branch: "feat/x" });
  const path = join(root, "api.worktrees", "feat-x");
  setTimeout(
    () => listed.push({ id: "w2", projectId: "p1", path, branch: "feat/x", hostId: "local" }),
    30,
  );
  const made = await wt.create("acme/api", 7);
  assert.deepEqual(made.workspace, { id: "w2", path });
  assert.ok(made.notes[0]?.includes("setup script didn't run"), made.notes.join(" "));
  assert.equal(await git(path, "rev-parse", "--abbrev-ref", "HEAD"), "feat/x");
  assert.equal(await git(path, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/feat/x");
  assert.equal(await checkedOutAt(clone, "feat/x"), path);
  // A guide written in the new worktree stays out of git status: the exclude list is shared.
  await hideOwnFolders(path);
  await mkdir(join(path, ".orca/pr-review"), { recursive: true });
  await writeFile(join(path, ".orca/pr-review/pr-7.prreview.json"), "{}");
  assert.equal(await git(path, "status", "--porcelain"), "");
  assert.ok(
    (await readFile(join(clone, ".git/info/exclude"), "utf8")).includes(".orca/pr-review/"),
  );
});

test("a local branch is checked out as it is, and one that differs from the PR says so", async () => {
  const { origin, clone } = await repos();
  realGit(origin);
  await git(clone, "branch", "feat/x", "main");
  const before = await git(clone, "rev-parse", "feat/x");
  const { host, listed } = orcaList(clone);
  const path = join(root, "api.worktrees", "feat-x");
  listed.push({ id: "w2", projectId: "p1", path, branch: "feat/x", hostId: "local" });
  const wt = createPrWorktrees({ host, clones: clonesOf(clone), head: head(), pollMs: 10 });
  const made = await wt.create("acme/api", 7);
  assert.ok(made.notes[0]?.includes("differs from the PR's latest commit"), made.notes.join(" "));
  assert.equal(await git(path, "rev-parse", "HEAD"), before, "never reset to origin's");
});

test("a taken folder gets -2, and a worktree Orca never lists falls back with a note", async () => {
  const { origin, clone } = await repos();
  realGit(origin);
  await mkdir(join(root, "api.worktrees", "feat-x"), { recursive: true });
  assert.equal(await freeWorktreePath(clone, "feat/x"), join(root, "api.worktrees", "feat-x-2"));
  const { host } = orcaList(clone);
  const wt = createPrWorktrees({
    host,
    clones: clonesOf(clone),
    head: head(),
    waitMs: 30,
    pollMs: 10,
  });
  const made = await wt.create("acme/api", 7);
  assert.equal(made.workspace, null);
  assert.ok(made.notes.at(-1)?.includes("didn't list it"), made.notes.join(" "));
  assert.equal(await checkedOutAt(clone, "feat/x"), join(root, "api.worktrees", "feat-x-2"));
});

test("a fork's PR makes no worktree", async () => {
  const { clone } = await repos();
  const { host } = orcaList(clone);
  const wt = createPrWorktrees({ host, clones: clonesOf(clone), head: head(true) });
  assert.deepEqual(await wt.plan("acme/api", 7), { kind: "fork" });
  assert.deepEqual(await wt.create("acme/api", 7), { workspace: null, notes: [FORK_NOTE] });
});

test("a branch name git would read as an option is refused before anything runs", async () => {
  const { origin, clone } = await repos();
  realGit(origin);
  const { host } = orcaList(clone);
  const wt = createPrWorktrees({
    host,
    clones: clonesOf(clone),
    head: async () => ({ branch: "--upload-pack=x", fromFork: false }),
  });
  await assert.rejects(() => wt.create("acme/api", 7), /isn't a branch name/);
});
