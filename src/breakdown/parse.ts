// Vendored from orca-diff-breakdown v0.3.0 (MIT); keep in step with it.
// The pure parsers of its src/git.ts; this plugin runs git through src/exec.ts instead.
import type { PathAttributes } from "./classify";
import type { FileStatus } from "./types";

export type NameStatus = { path: string; oldPath?: string; status: FileStatus };
export type NumStat = { path: string; added: number | null; deleted: number | null };

export function parseNulList(out: string): string[] {
  return out.split("\0").filter(Boolean);
}

/** `git diff --name-status -z`: `M\0path\0`, or `R100\0old\0new\0` for renames and copies. */
export function parseNameStatusZ(out: string): NameStatus[] {
  const parts = out.split("\0");
  const rows: NameStatus[] = [];
  for (let i = 0; i < parts.length;) {
    const code = parts[i++];
    if (!code) continue;
    const letter = code[0] as FileStatus;
    if (letter === "R" || letter === "C") {
      const oldPath = parts[i++] ?? "";
      const path = parts[i++] ?? "";
      rows.push({ path, oldPath, status: letter });
    } else {
      rows.push({ path: parts[i++] ?? "", status: letter === "U" ? "M" : letter });
    }
  }
  return rows;
}

/** `git diff --numstat -z`: `a\td\tpath\0`, or `a\td\t\0old\0new\0` for renames; `-` for binary. */
export function parseNumstatZ(out: string): NumStat[] {
  const parts = out.split("\0");
  const rows: NumStat[] = [];
  for (let i = 0; i < parts.length;) {
    const head = parts[i++];
    if (!head) continue;
    const [a, d, inlinePath] = head.split("\t");
    let path = inlinePath;
    if (path === "") {
      i++; // old path
      path = parts[i++];
    }
    rows.push({
      path: path ?? "",
      added: a === "-" ? null : Number(a),
      deleted: d === "-" ? null : Number(d),
    });
  }
  return rows;
}

export const LINGUIST = [
  "linguist-generated",
  "linguist-vendored",
  "linguist-documentation",
] as const;

/** `git check-attr -z` output for LINGUIST: only paths with one of them set. */
export function parseLinguistAttributes(out: string): Map<string, PathAttributes> {
  const result = new Map<string, PathAttributes>();
  const parts = out.split("\0");
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const [path = "", attr, value] = [parts[i], parts[i + 1], parts[i + 2]];
    if (value !== "set" && value !== "true") continue;
    const entry = result.get(path) ?? {};
    if (attr === "linguist-generated") entry.generated = true;
    if (attr === "linguist-vendored") entry.vendored = true;
    if (attr === "linguist-documentation") entry.documentation = true;
    result.set(path, entry);
  }
  return result;
}

export const OVERRIDES_PATH = ".orca/diff-breakdown.json";
