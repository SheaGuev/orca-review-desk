// The files an agent reads during a run, written by the worker so no agent needs a shell: the PR's
// version of each changed file and the diffs left out of the prompt, in `.orca/pr-tour-runs/<pr>/`
// inside the clone (the agent's working directory). Names are numbers, never the PR's own paths,
// so a PR's CLAUDE.md or AGENTS.md is never loaded as instructions. Under `.orca/` because Orca's
// dev watcher reloads a dev plugin on any change outside `.git`, `.orca` and `node_modules`: when
// the clone is PR Tour's own dev folder, writing anywhere else would reload it and kill the run.
import { lstat, mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileDiff } from "./diff";
import { runOk } from "./exec";

const ORCA = ".orca";
export const RUNS = `${ORCA}/pr-tour-runs`;
/** Where runs were written before they moved under `.orca/`; removed at worker start. */
const OLD_RUNS = ".pr-tour/runs";

/** A run's folder, relative to the clone. */
export const runDir = (pr: number): string => `${RUNS}/${pr}`;

export type RunFiles = {
  /** The run's folder, relative to the clone: `.orca/pr-tour-runs/<pr>`. */
  dir: string;
  /** Each file left out of the prompt, to its prepared diff (relative to the clone). */
  diffs: ReadonlyMap<string, string>;
  /** Every prepared file (relative to the clone) to the PR path it holds; the run's index. */
  byPrepared: ReadonlyMap<string, string>;
};

export type RunFilesInput = {
  cwd: string;
  pr: number;
  /** The ref holding the PR head. */
  headRef: string;
  /** Every changed file, in the order they are numbered. */
  files: readonly FileDiff[];
  /** Files whose diff is not in the prompt. */
  outside: readonly FileDiff[];
  /** Files the tour skips by design (lockfiles, generated files): no PR version is written. */
  skipped: ReadonlySet<string>;
};

const deleted = (f: FileDiff) => /^deleted file mode /m.test(f.text);

/** Fails unless `path` is a real folder (not a link a repository could commit), making it if missing. */
async function realFolder(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  if (!(await lstat(path)).isDirectory()) throw new Error(`${path} is not a folder`);
}

/** Whether `rel` inside `cwd` exists as a folder, not a link. */
const isRealFolder = async (cwd: string, rel: string): Promise<boolean> =>
  (await lstat(join(cwd, rel)).catch(() => null))?.isDirectory() ?? false;

/**
 * `git cat-file --batch` output read as latin1 (one character per byte): each object's bytes, or
 * null when git has no such object, in the order asked.
 */
function splitBatch(out: string, count: number): (Buffer | null)[] {
  const blobs: (Buffer | null)[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    const end = out.indexOf("\n", at);
    if (end === -1) break;
    const header = out.slice(at, end);
    const m = / (\S+) (\d+)$/.exec(header);
    if (!m || header.endsWith(" missing")) {
      blobs.push(null);
      at = end + 1;
      continue;
    }
    const size = Number(m[2]);
    blobs.push(m[1] === "blob" ? Buffer.from(out.slice(end + 1, end + 1 + size), "latin1") : null);
    at = end + 1 + size + 1;
  }
  while (blobs.length < count) blobs.push(null);
  return blobs;
}

/** Writes the run's files and its `index.txt`; one git process reads every PR version. */
export async function writeRunFiles(input: RunFilesInput): Promise<RunFiles> {
  const { cwd } = input;
  const dir = runDir(input.pr);
  await realFolder(join(cwd, ORCA));
  await realFolder(join(cwd, RUNS));
  await rm(join(cwd, dir), { recursive: true, force: true });
  await mkdir(join(cwd, dir, "diffs"), { recursive: true });
  await mkdir(join(cwd, dir, "head"), { recursive: true });

  const outside = new Set(input.outside.map((f) => f.path));
  const wantsHead = (f: FileDiff) =>
    !f.binary && !deleted(f) && !input.skipped.has(f.path) && !f.path.includes("\n");
  const numbered = input.files
    .filter((f) => outside.has(f.path) || wantsHead(f))
    .map((f, i) => ({ file: f, n: String(i + 1).padStart(4, "0") }));

  const heads = numbered.filter((e) => wantsHead(e.file));
  const blobs = heads.length
    ? splitBatch(
        await runOk("git", ["-C", cwd, "cat-file", "--batch"], {
          input: heads.map((e) => `${input.headRef}:${e.file.path}\n`).join(""),
          timeoutMs: 120_000,
          stdoutEncoding: "latin1",
        }),
        heads.length,
      )
    : [];
  const headOf = new Map(heads.map((e, i) => [e.file.path, blobs[i] ?? null]));

  const diffs = new Map<string, string>();
  const byPrepared = new Map<string, string>();
  const index: string[] = [];
  for (const { file, n } of numbered) {
    const kinds: string[] = [];
    if (outside.has(file.path)) {
      const rel = `${dir}/diffs/${n}.diff`;
      await writeFile(join(cwd, rel), file.text);
      diffs.set(file.path, rel);
      byPrepared.set(rel, file.path);
      kinds.push("diff");
    }
    const blob = headOf.get(file.path);
    if (blob) {
      const rel = `${dir}/head/${n}.txt`;
      await writeFile(join(cwd, rel), blob);
      byPrepared.set(rel, file.path);
      kinds.push("head");
    }
    if (kinds.length) index.push(`${n}  ${kinds.join(" ")}  ${file.path}\n`);
  }
  await writeFile(join(cwd, dir, "index.txt"), index.join(""));
  return { dir, diffs, byPrepared };
}

/** Removes one run's folder, and `pr-tour-runs/` once no other run is in it; `.orca/` stays (Orca's). */
export async function removeRunFiles(cwd: string, pr: number): Promise<void> {
  // Through a linked `.orca`, this would delete outside the clone; nothing was written there.
  if (!(await isRealFolder(cwd, ORCA)) || !(await isRealFolder(cwd, RUNS))) return;
  await rm(join(cwd, RUNS, String(pr)), { recursive: true, force: true });
  await rmdir(join(cwd, RUNS)).catch(() => undefined);
}

/**
 * Removes every run folder left in these clones, such as by a crash, at today's location and the
 * old `.pr-tour/runs/`; guides and the rest of `.orca/` stay.
 */
export async function removeStaleRuns(cwds: readonly string[]): Promise<void> {
  for (const cwd of cwds) {
    for (const [parent, root] of [
      [ORCA, RUNS],
      [".pr-tour", OLD_RUNS],
    ] as const) {
      // A link here was not written by PR Tour: leave it and what it points to alone.
      if ((await isRealFolder(cwd, parent)) && (await isRealFolder(cwd, root)))
        await rm(join(cwd, root), { recursive: true, force: true });
    }
  }
}
