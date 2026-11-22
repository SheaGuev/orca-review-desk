// The tamper check around an agent run: `.git/config` and every file under `.git/hooks/` are
// hashed before and after, so a run that changed what git will execute is caught before anything
// it wrote is trusted. The agent has read-only tools; this catches the day that stops being true.
import { createHash } from "node:crypto";
import { readdir, readFile, readlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { gitCommonDir } from "./git";

/** Thrown when a run changed the clone's git config or hooks; `paths` name what changed. */
export class GitTampered extends Error {
  constructor(readonly paths: readonly string[]) {
    super(
      `The agent run changed ${paths.join(", ")} in the clone. Nothing was stored and automatic guides are off for this repository; check the clone before turning them back on.`,
    );
    this.name = "GitTampered";
  }
}

const hash = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** Every file under `dir` (links by their target), by path relative to `root`. */
async function hashTree(root: string, dir: string, out: Map<string, string>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const path = join(dir, e.name);
    const name = `.git/${relative(root, path).split(sep).join("/")}`;
    if (e.isDirectory()) await hashTree(root, path, out);
    else if (e.isSymbolicLink()) out.set(name, `link:${await readlink(path)}`);
    else out.set(name, hash(await readFile(path)));
  }
}

/** `.git/config` and `.git/hooks/**`, path to content hash; a missing file is simply absent. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const config = await readFile(join(root, "config")).catch(() => null);
  if (config) out.set(".git/config", hash(config));
  await hashTree(root, join(root, "hooks"), out);
  return out;
}

/** Paths added, removed or changed between two snapshots, sorted. */
function changed(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((p) => before.get(p) !== after.get(p)).sort();
}

/**
 * Runs `fn` (the agent) and throws GitTampered when the clone's git config or hooks differ
 * afterwards, whether `fn` succeeded or failed; otherwise answers or throws as `fn` did.
 */
export async function watchGit<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const root = await gitCommonDir(cwd);
  const before = await snapshot(root);
  const outcome = await fn().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const paths = changed(before, await snapshot(root));
  if (paths.length) throw new GitTampered(paths);
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
