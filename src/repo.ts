// Pure helpers about repositories: remote URLs, CODEOWNERS and lockfile-only changes.

/** `owner/repo` (lowercase) from an ssh or https GitHub remote URL, or null. */
export function repoSlugFromRemote(url: string): string | null {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/**
 * The GitHub host a remote URL points at (`git@host:o/r.git`, `ssh://git@host[:port]/o/r`,
 * `https://host/o/r.git`), lowercase; `github.com` when there is none, for GitHub's ssh-over-443
 * host, and for an ssh config alias (a name without a dot).
 */
export function githubHost(url: string): string {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?([^/:\s]+)[:/]/i.exec(url.trim());
  const host = m?.[1]?.toLowerCase() ?? "";
  return host.includes(".") && host !== "ssh.github.com" ? host : "github.com";
}

/** `owner/repo` (lowercase) from a search result's `repository_url`, or "" when it names none. */
export function repoSlugFromApiUrl(url: string): string {
  const [name, owner] = url.split("/").reverse();
  return owner && name ? `${owner}/${name}`.toLowerCase() : "";
}

/** Lockfile names, lowercase, each with the manifest it is written from. */
const LOCKFILE_SOURCE: ReadonlyMap<string, string> = new Map([
  ["pnpm-lock.yaml", "package.json"],
  ["package-lock.json", "package.json"],
  ["npm-shrinkwrap.json", "package.json"],
  ["yarn.lock", "package.json"],
  ["bun.lock", "package.json"],
  ["bun.lockb", "package.json"],
  ["cargo.lock", "Cargo.toml"],
  ["gemfile.lock", "Gemfile"],
  ["poetry.lock", "pyproject.toml"],
  ["uv.lock", "pyproject.toml"],
  ["pipfile.lock", "Pipfile"],
  ["go.sum", "go.mod"],
  ["composer.lock", "composer.json"],
  ["podfile.lock", "Podfile"],
  ["flake.lock", "flake.nix"],
  ["mix.lock", "mix.exs"],
  ["pubspec.lock", "pubspec.yaml"],
  ["package.resolved", "Package.swift"],
]);

/** Lockfile names, lowercase; matched without regard to case. */
export const LOCKFILES: ReadonlySet<string> = new Set(LOCKFILE_SOURCE.keys());

const baseOf = (path: string): string => path.split("/").pop() ?? "";
const dirOf = (path: string): string => path.slice(0, path.length - baseOf(path).length);

/**
 * The changed manifest a lockfile is written from, so its change can be reviewed there: the one
 * in the lockfile's own folder, else any changed manifest of its kind (a workspace's root lockfile
 * follows its packages' manifests). Null for a file that is not a lockfile, or when no manifest of
 * its kind changed.
 */
export function lockfileSource(path: string, changed: readonly string[]): string | null {
  const manifest = LOCKFILE_SOURCE.get(baseOf(path).toLowerCase());
  if (!manifest) return null;
  const candidates = changed.filter((f) => baseOf(f) === manifest);
  return candidates.find((f) => dirOf(f) === dirOf(path)) ?? candidates[0] ?? null;
}

export function isLockfile(path: string): boolean {
  return LOCKFILES.has(baseOf(path).toLowerCase());
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
    const c = pattern[i] ?? "";
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

/** `owner/repo#7`: how the worker, the panel and the guide tab name a PR. */
export const prKey = (repo: string, number: number): string => `${repo}#${number}`;

/** The repo and number a PR key names; null when it is not one. */
export function parsePrKey(key: string): { repo: string; number: number } | null {
  const at = key.lastIndexOf("#");
  const number = Number(key.slice(at + 1));
  return at > 0 && Number.isInteger(number) && number > 0
    ? { repo: key.slice(0, at), number }
    : null;
}
