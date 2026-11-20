// Which changed files the tour skips by design, and which must get a deep stop, decided from git
// and the vendored Diff Breakdown classifier before the agent runs, so the same PR always splits
// the same way. Pure: the worker runs git and passes the output in.
import type { NameStatus, NumStat } from "./breakdown/parse";
import type { CategoryId } from "./breakdown/types";
import { isLockfile } from "./repo";
import type { SkippedFile } from "./schema";

/** Kinds of change a reviewer must read closely, in the Changes section's order, with a file noun. */
export const RISKY_KINDS: readonly (readonly [CategoryId, string])[] = [
  ["contracts", "contract file"],
  ["migrations", "DB migration file"],
  ["cicd", "CI/CD file"],
  ["config", "config file"],
  ["dependencies", "dependency file"],
];

/**
 * Changed files with nothing to review, each with why, sorted by path: lockfiles, generated files
 * (the classifier's Generated: linguist-generated/vendored or a codegen name), files whose only
 * change is whitespace (in `git diff --numstat` but not in `git diff -w --numstat`), and pure
 * renames (status R with no line changed). The first reason that applies wins, in that order.
 */
export function skippedFiles(input: {
  numstat: readonly NumStat[];
  nameStatus: readonly NameStatus[];
  /** `git diff -w --numstat` of the same range: whitespace-only files are missing from it. */
  numstatIgnoringSpace: readonly NumStat[];
  classify: (path: string) => CategoryId;
}): SkippedFile[] {
  const status = new Map(input.nameStatus.map((s) => [s.path, s.status]));
  const beyondSpace = new Set(input.numstatIgnoringSpace.map((f) => f.path));
  const out: SkippedFile[] = [];
  for (const f of input.numstat) {
    const binary = f.added === null || f.deleted === null;
    const lines = (f.added ?? 0) + (f.deleted ?? 0);
    if (isLockfile(f.path)) out.push({ path: f.path, reason: "lockfile" });
    else if (input.classify(f.path) === "generated")
      out.push({ path: f.path, reason: "generated" });
    else if (status.get(f.path) === "R" && !binary && lines === 0)
      out.push({ path: f.path, reason: "rename" });
    else if (!binary && lines > 0 && !beyondSpace.has(f.path))
      out.push({ path: f.path, reason: "whitespace" });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Files of a risky kind, with the kind's noun ("dependency file"), leaving out what the tour skips
 * (lockfiles sort as dependencies but hold nothing to read).
 */
export function riskyFiles(
  paths: readonly string[],
  classify: (path: string) => CategoryId,
  skipped: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const nouns = new Map(RISKY_KINDS);
  const out = new Map<string, string>();
  for (const path of paths) {
    if (skipped.has(path) || isLockfile(path)) continue;
    const noun = nouns.get(classify(path));
    if (noun) out.set(path, noun);
  }
  return out;
}
