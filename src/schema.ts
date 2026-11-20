// The prguide data contract. The worker checks what the agent writes against it, and the guide
// editor checks the file it opens. Shared by both sides, so it imports nothing.
//
// v2 splits every point into a short `headline` and an unlimited `detail`, adds findings with
// ready-to-post comments, a note for every changed file, and which files the agent actually saw.
// v1 guides still open (upgraded for drawing) and count as stale, so they are replaced.

export const SCHEMA_ID = "prguide/v2";
export const SCHEMA_V1 = "prguide/v1";

export type RiskLevel = "low" | "medium" | "high";
export type ClaimVerdict = "matches" | "mismatch" | "unclear";
export type ReviewRequest = "user" | "team" | "authored" | "manual";
export type Severity = "blocker" | "major" | "minor" | "nit";
export const SEVERITIES: readonly Severity[] = ["blocker", "major", "minor", "nit"];

export type FlowStep = { label: string; changed?: boolean };

/** A headline the reviewer scans, and as much detail as the point needs, shown on request. */
export type Point = { headline: string; detail?: string };

export type Finding = {
  /** Stable within the guide ("f1", "f2"), so a draft can remember which ones it used. */
  id: string;
  severity: Severity;
  file: string;
  /** PR-head (RIGHT side) line, or null for the whole file. */
  line: number | null;
  headline: string;
  detail: string;
  /** Review comment text ready to post, or null when a reviewer would not raise it. */
  suggestedComment: string | null;
};

/** PR-head (RIGHT side) lines `start`..`end`, both included. */
export type LineRange = { start: number; end: number };

/** How closely the reviewer reads a stop: the whole explanation and its hunks, or a quick pass. */
export type StopDepth = "deep" | "skim";
export const STOP_DEPTHS: readonly StopDepth[] = ["deep", "skim"];

/** Why a stop has its depth, as one short tag the overview shows. */
export type StopWhy = "finding" | "risky" | "core" | "routine" | "repeated" | "tests" | "docs";
export const STOP_WHYS: readonly StopWhy[] = [
  "finding",
  "risky",
  "core",
  "routine",
  "repeated",
  "tests",
  "docs",
];

/**
 * One stop of the guided tour, which covers every changed file exactly once (files skipped by
 * design aside, see `SkippedFile`). A deep stop explains one idea next to its hunks; a skim stop
 * groups routine or repeated changes, shows its first file's hunks and lists the others.
 */
export type Stop = {
  depth: StopDepth;
  /** At least one; the first is the primary (deep) or representative (skim) file. */
  files: string[];
  why: StopWhy;
  areaId: string;
  headline: string;
  detail?: string;
  /** 1-3 line ranges in the first file that explain the stop; the tour shows only those hunks. */
  focus?: LineRange[];
  /** One concrete question the reviewer answers at this stop. */
  check?: string;
  /** Skim only: which files differ from the representative, and how. */
  differences?: string;
};

/**
 * A stop as v2 guides stored it before the tour covered every file: one file, no depth. Read as a
 * deep stop on that file (`upgradeStop`), so those guides keep loading.
 */
export type LegacyStop = Omit<Stop, "depth" | "files" | "why" | "differences"> & { file: string };

/** Why a changed file has no stop: nothing in it to review. Decided by the worker, not the agent. */
export type SkipReason = "lockfile" | "generated" | "whitespace" | "rename";
export type SkippedFile = { path: string; reason: SkipReason };
export const SKIP_REASONS: readonly SkipReason[] = [
  "lockfile",
  "generated",
  "whitespace",
  "rename",
];

/** A stored stop in the current shape; a legacy single-file stop becomes a deep stop on it. */
export function upgradeStop(r: Stop | LegacyStop): Stop {
  if ("files" in r && Array.isArray(r.files)) return r;
  const { file, ...rest } = r as LegacyStop;
  return { depth: "deep", files: [file], why: "core", ...rest };
}

/** Most ranges a stop may focus on, so a stop stays one idea. */
export const MAX_FOCUS = 3;

/** What the agent writes. Counts, commit and provenance are filled in by the worker, never trusted from the agent. */
export type AgentGuide = {
  title: string;
  risk: {
    level: RiskLevel;
    headline: string;
    detail?: string;
    /**
     * Steps outside the code review that the merge depends on (a migration, config, a flag, deploy
     * order); empty for most PRs. Generic advice (run the tests, check the screens) is not one.
     */
    beforeMerge: Point[];
  };
  summary: { what: Point; why: Point; impact: Point };
  findings: Finding[];
  areas: { id: string; label: string; question: string; files: string[] }[];
  /** The tour's stops, in order; together they hold every changed file not skipped, once. */
  readingOrder: Stop[];
  /** Every changed non-lockfile file, once. */
  files: { path: string; note: string }[];
  flows: { title: string; before: FlowStep[]; after: FlowStep[] }[];
  claimsCheck: { claim: string; verdict: ClaimVerdict; evidence: string }[];
  sinceLastReview: null | {
    changes: { file: string; headline: string; answersComment: boolean }[];
    riskChanged: boolean;
    openComments: number | null;
  };
};

export type AreaStats = { additions: number; deletions: number };

export type Coverage = {
  /** Files whose whole diff was in the prompt. */
  inPrompt: string[];
  /** Files the agent opened with its tools (Claude Code only; Codex reports no tool calls). */
  readByAgent: string[];
  /** Changed files in neither list. */
  notRead: string[];
};

export type PrGuide = Omit<AgentGuide, "areas" | "sinceLastReview"> & {
  schema: typeof SCHEMA_ID;
  pr: {
    repo: string;
    number: number;
    url: string;
    author: string;
    commit: string;
    baseRef: string;
    headRef: string;
    additions: number;
    deletions: number;
    fileCount: number;
    /** When your review was asked for (ISO), or null when unknown. */
    requestedAt: string | null;
    /** False when the PR body is empty, so there were no claims to check. */
    hasDescription: boolean;
  };
  generatedBy: { harness: string; model: string | null; at: string };
  reviewRequest: ReviewRequest;
  areas: (AgentGuide["areas"][number] & AreaStats)[];
  sinceLastReview:
    | null
    | (NonNullable<AgentGuide["sinceLastReview"]> & { fromCommit: string; toCommit: string });
  /** Null only for a guide upgraded from v1, which did not record it. */
  coverage: Coverage | null;
  /** Lines a review comment may sit on at `pr.commit`, per file, as [first, last] ranges. */
  commentable: Record<string, [number, number][]>;
  /**
   * Changed files with no stop, each with why (lockfiles, generated, whitespace-only, pure
   * renames): the tour's last stop. Worker-filled; guides written before it have none and the tab
   * asks the worker (`skipped.get`).
   */
  skipped?: SkippedFile[];
  /** True when `detail` fields were dropped to fit Orca's storage limit. */
  trimmed?: boolean;
};

/** The v1 file shape, still opened by the guide tab. */
export type PrGuideV1 = {
  schema: typeof SCHEMA_V1;
  title: string;
  risk: { level: RiskLevel; summary: string; beforeMerge: string[] };
  summary: { what: string; why: string; impact: string };
  areas: ({ id: string; label: string; question: string; files: string[] } & AreaStats)[];
  readingOrder: { file: string; area: string; note: string }[];
  flows: AgentGuide["flows"];
  claimsCheck: AgentGuide["claimsCheck"];
  sinceLastReview: null | {
    changes: { file: string; note: string; answersComment: boolean }[];
    riskChanged: boolean;
    openComments: number | null;
    fromCommit: string;
    toCommit: string;
  };
  pr: Omit<PrGuide["pr"], "requestedAt" | "hasDescription">;
  generatedBy: PrGuide["generatedBy"];
  reviewRequest: ReviewRequest;
};

/** Word limits for headlines only; `detail` and file notes are never limited. */
export const WORD_LIMITS = {
  title: 12,
  risk: 20,
  /** What / Why / Impact: one plain sentence each, no detail behind it. */
  summary: 20,
  finding: 20,
  readingOrder: 25,
  check: 20,
} as const;

/** What the worker knows about the diff, for checking references. */
export type DiffContext = {
  /** Changed non-lockfile paths. */
  changed: readonly string[];
  isCommentable: (path: string, line: number) => boolean;
  /**
   * The tour's coverage rules, checked only in the first round (the repair round can fix them;
   * after it the worker enforces them itself, see src/coverage.ts).
   */
  tour?: TourRules;
};

/** What the worker decided before the run: files with no stop, and files that need a deep one. */
export type TourRules = {
  skipped: ReadonlyMap<string, SkipReason>;
  /** Risky files (by kind of change) and the kind's noun, e.g. "dependency file". */
  risky: ReadonlyMap<string, string>;
};

type Problems = string[];

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const wordCount = (text: string): number =>
  text.trim() === "" ? 0 : text.trim().split(/\s+/).length;

function str(p: Problems, v: unknown, path: string, opts: { empty?: boolean } = {}): void {
  if (typeof v !== "string") p.push(`${path}: expected a string`);
  else if (!opts.empty && v.trim() === "") p.push(`${path}: must not be empty`);
}

function optStr(p: Problems, v: unknown, path: string): void {
  if (v !== undefined && v !== null && typeof v !== "string") p.push(`${path}: expected a string`);
}

function num(p: Problems, v: unknown, path: string): void {
  if (typeof v !== "number" || !Number.isFinite(v)) p.push(`${path}: expected a number`);
}

function oneOf(p: Problems, v: unknown, path: string, allowed: readonly string[]): void {
  if (typeof v !== "string" || !allowed.includes(v))
    p.push(`${path}: expected one of ${allowed.join(", ")}`);
}

function arr(
  p: Problems,
  v: unknown,
  path: string,
  each: (item: unknown, path: string) => void,
): void {
  if (!Array.isArray(v)) {
    p.push(`${path}: expected a list`);
    return;
  }
  v.forEach((item, i) => each(item, `${path}[${i}]`));
}

function obj(
  p: Problems,
  v: unknown,
  path: string,
  fields: (o: Record<string, unknown>) => void,
): void {
  if (!isObj(v)) p.push(`${path}: expected an object`);
  else fields(v);
}

function flowSteps(p: Problems, v: unknown, path: string): void {
  arr(p, v, path, (s, sp) =>
    obj(p, s, sp, (o) => {
      str(p, o.label, `${sp}.label`);
      if (o.changed !== undefined && typeof o.changed !== "boolean")
        p.push(`${sp}.changed: expected true or false`);
    }),
  );
}

function flowsAndClaims(p: Problems, g: Record<string, unknown>): void {
  arr(p, g.flows, "flows", (f, fp) =>
    obj(p, f, fp, (o) => {
      str(p, o.title, `${fp}.title`);
      flowSteps(p, o.before, `${fp}.before`);
      flowSteps(p, o.after, `${fp}.after`);
    }),
  );
  arr(p, g.claimsCheck, "claimsCheck", (c, cp) =>
    obj(p, c, cp, (o) => {
      str(p, o.claim, `${cp}.claim`);
      oneOf(p, o.verdict, `${cp}.verdict`, ["matches", "mismatch", "unclear"]);
      str(p, o.evidence, `${cp}.evidence`);
    }),
  );
}

function areaFields(p: Problems, g: Record<string, unknown>, full: boolean): void {
  arr(p, g.areas, "areas", (a, ap) =>
    obj(p, a, ap, (o) => {
      str(p, o.id, `${ap}.id`);
      str(p, o.label, `${ap}.label`);
      str(p, o.question, `${ap}.question`);
      arr(p, o.files, `${ap}.files`, (f, fp) => str(p, f, fp));
      if (full) {
        num(p, o.additions, `${ap}.additions`);
        num(p, o.deletions, `${ap}.deletions`);
      }
    }),
  );
}

/**
 * `full`: a stored guide (worker-filled fields present). `words`: enforce headline limits.
 * `tour`: every stop must carry `focus` and `check` (what the agent is asked for); otherwise they
 * are optional, so older guides and stops whose ranges were dropped still pass.
 */
type Opts = { full: boolean; words: boolean; tour: boolean };

function focusRanges(p: Problems, v: unknown, path: string): void {
  if (!Array.isArray(v)) {
    p.push(`${path}: expected a list of { start, end } line ranges`);
    return;
  }
  if (v.length < 1 || v.length > MAX_FOCUS)
    p.push(`${path}: give 1 to ${MAX_FOCUS} ranges, not ${v.length}`);
  v.forEach((r, i) =>
    obj(p, r, `${path}[${i}]`, (x) => {
      const ok = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n > 0;
      if (!ok(x.start) || !ok(x.end))
        p.push(`${path}[${i}]: start and end must be PR-head line numbers`);
      else if ((x.start as number) > (x.end as number))
        p.push(`${path}[${i}]: start ${x.start} is after end ${x.end}`);
    }),
  );
}

function headline(
  p: Problems,
  v: unknown,
  path: string,
  limit: number | null,
  o: Opts,
  fix = "move the rest into detail",
): void {
  str(p, v, path);
  if (o.words && limit !== null && typeof v === "string" && wordCount(v) > limit)
    p.push(`${path}: ${wordCount(v)} words, the limit is ${limit}; ${fix}`);
}

function point(p: Problems, v: unknown, path: string, limit: number | null, o: Opts): void {
  obj(p, v, path, (pt) => {
    headline(p, pt.headline, `${path}.headline`, limit, o);
    optStr(p, pt.detail, `${path}.detail`);
  });
}

function contentV2(p: Problems, g: Record<string, unknown>, o: Opts): void {
  headline(p, g.title, "title", WORD_LIMITS.title, o);
  obj(p, g.risk, "risk", (r) => {
    oneOf(p, r.level, "risk.level", ["low", "medium", "high"]);
    headline(p, r.headline, "risk.headline", WORD_LIMITS.risk, o);
    optStr(p, r.detail, "risk.detail");
    arr(p, r.beforeMerge, "risk.beforeMerge", (s, sp) => point(p, s, sp, null, o));
  });
  obj(p, g.summary, "summary", (s) => {
    // Headline only: the agent is asked for no detail here, but guides written before still carry
    // one, so it stays allowed (the overview doesn't show it).
    for (const k of ["what", "why", "impact"])
      obj(p, s[k], `summary.${k}`, (pt) => {
        headline(
          p,
          pt.headline,
          `summary.${k}.headline`,
          WORD_LIMITS.summary,
          o,
          "keep it to one plain sentence; specifics belong in findings and stops",
        );
        optStr(p, pt.detail, `summary.${k}.detail`);
      });
  });
  const ids = new Set<string>();
  arr(p, g.findings, "findings", (f, fp) =>
    obj(p, f, fp, (x) => {
      str(p, x.id, `${fp}.id`);
      if (typeof x.id === "string") {
        if (ids.has(x.id)) p.push(`${fp}.id: "${x.id}" is used twice`);
        ids.add(x.id);
      }
      oneOf(p, x.severity, `${fp}.severity`, SEVERITIES);
      str(p, x.file, `${fp}.file`);
      if (x.line !== null && (typeof x.line !== "number" || !Number.isInteger(x.line)))
        p.push(`${fp}.line: expected a whole number or null`);
      headline(p, x.headline, `${fp}.headline`, WORD_LIMITS.finding, o);
      str(p, x.detail, `${fp}.detail`, { empty: true });
      if (x.suggestedComment !== null) str(p, x.suggestedComment, `${fp}.suggestedComment`);
    }),
  );
  areaFields(p, g, o.full);
  arr(p, g.readingOrder, "readingOrder", (r, rp) =>
    obj(p, r, rp, (x) => {
      // A stored guide may hold stops from before full coverage: one `file`, read as a deep stop.
      const legacy = o.full && x.files === undefined && typeof x.file === "string";
      if (!legacy) {
        // After the repair round a missing depth or tag is filled in by `settle`, not fatal.
        const strict = o.tour || o.full;
        if (strict || x.depth !== undefined) oneOf(p, x.depth, `${rp}.depth`, STOP_DEPTHS);
        if (strict || x.why !== undefined) oneOf(p, x.why, `${rp}.why`, STOP_WHYS);
        if (!Array.isArray(x.files) || x.files.length === 0)
          p.push(`${rp}.files: expected a list of at least one changed path`);
        else x.files.forEach((f, i) => str(p, f, `${rp}.files[${i}]`));
        optStr(p, x.differences, `${rp}.differences`);
      }
      str(p, x.areaId, `${rp}.areaId`);
      headline(p, x.headline, `${rp}.headline`, WORD_LIMITS.readingOrder, o);
      optStr(p, x.detail, `${rp}.detail`);
      // The agent must send focus on every stop and a check on deep ones; a stored guide is
      // checked only for what it has, so the tab can trust the shape. In between (after the
      // repair round) `settle` cleans them up instead.
      if (o.tour || (o.full && x.focus !== undefined)) focusRanges(p, x.focus, `${rp}.focus`);
      if ((o.tour && x.depth !== "skim") || (o.full && x.check !== undefined))
        headline(p, x.check, `${rp}.check`, WORD_LIMITS.check, o);
      else if (x.check !== undefined) optStr(p, x.check, `${rp}.check`);
    }),
  );
  arr(p, g.files, "files", (f, fp) =>
    obj(p, f, fp, (x) => {
      str(p, x.path, `${fp}.path`);
      str(p, x.note, `${fp}.note`);
    }),
  );
  flowsAndClaims(p, g);
  if (g.sinceLastReview !== null && g.sinceLastReview !== undefined) {
    obj(p, g.sinceLastReview, "sinceLastReview", (s) => {
      arr(p, s.changes, "sinceLastReview.changes", (c, cp) =>
        obj(p, c, cp, (x) => {
          str(p, x.file, `${cp}.file`);
          str(p, x.headline, `${cp}.headline`);
          if (typeof x.answersComment !== "boolean")
            p.push(`${cp}.answersComment: expected true or false`);
        }),
      );
      if (typeof s.riskChanged !== "boolean")
        p.push("sinceLastReview.riskChanged: expected true or false");
      if (s.openComments !== null && s.openComments !== undefined)
        num(p, s.openComments, "sinceLastReview.openComments");
      if (o.full) {
        str(p, s.fromCommit, "sinceLastReview.fromCommit");
        str(p, s.toCommit, "sinceLastReview.toCommit");
      }
    });
  }
}

/** Files, lines and area ids the guide points at must exist in this PR's diff. */
function references(p: Problems, g: AgentGuide, ctx: DiffContext): void {
  const changed = new Set(ctx.changed);
  const known = (file: string, path: string) => {
    if (!changed.has(file)) p.push(`${path}: "${file}" is not a changed file in this PR`);
    return changed.has(file);
  };
  g.findings.forEach((f, i) => {
    if (
      known(f.file, `findings[${i}].file`) &&
      f.line !== null &&
      !ctx.isCommentable(f.file, f.line)
    )
      p.push(
        `findings[${i}].line: ${f.line} is not an added or context line of ${f.file} in the diff; use a line from a hunk, or null`,
      );
  });
  const areaIds = new Set(g.areas.map((a) => a.id));
  g.readingOrder.forEach((r, i) => {
    // A skipped file (a lockfile is not even in `changed`) gets its own message below.
    const ok = r.files.map(
      (f, j) => !ctx.tour?.skipped.has(f) && known(f, `readingOrder[${i}].files[${j}]`),
    );
    if (!areaIds.has(r.areaId))
      p.push(`readingOrder[${i}].areaId: "${r.areaId}" is not one of the areas' ids`);
    if (ok[0])
      (r.focus ?? []).forEach((range, j) => {
        if (!overlapsDiff(ctx, r.files[0], range))
          p.push(
            `readingOrder[${i}].focus[${j}]: lines ${range.start}-${range.end} are not in the diff of ${r.files[0]} (the stop's first file); use "+" side lines from its hunks`,
          );
      });
  });
  if (ctx.tour) p.push(...tourCoverageProblems(g, ctx.changed, ctx.tour));
  g.areas.forEach((a, i) => a.files.forEach((f, j) => known(f, `areas[${i}].files[${j}]`)));
  const noted = new Map<string, number>();
  g.files.forEach((f, i) => {
    if (known(f.path, `files[${i}].path`)) noted.set(f.path, (noted.get(f.path) ?? 0) + 1);
  });
  for (const path of ctx.changed) {
    const n = noted.get(path) ?? 0;
    if (n === 0) p.push(`files: "${path}" is missing; every changed file needs a note`);
    else if (n > 1) p.push(`files: "${path}" is listed ${n} times; list each file once`);
  }
}

/** Findings severe enough that their file needs a deep stop. */
export const DEEP_SEVERITIES: readonly Severity[] = ["blocker", "major"];

/**
 * The tour's coverage rules as repair-round problems: every changed file not skipped in exactly
 * one stop, skipped files in none, and risky files and files with a blocker or major finding in
 * a deep stop.
 */
export function tourCoverageProblems(
  g: Pick<AgentGuide, "readingOrder" | "findings">,
  changed: readonly string[],
  rules: TourRules,
): string[] {
  const p: string[] = [];
  const severe = new Set(
    g.findings.filter((f) => DEEP_SEVERITIES.includes(f.severity)).map((f) => f.file),
  );
  const first = new Map<string, number>();
  g.readingOrder.forEach((r, i) =>
    r.files.forEach((f) => {
      const reason = rules.skipped.get(f);
      if (reason) {
        p.push(
          `readingOrder[${i}].files: "${f}" is skipped by design (${reason}); leave it out of every stop`,
        );
        return;
      }
      const at = first.get(f);
      if (at !== undefined)
        p.push(
          `readingOrder[${i}].files: "${f}" is already in readingOrder[${at}]; put each file in exactly one stop`,
        );
      else first.set(f, i);
      if (r.depth === "skim" && severe.has(f))
        p.push(
          `readingOrder[${i}]: "${f}" has a blocker or major finding; give it a deep stop of its own`,
        );
      else if (r.depth === "skim" && rules.risky.has(f))
        p.push(
          `readingOrder[${i}]: "${f}" is a ${rules.risky.get(f)}; give it a deep stop of its own`,
        );
    }),
  );
  for (const f of changed)
    if (!first.has(f) && !rules.skipped.has(f))
      p.push(
        `readingOrder: "${f}" is in no stop; every changed file goes in exactly one stop (group routine ones into a skim stop)`,
      );
  return p;
}

/** Longest range checked line by line; a wider one only needs to start inside the file's hunks. */
const RANGE_SCAN = 5_000;

/** Whether any line of `range` is an added or context line of `file` in the diff. */
export function overlapsDiff(ctx: DiffContext, file: string, range: LineRange): boolean {
  const end = Math.min(range.end, range.start + RANGE_SCAN);
  for (let n = range.start; n <= end; n++) if (ctx.isCommentable(file, n)) return true;
  return false;
}

/**
 * Problems with what the agent wrote, as `path: reason` lines; empty when it is usable. With a
 * diff context it also checks references and coverage; `words: false` skips the headline limits.
 */
export function checkAgentGuide(
  value: unknown,
  ctx?: DiffContext,
  opts: { words?: boolean; tour?: boolean } = {},
): Problems {
  const p: Problems = [];
  if (!isObj(value)) return ["(root): expected a JSON object"];
  contentV2(p, value, { full: false, words: opts.words !== false, tour: opts.tour !== false });
  if (ctx && p.length === 0) references(p, value as AgentGuide, ctx);
  return p;
}

/**
 * Deterministic fixes for what a repair round could not get right: a finding line outside the
 * diff becomes a whole-file finding, a file with no note gets a placeholder, a duplicate note is
 * dropped, a focus range that is malformed or outside the diff is dropped (a stop left with none
 * shows its whole file), and a missing check is left out. Returns what changed, for the log.
 */
export function settle(g: AgentGuide, ctx: DiffContext): { guide: AgentGuide; fixed: string[] } {
  const fixed: string[] = [];
  const readingOrder = g.readingOrder.flatMap((r, i) => {
    const {
      focus: rawFocus,
      check: rawCheck,
      ...rest
    } = r as Stop & {
      focus?: unknown;
      check?: unknown;
    };
    // Files this PR doesn't change (or that git leaves out, like lockfiles) leave the stop.
    const files = r.files.filter((f) => ctx.changed.includes(f));
    if (files.length < r.files.length)
      fixed.push(
        `readingOrder[${i}]: dropped ${r.files.filter((f) => !files.includes(f)).join(", ")}, not changed files`,
      );
    if (!files.length) return [];
    const depth: StopDepth = rest.depth ?? "deep";
    const stop: Stop = {
      ...rest,
      files,
      depth,
      why: rest.why ?? (depth === "skim" ? "routine" : "core"),
    };
    const primary = files[0];
    // Focus is on the first file: when that one left, so does its focus.
    const raw: unknown[] = Array.isArray(rawFocus) && primary === r.files[0] ? rawFocus : [];
    const focus = raw
      .filter(
        (x): x is LineRange =>
          isObj(x) &&
          Number.isInteger(x.start) &&
          Number.isInteger(x.end) &&
          (x.start as number) > 0 &&
          (x.start as number) <= (x.end as number) &&
          overlapsDiff(ctx, primary, x as LineRange),
      )
      .slice(0, MAX_FOCUS)
      .map(({ start, end }) => ({ start, end }));
    if (raw.length > focus.length || (rawFocus !== undefined && !Array.isArray(rawFocus)))
      fixed.push(
        `readingOrder[${i}] ${primary}: kept ${focus.length} of ${raw.length} focus ranges${focus.length ? "" : ", shows the whole file"}`,
      );
    else if (rawFocus === undefined) fixed.push(`readingOrder[${i}] ${primary}: no focus ranges`);
    if (focus.length) stop.focus = focus;
    if (typeof rawCheck === "string" && rawCheck.trim()) stop.check = rawCheck;
    else if (depth !== "skim") fixed.push(`readingOrder[${i}] ${primary}: no check question`);
    return [stop];
  });
  const findings = g.findings.map((f) => {
    if (f.line !== null && !ctx.isCommentable(f.file, f.line)) {
      fixed.push(`${f.id}: line ${f.line} is outside the diff, kept as a file comment`);
      return { ...f, line: null };
    }
    return f;
  });
  const seen = new Set<string>();
  const files = g.files.filter((f) => {
    if (seen.has(f.path) || !ctx.changed.includes(f.path)) return false;
    seen.add(f.path);
    return true;
  });
  for (const path of ctx.changed) {
    if (seen.has(path)) continue;
    fixed.push(`${path}: no note from the agent`);
    files.push({ path, note: "No note from the agent." });
  }
  return { guide: { ...g, findings, readingOrder, files }, fixed };
}

function checkV1(p: Problems, g: Record<string, unknown>): void {
  str(p, g.title, "title");
  obj(p, g.risk, "risk", (r) => {
    oneOf(p, r.level, "risk.level", ["low", "medium", "high"]);
    str(p, r.summary, "risk.summary");
    arr(p, r.beforeMerge, "risk.beforeMerge", (s, sp) => str(p, s, sp));
  });
  obj(p, g.summary, "summary", (s) => {
    str(p, s.what, "summary.what");
    str(p, s.why, "summary.why");
    str(p, s.impact, "summary.impact");
  });
  areaFields(p, g, true);
  arr(p, g.readingOrder, "readingOrder", (r, rp) =>
    obj(p, r, rp, (o) => {
      str(p, o.file, `${rp}.file`);
      str(p, o.area, `${rp}.area`, { empty: true });
      str(p, o.note, `${rp}.note`);
    }),
  );
  flowsAndClaims(p, g);
}

function prFields(p: Problems, value: Record<string, unknown>): void {
  obj(p, value.pr, "pr", (pr) => {
    str(p, pr.repo, "pr.repo");
    num(p, pr.number, "pr.number");
    str(p, pr.url, "pr.url");
    str(p, pr.author, "pr.author", { empty: true });
    str(p, pr.commit, "pr.commit");
    str(p, pr.baseRef, "pr.baseRef", { empty: true });
    str(p, pr.headRef, "pr.headRef", { empty: true });
    num(p, pr.additions, "pr.additions");
    num(p, pr.deletions, "pr.deletions");
    num(p, pr.fileCount, "pr.fileCount");
  });
  obj(p, value.generatedBy, "generatedBy", (g) => {
    str(p, g.harness, "generatedBy.harness");
    str(p, g.at, "generatedBy.at");
  });
  oneOf(p, value.reviewRequest, "reviewRequest", ["user", "team", "authored", "manual"]);
}

/** Problems with a whole guide file, v1 or v2; empty when the editor can draw it. */
export function checkGuide(value: unknown): Problems {
  const p: Problems = [];
  if (!isObj(value)) return ["(root): expected a JSON object"];
  if (value.schema !== SCHEMA_ID && value.schema !== SCHEMA_V1)
    return [`schema: expected "${SCHEMA_ID}"`];
  prFields(p, value);
  if (value.schema === SCHEMA_V1) {
    checkV1(p, value);
    return p;
  }
  // Headline limits are the agent's job; a stored guide that ran long still draws.
  contentV2(p, value, { full: true, words: false, tour: false });
  if (!isObj(value.commentable)) p.push("commentable: expected an object");
  return p;
}

/** A v1 guide in the v2 shape, so the guide tab has one way to draw. */
export function upgradeV1(g: PrGuideV1): PrGuide {
  const byLabel = new Map(g.areas.map((a) => [a.label, a.id]));
  return {
    schema: SCHEMA_ID,
    title: g.title,
    risk: {
      level: g.risk.level,
      headline: g.risk.summary,
      beforeMerge: g.risk.beforeMerge.map((s) => ({ headline: s })),
    },
    summary: {
      what: { headline: g.summary.what },
      why: { headline: g.summary.why },
      impact: { headline: g.summary.impact },
    },
    findings: [],
    areas: g.areas,
    readingOrder: g.readingOrder.map((r) => ({
      depth: "deep",
      files: [r.file],
      why: "core",
      areaId: byLabel.get(r.area) ?? r.area,
      headline: r.note,
    })),
    files: [],
    flows: g.flows,
    claimsCheck: g.claimsCheck,
    sinceLastReview: g.sinceLastReview
      ? {
          ...g.sinceLastReview,
          changes: g.sinceLastReview.changes.map((c) => ({
            file: c.file,
            headline: c.note,
            answersComment: c.answersComment,
          })),
        }
      : null,
    pr: { ...g.pr, requestedAt: null, hasDescription: true },
    generatedBy: g.generatedBy,
    reviewRequest: g.reviewRequest,
    coverage: null,
    commentable: {},
  };
}

/** A stored v2 guide in the current shape: stops written before full coverage become deep stops. */
export function upgradeGuide(g: PrGuide): PrGuide {
  const stops = g.readingOrder as (Stop | LegacyStop)[];
  if (stops.every((r) => "files" in r)) return g;
  return { ...g, readingOrder: stops.map(upgradeStop) };
}

/** The risk line of either version, for the queue and notifications. */
export function riskHeadline(g: PrGuide | PrGuideV1): string {
  return g.schema === SCHEMA_V1 ? g.risk.summary : g.risk.headline;
}

/** Drops every `detail` field, for a guide too big for one storage value. */
export function withoutDetail(g: PrGuide): PrGuide {
  const strip = <T extends { detail?: string }>(x: T): T => {
    const { detail: _, ...rest } = x;
    return rest as T;
  };
  return {
    ...g,
    risk: { ...strip(g.risk), beforeMerge: g.risk.beforeMerge.map(strip) },
    summary: {
      what: strip(g.summary.what),
      why: strip(g.summary.why),
      impact: strip(g.summary.impact),
    },
    findings: g.findings.map((f) => ({ ...f, detail: "" })),
    readingOrder: g.readingOrder.map(strip),
    trimmed: true,
  };
}

/** The JSON object in an agent's reply: the whole reply, a fenced block, or the outermost braces. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence) candidates.push(fence[1].trim());
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try the next shape
    }
  }
  throw new Error("the agent did not reply with a JSON object");
}
