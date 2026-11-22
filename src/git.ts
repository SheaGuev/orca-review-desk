// What the worker asks git about a local clone. Every call names its folder, so nothing here
// depends on the worker's state; the working tree is never touched.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { linesByFile, splitDiff, type FileDiff } from "./diff";
import { run, runOk } from "./exec";
import { LOCKFILES, repoSlugFromRemote } from "./repo";
import { RUNS } from "./run-files";
import type { DiffContext } from "./schema";

/** A repository added to Orca as a project, on this machine. */
export type Clone = { path: string; projectId: string };

export type PrRefs = { head: string; base: string };

/** Lockfiles left out of a diff by pathspec, whatever folder they are in and however they are cased. */
export const LOCKFILE_EXCLUDES: readonly string[] = [...LOCKFILES].map(
  (name) => `:(exclude,icase,glob)**/${name}`,
);

/** The refs a PR is fetched into: outside `refs/heads`, so no branch of the clone moves. */
export const prRefs = (number: number): PrRefs => ({
  head: `refs/pr-tour/pr-${number}`,
  base: `refs/pr-tour/base-${number}`,
});

/** `owner/repo` (lowercase) of the folder's `origin`, or null when it has none on GitHub. */
export async function originSlug(path: string): Promise<string | null> {
  const remote = await run("git", ["-C", path, "remote", "get-url", "origin"], {
    timeoutMs: 10_000,
  }).catch(() => null);
  return remote?.code === 0 ? repoSlugFromRemote(remote.stdout) : null;
}

export async function fetchPr(
  clone: Clone,
  pr: { number: number; baseRefName: string },
): Promise<PrRefs> {
  const refs = prRefs(pr.number);
  await runOk(
    "git",
    [
      "-C",
      clone.path,
      "fetch",
      "--no-tags",
      "--quiet",
      "origin",
      `+refs/pull/${pr.number}/head:${refs.head}`,
      `+refs/heads/${pr.baseRefName}:${refs.base}`,
    ],
    { timeoutMs: 180_000 },
  );
  return refs;
}

export async function hasCommit(cwd: string, rev: string): Promise<boolean> {
  const out = await run("git", ["-C", cwd, "cat-file", "-e", `${rev}^{commit}`], {
    timeoutMs: 10_000,
  });
  return out.code === 0;
}

/** `git diff <args>`, cut to `limit` characters. */
export async function diffUpTo(
  cwd: string,
  args: readonly string[],
  limit: number,
): Promise<string> {
  const out = await runOk("git", ["-C", cwd, "diff", "--no-color", "--no-ext-diff", ...args], {
    timeoutMs: 60_000,
  });
  return out.slice(0, limit);
}

export type PrFiles = {
  files: FileDiff[];
  /** Lines a review comment may sit on, per file. */
  lines: Map<string, Set<number>>;
  ctx: DiffContext;
};

/**
 * The PR's diff per file (lockfiles left out), from one `git diff` of base...head, and the lines
 * a review comment may sit on.
 */
export async function prFiles(cwd: string, refs: PrRefs): Promise<PrFiles> {
  const out = await runOk(
    "git",
    ["-C", cwd, "diff", "--no-color", "--no-ext-diff", `${refs.base}...${refs.head}`],
    { timeoutMs: 120_000 },
  );
  const files = splitDiff(out);
  const lines = linesByFile(files);
  const ctx: DiffContext = {
    changed: files.map((f) => f.path),
    isCommentable: (path, line) => lines.get(path)?.has(line) ?? false,
  };
  return { files, lines, ctx };
}

/** One-line commit subjects of `from..to`. */
export async function logBetween(cwd: string, from: string, to: string): Promise<string> {
  const out = await runOk(
    "git",
    ["-C", cwd, "log", "--oneline", "--no-decorate", `${from}..${to}`],
    { timeoutMs: 30_000 },
  );
  return out.trim();
}

/** The repository's shared `.git` folder (config, hooks), also from a linked worktree. */
export async function gitCommonDir(workspacePath: string): Promise<string> {
  const out = await runOk("git", ["-C", workspacePath, "rev-parse", "--git-common-dir"], {
    timeoutMs: 10_000,
  });
  const common = out.trim();
  return isAbsolute(common) ? common : join(workspacePath, common);
}

/** What PR Tour writes in a clone: guides, and each run's files. */
const HIDDEN = [".pr-tour/", `${RUNS}/`];

/**
 * Adds PR Tour's folders to the repository's own exclude list, so guides and run files never
 * show in `git status`.
 */
export async function hidePrTourFolders(workspacePath: string): Promise<void> {
  const infoDir = join(await gitCommonDir(workspacePath), "info");
  const exclude = join(infoDir, "exclude");
  const current = await readFile(exclude, "utf8").catch(() => "");
  const lines = new Set(current.split("\n").map((l) => l.trim()));
  const missing = HIDDEN.filter((p) => !lines.has(p));
  if (!missing.length) return;
  await mkdir(infoDir, { recursive: true });
  const sep = current.endsWith("\n") || current === "" ? "" : "\n";
  await appendFile(exclude, `${sep}${missing.map((p) => `${p}\n`).join("")}`);
}
