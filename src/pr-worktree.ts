// A PR's own branch checked out in a worktree beside its clone, so a review can run and test the
// code on the branch the PR is on, and Orca shows that PR's checks and comments for it. Orca's
// plugin API only creates new branches, so git does the checkout here. Nothing that exists is
// reset, forced or moved: a local branch is checked out as it is.
import { access } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Clones } from "./clones";
import { fail, message } from "./errors";
import { run, runOk } from "./exec";
import type { Clone } from "./git";
import type { PrHead } from "./github";

export type Workspace = { id: string; path: string };

export type WorktreePlan =
  | { kind: "found"; workspace: Workspace }
  | { kind: "missing"; branch: string }
  /** The branch is in another repository, so there is none here to check out. */
  | { kind: "fork" }
  /** The PR's branch couldn't be read; `reason` says why. */
  | { kind: "unknown"; reason: string };

export type CreatedWorktree = { workspace: Workspace | null; notes: string[] };

export type PrWorktrees = {
  plan(repo: string, number: number): Promise<WorktreePlan>;
  create(repo: string, number: number): Promise<CreatedWorktree>;
};

/** The one host call this needs, so a test can stand in for Orca with a list. */
export type ListHost = {
  call: (method: "workspace.list") => Promise<{
    workspaces: readonly {
      id: string;
      projectId?: string | null;
      path: string;
      branch: string | null;
      hostId: string | null;
    }[];
  }>;
};

type Deps = {
  host: ListHost;
  clones: Clones;
  head: (repo: string, number: number) => Promise<PrHead>;
  /** How long to wait for Orca to list a new worktree, and how often to look. */
  waitMs?: number;
  pollMs?: number;
};

export const FORK_NOTE =
  "Opened without a worktree: this PR's branch is in a fork, so there's no branch here to check out.";

export const setupNote = (path: string): string =>
  `Orca's setup script didn't run in ${path}. Run your project's setup there once (for example pnpm install).`;

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/** The workspace Orca lists for `clone`'s project on `branch`, on this machine. */
async function branchWorkspace(
  host: ListHost,
  clone: Clone,
  branch: string,
): Promise<Workspace | null> {
  const { workspaces } = await host.call("workspace.list");
  const hit = workspaces.find(
    (w) =>
      w.projectId === clone.projectId && (!w.hostId || w.hostId === "local") && w.branch === branch,
  );
  return hit ? { id: hit.id, path: hit.path } : null;
}

/** `<clone>.worktrees/<branch>` beside the clone, with `-2`, `-3`... when that folder is taken. */
export async function freeWorktreePath(clonePath: string, branch: string): Promise<string> {
  const base = join(
    dirname(clonePath),
    `${basename(clonePath)}.worktrees`,
    branch.replaceAll("/", "-"),
  );
  if (!(await exists(base))) return base;
  for (let n = 2; n < 100; n++) if (!(await exists(`${base}-${n}`))) return `${base}-${n}`;
  throw fail("conflict", `Every folder name for ${branch} beside the clone is taken`);
}

async function commitOf(cwd: string, ref: string): Promise<string | null> {
  const out = await run("git", ["-C", cwd, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    timeoutMs: 10_000,
  });
  return out.code === 0 ? out.stdout.trim() : null;
}

/** Where `branch` is checked out among the clone's worktrees, or null when nowhere. */
export async function checkedOutAt(cwd: string, branch: string): Promise<string | null> {
  const out = await runOk("git", ["-C", cwd, "worktree", "list", "--porcelain"], {
    timeoutMs: 10_000,
  });
  let path: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return null;
}

/** Refuses a name git would read as an option or that isn't a branch name at all. */
async function checkBranchName(cwd: string, branch: string): Promise<void> {
  const ok =
    !branch.startsWith("-") &&
    (await run("git", ["-C", cwd, "check-ref-format", "--branch", branch], { timeoutMs: 10_000 }))
      .code === 0;
  if (!ok) throw fail("invalid", `"${branch}" isn't a branch name git accepts`);
}

/**
 * The PR's branch into `origin/<branch>`, over HTTPS with gh's credentials as `fetchPr` does, so
 * an ssh key that asks for approval on each use doesn't fail in the background.
 */
async function fetchBranch(clone: Clone, repo: string, branch: string): Promise<void> {
  await runOk(
    "git",
    [
      "-c",
      "credential.helper=",
      "-c",
      "credential.helper=!gh auth git-credential",
      "-C",
      clone.path,
      "fetch",
      "--no-tags",
      "--quiet",
      `https://github.com/${repo}.git`,
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ],
    { timeoutMs: 180_000 },
  );
}

/** Checks `branch` out at `path`: the local branch as it is, else a new one tracking origin's. */
async function addWorktree(clone: Clone, path: string, branch: string): Promise<string[]> {
  const local = await commitOf(clone.path, `refs/heads/${branch}`);
  const git = (args: string[]) =>
    runOk("git", ["-C", clone.path, "worktree", "add", ...args], { timeoutMs: 120_000 });
  if (!local) {
    await git(["--track", "-b", branch, path, `origin/${branch}`]);
    return [];
  }
  await git([path, branch]);
  const remote = await commitOf(clone.path, `refs/remotes/origin/${branch}`);
  return remote === local
    ? []
    : [`Your local ${branch} differs from the PR's latest commit; it was checked out as it is.`];
}

/** Waits for Orca to list a worktree git made on `branch`, which it does once it notices it. */
async function listed(
  deps: Deps,
  clone: Clone,
  branch: string,
  waitMs: number,
): Promise<Workspace | null> {
  const pollMs = deps.pollMs ?? 500;
  for (let waited = 0; ; waited += pollMs) {
    const ws = await branchWorkspace(deps.host, clone, branch);
    if (ws || waited >= waitMs) return ws;
    await new Promise((done) => setTimeout(done, pollMs));
  }
}

/** Checks the PR's branch out beside `clone`, or finds where it already is. */
async function createWorktree(
  deps: Deps,
  clone: Clone,
  repo: string,
  number: number,
): Promise<CreatedWorktree> {
  const waitMs = deps.waitMs ?? 10_000;
  const { branch, fromFork } = await deps.head(repo, number);
  if (fromFork) return { workspace: null, notes: [FORK_NOTE] };
  await checkBranchName(clone.path, branch);
  const at = await checkedOutAt(clone.path, branch);
  if (at) {
    const workspace = await listed(deps, clone, branch, waitMs);
    const hidden = `${branch} is already checked out at ${at}, which Orca doesn't show.`;
    return { workspace, notes: workspace ? [] : [hidden] };
  }
  await fetchBranch(clone, repo, branch);
  const path = await freeWorktreePath(clone.path, branch);
  const notes = await addWorktree(clone, path, branch);
  const workspace = await listed(deps, clone, branch, waitMs);
  notes.push(
    workspace
      ? setupNote(path)
      : `Made ${path}, but Orca didn't list it within ${waitMs / 1000} s, so the guide opened in ${basename(clone.path)}. Check that this project shows worktrees made outside Orca.`,
  );
  return { workspace, notes };
}

export function createPrWorktrees(deps: Deps): PrWorktrees {
  const cloneOf = async (repo: string): Promise<Clone> => {
    const clone = await deps.clones.find(repo);
    if (!clone) throw fail("unavailable", `No local clone of ${repo} in Orca`);
    return clone;
  };
  return {
    async plan(repo, number) {
      const clone = await cloneOf(repo);
      const head = await deps.head(repo, number).catch((e: unknown) => message(e));
      if (typeof head === "string") return { kind: "unknown", reason: head };
      if (head.fromFork) return { kind: "fork" };
      const workspace = await branchWorkspace(deps.host, clone, head.branch);
      return workspace ? { kind: "found", workspace } : { kind: "missing", branch: head.branch };
    },
    create: async (repo, number) => createWorktree(deps, await cloneOf(repo), repo, number),
  };
}
