// The PR diff, file by file: what goes in the prompt within a budget, which lines a review comment
// may sit on, and which files the agent read with its own tools. Pure, so the worker and the tests
// share it.
import { isLockfile } from "./repo";
import type { Coverage } from "./schema";

/** UTF-8 bytes of diff the prompt may carry; whole files only, so nothing is cut mid-file. */
export const PROMPT_DIFF_BUDGET = 180_000;

export type FileDiff = {
  path: string;
  /** The path on the base side when git saw a rename. */
  oldPath: string | null;
  text: string;
  binary: boolean;
  additions: number;
  deletions: number;
};

/** `"a\tb"` style C-quoted paths, which git uses for unusual characters. */
function unquote(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  return raw
    .slice(1, -1)
    .replace(/\\([\\"tn])/g, (_, c: string) => (c === "t" ? "\t" : c === "n" ? "\n" : c));
}

function stripSide(raw: string, side: "a/" | "b/"): string {
  const path = unquote(raw.trim());
  return path.startsWith(side) ? path.slice(2) : path;
}

/**
 * One `git diff` output split into files. Lockfiles are left out (nothing to review there) unless
 * `keepLockfiles`, for showing a lockfile someone pressed in the guide tab.
 */
export function splitDiff(text: string, opts: { keepLockfiles?: boolean } = {}): FileDiff[] {
  const files: FileDiff[] = [];
  const chunks = text.split(/^(?=diff --git )/m).filter((c) => c.startsWith("diff --git "));
  for (const chunk of chunks) {
    let path: string | null = null;
    let oldPath: string | null = null;
    let renameFrom: string | null = null;
    let binary = false;
    let additions = 0;
    let deletions = 0;
    let inHunk = false;
    for (const line of chunk.split("\n")) {
      if (inHunk) {
        if (line.startsWith("+")) additions++;
        else if (line.startsWith("-")) deletions++;
        continue;
      }
      if (line.startsWith("@@")) inHunk = true;
      else if (line.startsWith("+++ ")) {
        const p = line.slice(4);
        if (p.trim() !== "/dev/null") path = stripSide(p, "b/");
      } else if (line.startsWith("--- ")) {
        const p = line.slice(4);
        if (p.trim() !== "/dev/null") oldPath = stripSide(p, "a/");
      } else if (line.startsWith("rename from ")) renameFrom = unquote(line.slice(12));
      else if (line.startsWith("rename to ")) path = unquote(line.slice(10));
      else if (line.startsWith("Binary files ")) binary = true;
    }
    if (!path) {
      // Deleted, binary or mode-only: take the path from the header, `diff --git a/x b/x`.
      const header = chunk.slice(0, chunk.indexOf("\n") === -1 ? undefined : chunk.indexOf("\n"));
      const m = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/.exec(header);
      path = m?.[2] ?? oldPath ?? "";
    }
    if (!path || (isLockfile(path) && !opts.keepLockfiles)) continue;
    const base = renameFrom ?? oldPath;
    files.push({
      path,
      oldPath: base && base !== path ? base : null,
      text: chunk.endsWith("\n") ? chunk : `${chunk}\n`,
      binary,
      additions,
      deletions,
    });
  }
  return files;
}

/**
 * Lines a review comment may sit on, per file: added and context lines on the PR-head (RIGHT)
 * side, read from the hunk headers. GitHub refuses a comment on any other line.
 */
export function commentableLines(diffText: string): Map<string, Set<number>> {
  return linesByFile(splitDiff(diffText));
}

/** The same, for a diff already split into files. */
export function linesByFile(files: readonly FileDiff[]): Map<string, Set<number>> {
  return new Map(files.map((file) => [file.path, linesOf(file.text)]));
}

function linesOf(text: string): Set<number> {
  const lines = new Set<number>();
  let right = 0;
  let inHunk = false;
  for (const line of text.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      right = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) lines.add(right++);
    else if (line.startsWith(" ")) lines.add(right++);
    else if (line.startsWith("diff --git ")) inHunk = false;
    // "-" lines exist only on the base side, "\ No newline" is a marker
  }
  return lines;
}

/** Commentable lines as `[first, last]` ranges, small enough to store with the guide. */
export function toRanges(lines: Set<number>): [number, number][] {
  const sorted = [...lines].sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  for (const n of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  return ranges;
}

export function inRanges(ranges: readonly (readonly [number, number])[], line: number): boolean {
  return ranges.some(([a, b]) => line >= a && line <= b);
}

export type FileKind = "source" | "config" | "test" | "docs";

const TEST = /(^|\/)(__tests__|tests?|spec|e2e|fixtures?)\/|\.(test|spec)\.[^/]+$|_test\.[^/]+$/i;
const DOCS = /\.(md|mdx|rst|txt|adoc)$|(^|\/)docs?\//i;
const CONFIG =
  /\.(json|ya?ml|toml|ini|cfg|conf|env|lock|properties|gradle|xml)$|(^|\/)(\.[^/]+|Dockerfile|Makefile|Procfile)$|(^|\/)\.github\//i;

export function fileKind(path: string): FileKind {
  if (TEST.test(path)) return "test";
  if (DOCS.test(path)) return "docs";
  if (CONFIG.test(path)) return "config";
  return "source";
}

const KIND_ORDER: Record<FileKind, number> = { source: 0, config: 1, test: 2, docs: 3 };

/**
 * Whole files for the prompt, most important first (source by change size, then config, tests,
 * docs), until the budget (UTF-8 bytes) is spent. A file that does not fit is left for the agent
 * to read.
 */
export function budgetDiff(
  files: readonly FileDiff[],
  budget = PROMPT_DIFF_BUDGET,
): { inPrompt: FileDiff[]; outside: FileDiff[] } {
  const ranked = [...files].sort(
    (a, b) =>
      KIND_ORDER[fileKind(a.path)] - KIND_ORDER[fileKind(b.path)] ||
      b.additions + b.deletions - (a.additions + a.deletions) ||
      a.path.localeCompare(b.path),
  );
  const inPrompt: FileDiff[] = [];
  const outside: FileDiff[] = [];
  let used = 0;
  for (const f of ranked) {
    const size = Buffer.byteLength(f.text);
    if (used + size <= budget) {
      inPrompt.push(f);
      used += size;
    } else outside.push(f);
  }
  return { inPrompt, outside };
}

export type ToolCall = { name: string; input: Record<string, unknown> };

/**
 * Changed files the agent opened with its `Read` tool: a changed path in the clone, or a file the
 * worker prepared for the run, mapped back through `prepared` (prepared path, relative to the
 * clone, to the PR path it holds). Agents report resolved paths, so a path outside `cwd` (macOS
 * `/private/var` for `/var`) still counts when it ends with the clone's directory name plus a
 * prepared or changed path; the longest such match wins.
 */
export function filesReadByAgent(
  calls: readonly ToolCall[],
  changed: readonly string[],
  cwd: string,
  prepared: ReadonlyMap<string, string> = new Map(),
): string[] {
  const set = new Set(changed);
  const read = new Set<string>();
  const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
  const base = `/${root.split("/").at(-2)}/`;
  const keys = [...prepared.keys(), ...changed].sort((a, b) => b.length - a.length);
  for (const call of calls) {
    if (call.name !== "Read" || typeof call.input.file_path !== "string") continue;
    let path = call.input.file_path;
    if (path.startsWith(root)) path = path.slice(root.length);
    else if (path.startsWith("/")) path = keys.find((k) => path.endsWith(base + k)) ?? path;
    if (path.startsWith("./")) path = path.slice(2);
    const pr = prepared.get(path) ?? path;
    if (set.has(pr)) read.add(pr);
  }
  return changed.filter((f) => read.has(f));
}

export function coverage(
  changed: readonly string[],
  inPrompt: readonly string[],
  readByAgent: readonly string[],
): Coverage {
  const seen = new Set([...inPrompt, ...readByAgent]);
  return {
    inPrompt: [...inPrompt],
    readByAgent: [...readByAgent],
    notRead: changed.filter((f) => !seen.has(f)),
  };
}
