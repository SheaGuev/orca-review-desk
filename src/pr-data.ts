// What the guide tab and the tour ask git about a PR at a commit: one file's diff, the Changes
// breakdown, and the files the tour skips. Each answer is worked out once per `key@commit` and
// kept in memory; a failed one is forgotten, so asking again retries.
import { buildBreakdown, type Breakdown } from "./breakdown/assemble";
import type { Ecosystem } from "./breakdown/categories";
import {
  createClassifier,
  detectEcosystems,
  parseOverrides,
  type Classifier,
  type Overrides,
  type PathAttributes,
} from "./breakdown/classify";
import {
  LINGUIST,
  OVERRIDES_PATH,
  parseLinguistAttributes,
  parseNameStatusZ,
  parseNulList,
  parseNumstatZ,
  type NameStatus,
  type NumStat,
} from "./breakdown/parse";
import { promiseCache, type PromiseCache } from "./cache";
import { splitDiff } from "./diff";
import { fileDiffView, type DiffFile } from "./diff-model";
import { fail, message } from "./errors";
import { run, runOk } from "./exec";
import { fetchPr, hasCommit, prRefs, type Clone } from "./git";
import { SCHEMA_ID, type SkippedFile } from "./schema";
import type { StoredGuide } from "./store";
import { riskyFiles, skippedFiles } from "./triage";

/** File diffs the guide tab asked for; dropped all at once past this many. */
const DIFF_CACHE_LIMIT = 300;
/** Per-PR answers (statuses, breakdowns, skipped files, ecosystems); dropped all at once past this. */
const PR_CACHE_LIMIT = 50;

/** The range's files as git counts them, their status letters, and how each is classified. */
type ChangedFiles = { statuses: NameStatus[]; numstat: NumStat[]; classify: Classifier };

/** Files the tour skips by design, and risky files (with their kind's noun) that need a deep stop. */
export type Triage = { skipped: SkippedFile[]; risky: Map<string, string> };

/** Where a PR's commits are: its clone, repository and key. */
export type PrPlace = { cwd: string; repo: string; key: string };

/** What every lookup shares: the log, where clones are, and the answers kept so far. */
type Ctx = {
  log: (text: string) => void;
  /** The local clone of the guide's repository, or null when Orca has none. */
  cloneOf: (key: string, repo: string) => Promise<Clone | null>;
  diffs: PromiseCache<DiffFile>;
  /** `--name-status -M` of a range: renames for diffs, status letters for Changes. */
  statuses: PromiseCache<NameStatus[]>;
  changed: PromiseCache<ChangedFiles>;
  breakdowns: PromiseCache<Breakdown>;
  /** For guides written before they stored their skipped files. */
  skippedLists: PromiseCache<SkippedFile[]>;
  /** Ecosystems whose presets apply, by `repo@commit`: one `ls-tree` of the whole repo each. */
  ecosystems: PromiseCache<Ecosystem[]>;
};

const nameStatus = (c: Ctx, cwd: string, range: string, cacheKey: string): Promise<NameStatus[]> =>
  c.statuses.get(cacheKey, () =>
    runOk("git", ["-C", cwd, "diff", "--name-status", "-M", "-z", range], {
      timeoutMs: 60_000,
    }).then(parseNameStatusZ),
  );

const ecosystemsAt = (c: Ctx, cwd: string, repo: string, commit: string): Promise<Ecosystem[]> =>
  c.ecosystems.get(`${repo}@${commit}`, () =>
    runOk("git", ["-C", cwd, "ls-tree", "-r", "--name-only", "-z", commit], {
      timeoutMs: 60_000,
    }).then((out) => detectEcosystems(parseNulList(out))),
  );

/** The repo's own category rules at the PR head, as Diff Breakdown reads them from a checkout. */
async function overridesAt(c: Ctx, cwd: string, commit: string): Promise<Overrides | undefined> {
  const out = await run("git", ["-C", cwd, "show", `${commit}:${OVERRIDES_PATH}`], {
    timeoutMs: 10_000,
  });
  if (out.code !== 0) return undefined; // the repo has none
  try {
    return parseOverrides(out.stdout);
  } catch (e) {
    c.log(`${OVERRIDES_PATH} at ${commit.slice(0, 7)} ignored: ${message(e)}`);
    return undefined;
  }
}

/** linguist-* attributes from the PR head's .gitattributes (not the working tree's). */
async function attributesAt(
  c: Ctx,
  cwd: string,
  commit: string,
  paths: readonly string[],
): Promise<Map<string, PathAttributes>> {
  if (!paths.length) return new Map();
  const out = await run(
    "git",
    ["-C", cwd, "check-attr", "-z", `--source=${commit}`, "--stdin", ...LINGUIST],
    { input: `${paths.join("\0")}\0`, timeoutMs: 30_000 },
  );
  if (out.code !== 0) {
    c.log(`check-attr at ${commit.slice(0, 7)} failed: ${out.stderr.trim()}`);
    return new Map();
  }
  return parseLinguistAttributes(out.stdout);
}

/** Shared by the Changes breakdown and the tour's triage. */
const changedFilesAt = (
  c: Ctx,
  at: PrPlace,
  commit: string,
  range: string,
): Promise<ChangedFiles> =>
  c.changed.get(`${at.key}@${commit}`, async () => {
    const [statusList, numstat, found, overrides] = await Promise.all([
      nameStatus(c, at.cwd, range, `${at.key}@${commit}`),
      runOk("git", ["-C", at.cwd, "diff", "--numstat", "-M", "-z", "--no-textconv", range], {
        timeoutMs: 60_000,
      }).then(parseNumstatZ),
      ecosystemsAt(c, at.cwd, at.repo, commit),
      overridesAt(c, at.cwd, commit),
    ]);
    const attributes = await attributesAt(
      c,
      at.cwd,
      commit,
      numstat.map((f) => f.path),
    );
    return {
      statuses: statusList,
      numstat,
      classify: createClassifier({ ecosystems: found, overrides, attributes }),
    };
  });

/**
 * Files the tour skips by design and risky files that need a deep stop, at `commit` against the
 * base ref: the classifier's Generated and lockfiles, whitespace-only changes (missing from a
 * `git diff -w --numstat`) and pure renames.
 */
async function triageAt(c: Ctx, at: PrPlace, commit: string, baseRef: string): Promise<Triage> {
  const range = `${baseRef}...${commit}`;
  const [files, ignoringSpace] = await Promise.all([
    changedFilesAt(c, at, commit, range),
    runOk("git", ["-C", at.cwd, "diff", "-w", "--numstat", "-M", "-z", "--no-textconv", range], {
      timeoutMs: 60_000,
    }).then(parseNumstatZ),
  ]);
  const skipped = skippedFiles({
    numstat: files.numstat,
    nameStatus: files.statuses,
    numstatIgnoringSpace: ignoringSpace,
    classify: files.classify,
  });
  const risky = riskyFiles(
    files.numstat.map((f) => f.path),
    files.classify,
    new Set(skipped.map((f) => f.path)),
  );
  return { skipped, risky };
}

/**
 * The guide's clone, with `commit` and the base ref present: they are fetched when a guide is
 * written, but a fresh clone or a pruned object needs them again.
 */
async function placeAt(
  c: Ctx,
  guide: StoredGuide,
  key: string,
  commit: string,
): Promise<{ at: PrPlace; range: string }> {
  const { repo, number, baseRef } = guide.pr;
  const clone = await c.cloneOf(key, repo);
  if (!clone) throw fail("unavailable", `No local clone of ${repo} in Orca`);
  const refs = prRefs(number);
  const present = (await hasCommit(clone.path, commit)) && (await hasCommit(clone.path, refs.base));
  if (!present) {
    await fetchPr(clone, { number, baseRefName: baseRef });
    if (!(await hasCommit(clone.path, commit)))
      throw fail(
        "unavailable",
        `Commit ${commit.slice(0, 7)} is no longer on GitHub (the branch was probably force-pushed). Regenerate the guide.`,
      );
  }
  return { at: { cwd: clone.path, repo, key }, range: `${refs.base}...${commit}` };
}

async function computeFileDiff(
  c: Ctx,
  guide: StoredGuide,
  at: { key: string; commit: string; path: string },
): Promise<DiffFile> {
  const { key, commit, path } = at;
  const { at: place, range } = await placeAt(c, guide, key, commit);
  const renamed = (await nameStatus(c, place.cwd, range, `${key}@${commit}`)).find(
    (s) => s.status === "R" && s.path === path,
  );
  const out = await runOk(
    "git",
    [
      "-C",
      place.cwd,
      // Paths are file names, never pathspec magic such as ":(exclude)".
      "--literal-pathspecs",
      "diff",
      "--no-color",
      "--no-ext-diff",
      "-M",
      range,
      "--",
      ...(renamed?.oldPath ? [renamed.oldPath] : []),
      path,
    ],
    { timeoutMs: 60_000 },
  );
  const file = splitDiff(out, { keepLockfiles: true }).find((f) => f.path === path) ?? null;
  return fileDiffView(file, path, commit);
}

async function computeBreakdown(
  c: Ctx,
  guide: StoredGuide,
  key: string,
  commit: string,
): Promise<Breakdown> {
  const { at, range } = await placeAt(c, guide, key, commit);
  const files = await changedFilesAt(c, at, commit, range);
  return buildBreakdown({
    headRef: guide.pr.headRef,
    baseRef: guide.pr.baseRef,
    numstat: files.numstat,
    nameStatus: files.statuses,
    classify: files.classify,
  });
}

export type PrData = {
  triage: (at: PrPlace, commit: string, baseRef: string) => Promise<Triage>;
  /** One file's diff at `commit`, for the guide tab's diff pane. */
  fileDiff: (guide: StoredGuide, key: string, commit: string, path: string) => Promise<DiffFile>;
  /** The PR's changed files grouped by kind, as Diff Breakdown groups a branch. */
  breakdown: (guide: StoredGuide, key: string, commit: string) => Promise<Breakdown>;
  /** The guide's skipped files at `commit`: stored with it when it is that commit's, else from git. */
  skipped: (guide: StoredGuide, key: string, commit: string) => Promise<SkippedFile[]>;
};

export function createPrData(deps: Pick<Ctx, "log" | "cloneOf">): PrData {
  const c: Ctx = {
    ...deps,
    diffs: promiseCache(DIFF_CACHE_LIMIT),
    statuses: promiseCache(PR_CACHE_LIMIT),
    changed: promiseCache(PR_CACHE_LIMIT),
    breakdowns: promiseCache(PR_CACHE_LIMIT),
    skippedLists: promiseCache(PR_CACHE_LIMIT),
    ecosystems: promiseCache(PR_CACHE_LIMIT),
  };
  return {
    triage: (at, commit, baseRef) => triageAt(c, at, commit, baseRef),
    fileDiff: (guide, key, commit, path) =>
      c.diffs.get(`${key}@${commit}:${path}`, () =>
        computeFileDiff(c, guide, { key, commit, path }),
      ),
    breakdown: (guide, key, commit) =>
      c.breakdowns.get(`${key}@${commit}`, () => computeBreakdown(c, guide, key, commit)),
    skipped: (guide, key, commit) => {
      if (guide.schema === SCHEMA_ID && guide.skipped && guide.pr.commit === commit)
        return Promise.resolve(guide.skipped);
      return c.skippedLists.get(`${key}@${commit}`, async () => {
        const { at } = await placeAt(c, guide, key, commit);
        return (await triageAt(c, at, commit, prRefs(guide.pr.number).base)).skipped;
      });
    },
  };
}
