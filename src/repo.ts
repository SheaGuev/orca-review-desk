// Pure helpers about repositories: remote URLs, CODEOWNERS and lockfile-only changes.

/** `owner/repo` (lowercase) from an ssh or https GitHub remote URL, or null. */
export function repoSlugFromRemote(url: string): string | null {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** `owner/repo` (lowercase) from a search result's `repository_url`. */
export function repoSlugFromApiUrl(url: string): string {
  const parts = url.split("/");
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`.toLowerCase();
}

const LOCKFILES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "pipfile.lock",
  "go.sum",
  "composer.lock",
  "podfile.lock",
  "flake.lock",
  "mix.lock",
  "pubspec.lock",
  "package.resolved",
]);

export function isLockfile(path: string): boolean {
  return LOCKFILES.has((path.split("/").pop() ?? "").toLowerCase());
}

/** True when every changed file is a lockfile, so there is nothing for an agent to explain. */
export function isLockfileOnly(files: readonly string[]): boolean {
  return files.length > 0 && files.every(isLockfile);
}

export type OwnerRule = { pattern: RegExp; owners: string[] };

function globToRegExp(raw: string): RegExp {
  let pattern = raw.trim();
  const anchored = pattern.startsWith("/") || pattern.slice(0, -1).includes("/");
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  const dirOnly = pattern.endsWith("/");
  if (dirOnly) pattern = pattern.slice(0, -1);
  let body = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      // `**/` matches any number of folders, a trailing `**` matches everything below
      if (pattern[i + 2] === "/") {
        body += "(?:.*/)?";
        i += 2;
      } else {
        body += ".*";
        i += 1;
      }
    } else if (c === "*") body += "[^/]*";
    else if (c === "?") body += "[^/]";
    else body += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const start = anchored ? "^" : "^(?:.*/)?";
  // A pattern matches the path itself or anything inside it, like gitignore.
  const end = dirOnly ? "/" : "(?:$|/)";
  return new RegExp(start + body + end);
}

/** CODEOWNERS rules in file order; later rules win. */
export function parseCodeowners(text: string): OwnerRule[] {
  const rules: OwnerRule[] = [];
  for (const line of text.split("\n")) {
    const clean = line.replace(/(^|\s)#.*$/, "").trim();
    if (!clean) continue;
    const [pattern, ...owners] = clean.split(/\s+/);
    if (!pattern || pattern.startsWith("!")) continue;
    rules.push({ pattern: globToRegExp(pattern), owners: owners.map((o) => o.toLowerCase()) });
  }
  return rules;
}

/** Owners of one path: the last matching rule's owners. */
export function ownersOf(rules: readonly OwnerRule[], path: string): string[] {
  let owners: string[] = [];
  for (const rule of rules) if (rule.pattern.test(path)) owners = rule.owners;
  return owners;
}

/** How many of `files` any of `teams` (`org/team`) owns. */
export function countOwnedFiles(
  rules: readonly OwnerRule[],
  files: readonly string[],
  teams: readonly string[],
): number {
  const handles = new Set(teams.map((t) => `@${t.toLowerCase().replace(/^@/, "")}`));
  return files.filter((f) => ownersOf(rules, f).some((o) => handles.has(o))).length;
}

/** Settings text `a/b, c/d` as a clean list. */
export function parseTeams(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/[,\s]+/)
    .map((t) => t.trim().replace(/^@/, ""))
    .filter((t) => /^[\w.-]+\/[\w.-]+$/.test(t));
}
