// The guide's Changes section as data: the PR's files grouped the way Diff Breakdown groups a
// branch (src/breakdown/categories.ts), with git's status letter and line counts. Pure: the worker
// runs git and passes the output in.
import { CATEGORIES } from "./categories";
import type { Classifier } from "./classify";
import type { NameStatus, NumStat } from "./parse";
import type { CategoryId, FileStatus } from "./types";

/** Files listed per category; the counts always cover every file. Keeps an answer well under 1 MiB. */
export const MAX_FILES_PER_CATEGORY = 300;

export type BreakdownFile = {
  path: string;
  /** Set for renames and copies. */
  oldPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  /** Git counts no lines for a binary file. */
  binary?: true;
};

export type BreakdownCategory = {
  id: CategoryId;
  name: string;
  additions: number;
  deletions: number;
  /** Sorted by path, at most MAX_FILES_PER_CATEGORY. */
  files: BreakdownFile[];
  /** Files left out of `files` by the cap (their lines are still counted). */
  omitted: number;
};

export type Breakdown = {
  headRef: string;
  baseRef: string;
  /** Lines changed outside Generated, which is listed but not counted (as in Diff Breakdown). */
  additions: number;
  deletions: number;
  /** Every changed file, Generated included. */
  fileCount: number;
  /** Non-empty categories in Diff Breakdown's order; Generated last. */
  categories: BreakdownCategory[];
};

/**
 * One row per file whose contents git counted (`--numstat`), with its status and old path from
 * `--name-status` (both run with -M, so renames line up), grouped and totalled by category.
 */
export function buildBreakdown(input: {
  headRef: string;
  baseRef: string;
  numstat: readonly NumStat[];
  nameStatus: readonly NameStatus[];
  classify: Classifier;
  maxFiles?: number;
}): Breakdown {
  const max = input.maxFiles ?? MAX_FILES_PER_CATEGORY;
  const statuses = new Map(input.nameStatus.map((s) => [s.path, s]));
  const byCategory = new Map<CategoryId, BreakdownFile[]>();
  for (const stat of input.numstat) {
    const s = statuses.get(stat.path);
    const file: BreakdownFile = {
      path: stat.path,
      ...(s?.oldPath ? { oldPath: s.oldPath } : {}),
      status: s?.status ?? "M",
      additions: stat.added ?? 0,
      deletions: stat.deleted ?? 0,
      ...(stat.added === null ? { binary: true as const } : {}),
    };
    const id = input.classify(stat.path);
    const members = byCategory.get(id);
    if (members) members.push(file);
    else byCategory.set(id, [file]);
  }
  const categories: BreakdownCategory[] = [];
  for (const { id, name } of CATEGORIES) {
    const files = byCategory.get(id);
    if (!files) continue;
    files.sort((a, b) => a.path.localeCompare(b.path));
    categories.push({
      id,
      name,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
      files: files.slice(0, max),
      omitted: Math.max(0, files.length - max),
    });
  }
  const counted = categories.filter((c) => c.id !== "generated");
  return {
    headRef: input.headRef,
    baseRef: input.baseRef,
    additions: counted.reduce((n, c) => n + c.additions, 0),
    deletions: counted.reduce((n, c) => n + c.deletions, 0),
    fileCount: input.numstat.length,
    categories,
  };
}
