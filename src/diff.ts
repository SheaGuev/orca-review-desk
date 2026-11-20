// The PR diff, file by file: what goes in the prompt within a budget, which lines a review comment
// may sit on, and which files the agent read with its own tools. Pure, so the worker and the tests
// share it.
import { isLockfile } from "./repo";

/** Characters of diff the prompt may carry; whole files only, so nothing is cut mid-file. */
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
      path = m ? m[2] : (oldPath ?? "");
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
  const out = new Map<string, Set<number>>();
  for (const file of splitDiff(diffText)) out.set(file.path, linesOf(file.text));
  return out;
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
 * docs), until the budget is spent. A file that does not fit is left for the agent to read.
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
    if (used + f.text.length <= budget) {
      inPrompt.push(f);
      used += f.text.length;
    } else outside.push(f);
  }
  return { inPrompt, outside };
}

export type ToolCall = { name: string; input: Record<string, unknown> };

/** Splits a shell command into words, honouring quotes; good enough for the git calls agents make. */
function words(command: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s"'|;&]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * Changed files the agent opened with its tools: `Read` of a path, or a `git show <ref>:<path>`,
 * `git diff … -- <path>` style Bash call (also with `git -C <dir>`, and a folder pathspec).
 */
export function filesReadByAgent(
  calls: readonly ToolCall[],
  changed: readonly string[],
  cwd: string,
): string[] {
  const set = new Set(changed);
  const read = new Set<string>();
  const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
  const rel = (p: string) => {
    let path = p.startsWith(root) ? p.slice(root.length) : p;
    if (path.startsWith("./")) path = path.slice(2);
    return path;
  };
  const mark = (raw: string) => {
    const p = rel(raw);
    if (set.has(p)) {
      read.add(p);
      return;
    }
    // A folder pathspec (`-- src/auth/`) covers the files below it.
    const dir = p.endsWith("/") ? p : `${p}/`;
    if (p && p !== "." && !p.includes(":"))
      for (const f of changed) if (f.startsWith(dir)) read.add(f);
  };
  for (const call of calls) {
    if (call.name === "Read" && typeof call.input.file_path === "string")
      mark(call.input.file_path);
    if (call.name !== "Bash" || typeof call.input.command !== "string") continue;
    const w = words(call.input.command);
    for (let i = 0; i < w.length; i++) {
      if (w[i] !== "git") continue;
      let j = i + 1;
      while (w[j] === "-C" || w[j] === "-c" || w[j]?.startsWith("--git-dir"))
        j += w[j] === "-C" || w[j] === "-c" ? 2 : 1;
      const sub = w[j];
      if (sub !== "show" && sub !== "diff" && sub !== "log") continue;
      let afterDashes = false;
      for (let k = j + 1; k < w.length && w[k] !== "git"; k++) {
        const t = w[k];
        if (t === "--") afterDashes = true;
        else if (afterDashes) mark(t);
        else if (sub === "show" && /^[^-][^:]*:.+/.test(t)) mark(t.slice(t.indexOf(":") + 1));
        else if (!t.startsWith("-") && set.has(rel(t))) mark(t);
      }
    }
  }
  return changed.filter((f) => read.has(f));
}

export type Coverage = { inPrompt: string[]; readByAgent: string[]; notRead: string[] };

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
