// One agent run for one PR: fetch it, decide what the tour skips, build the prompt, ask the agent
// (once more if its reply does not fit), and fill in everything the agent is never trusted with.
import { runAgent } from "./agent";
import { enforceCoverage } from "./coverage";
import {
  budgetDiff,
  coverage,
  filesReadByAgent,
  toRanges,
  type FileDiff,
  type ToolCall,
} from "./diff";
import { message } from "./errors";
import {
  diffUpTo,
  fetchPr,
  hasCommit,
  hideGuideFolder,
  LOCKFILE_EXCLUDES,
  logBetween,
  prFiles,
  type Clone,
  type PrRefs,
} from "./git";
import { watchGit } from "./git-guard";
import { myReviewComments, type PrDetails } from "./github";
import type { PrPlace, Triage } from "./pr-data";
import { buildPrompt, buildRepairPrompt, type SinceInput } from "./prompt";
import { removeRunFiles, writeRunFiles, type RunFiles } from "./run-files";
import {
  extractJson,
  parseAgentGuide,
  SCHEMA_ID,
  settle,
  type AgentGuide,
  type Checked,
  type DiffContext,
  type PrGuide,
  type ReviewRequest,
  type SkippedFile,
  type TourRules,
} from "./schema";
import { findSecret } from "./secrets";
import type { Settings } from "./settings";

const SINCE_DIFF_LIMIT = 60_000;

export type GuideRequest = {
  key: string;
  repo: string;
  clone: Clone;
  pr: PrDetails;
  settings: Pick<Settings, "harness" | "model" | "extraInstructions">;
  /** How the review was asked for; "manual" for a PR that is not in the queue. */
  reviewRequest: ReviewRequest;
  /** When the review was asked for (ms), or null when the PR is not in the queue. */
  requestedAt: number | null;
  /** The commit the reviewer last saw, for "Since your last review"; asked once the PR is fetched. */
  lastViewedCommit: () => Promise<string | undefined>;
  triage: (at: PrPlace, commit: string, baseRef: string) => Promise<Triage>;
  log: (text: string) => void;
};

/** What changed since the commit the reviewer last saw; null when that is the head, or gone. */
async function sinceInput(req: GuideRequest, head: string): Promise<SinceInput | null> {
  const { clone, pr } = req;
  const from = await req.lastViewedCommit();
  if (!from || from === pr.headRefOid) return null;
  // Force-pushed away: the whole guide is new anyway.
  if (!(await hasCommit(clone.path, from))) return null;
  const [log, diff, comments] = await Promise.all([
    logBetween(clone.path, from, head),
    diffUpTo(clone.path, [from, head, "--", ".", ...LOCKFILE_EXCLUDES], SINCE_DIFF_LIMIT),
    myReviewComments(req.repo, pr.number).catch(() => []),
  ]);
  return { fromCommit: from, toCommit: pr.headRefOid, log, diff, comments };
}

/** Area counts from the diff itself (lockfiles left out), with ungrouped files under Other. */
export function areasWithStats(
  areas: AgentGuide["areas"],
  changed: readonly FileDiff[],
): PrGuide["areas"] {
  const byPath = new Map(changed.map((f) => [f.path, f]));
  const seen = new Set<string>();
  const sum = (files: readonly string[], count: (f: FileDiff) => number) =>
    files.reduce((n, path) => {
      const file = byPath.get(path);
      return file ? n + count(file) : n;
    }, 0);
  const counted = areas.map((area) => {
    const files = area.files.filter((f) => byPath.has(f) && !seen.has(f));
    for (const f of files) seen.add(f);
    return {
      ...area,
      files,
      additions: sum(files, (f) => f.additions),
      deletions: sum(files, (f) => f.deletions),
    };
  });
  const rest = changed.filter((f) => !seen.has(f.path)).map((f) => f.path);
  if (rest.length) {
    counted.push({
      id: "other",
      label: "Other",
      question: "Not grouped by the agent",
      files: rest,
      additions: sum(rest, (f) => f.additions),
      deletions: sum(rest, (f) => f.deletions),
    });
  }
  return counted.filter((a) => a.files.length > 0);
}

/** The reply as a guide checked against the diff, or why it is not one. */
function readReply(reply: string, ctx: DiffContext): Checked<AgentGuide> {
  try {
    return parseAgentGuide(extractJson(reply), ctx);
  } catch (e) {
    return { ok: false, problems: [message(e)] };
  }
}

const mismatch = (problems: readonly string[]) =>
  new Error(`The agent's guide did not match prguide v2: ${problems.slice(0, 3).join("; ")}`);

/**
 * Asks the agent, and once more when its reply does not match. After that second round, long
 * headlines are tolerated and lines outside the diff or missing file notes are settled here;
 * anything else still fails the run.
 */
async function askAgent(
  req: GuideRequest,
  prompt: string,
  ctx: DiffContext,
): Promise<{ guide: AgentGuide; toolCalls: ToolCall[] }> {
  const { harness, model } = req.settings;
  const first = await runAgent(harness, model, prompt, req.clone.path);
  const firstRead = readReply(first.text, ctx);
  if (firstRead.ok) return { guide: firstRead.guide, toolCalls: first.toolCalls };
  req.log(
    `${req.key}: reply did not match prguide v2 (${firstRead.problems.slice(0, 3).join("; ")}), asking once more`,
  );
  const second = await runAgent(
    harness,
    model,
    buildRepairPrompt(prompt, first.text, firstRead.problems),
    req.clone.path,
  );
  const loose = parseAgentGuide(extractJson(second.text), undefined, { words: false, tour: false });
  if (!loose.ok) throw mismatch(loose.problems);
  const settled = settle(loose.guide, ctx);
  if (settled.fixed.length) req.log(`${req.key}: settled ${settled.fixed.join("; ")}`);
  // Coverage is no longer the agent's to fix: the caller enforces it.
  const { tour: _, ...withoutTour } = ctx;
  const final = parseAgentGuide(settled.guide, withoutTour, { words: false, tour: false });
  if (!final.ok) throw mismatch(final.problems);
  return { guide: final.guide, toolCalls: [...first.toolCalls, ...second.toolCalls] };
}

function logReady(req: GuideRequest, guide: PrGuide, started: number): void {
  const stops = guide.readingOrder;
  const deep = stops.filter((r) => r.depth === "deep").length;
  const focused = stops.filter((r) => r.focus?.length);
  const ranges = focused.reduce((n, r) => n + (r.focus?.length ?? 0), 0);
  req.log(
    `${req.key}: guide ready in ${Math.round((Date.now() - started) / 1000)} s (${guide.risk.level} risk, ${guide.findings.length} findings, ${stops.length} stops: ${deep} deep, ${stops.length - deep} skim; ${guide.skipped?.length ?? 0} skipped; ${focused.length} with focus, ${ranges} ranges) · ${stops.map((r, i) => `${i + 1} ${r.depth} ${r.why} ${r.files.length}f`).join(", ")}`,
  );
}

/** What the worker knows about the run, for the fields the agent is never trusted with. */
type Facts = {
  files: readonly FileDiff[];
  lines: ReadonlyMap<string, Set<number>>;
  since: SinceInput | null;
  /** Paths whose whole diff was in the prompt. */
  inPrompt: string[];
  toolCalls: readonly ToolCall[];
  /** The run's prepared files, to the PR path each holds. */
  prepared: ReadonlyMap<string, string>;
  skipped: SkippedFile[];
};

/** The agent's guide with counts, commit, provenance, coverage and comment lines filled in. */
function withFacts(req: GuideRequest, agent: AgentGuide, facts: Facts): PrGuide {
  const { repo, pr, settings } = req;
  const { since } = facts;
  const changed = facts.files.map((f) => f.path);
  return {
    schema: SCHEMA_ID,
    ...agent,
    pr: {
      repo,
      number: pr.number,
      url: pr.url,
      author: pr.author,
      commit: pr.headRefOid,
      baseRef: pr.baseRefName,
      headRef: pr.headRefName,
      additions: pr.additions,
      deletions: pr.deletions,
      fileCount: pr.changedFiles,
      requestedAt: req.requestedAt === null ? null : new Date(req.requestedAt).toISOString(),
      hasDescription: pr.body.trim() !== "",
    },
    generatedBy: {
      harness: settings.harness,
      model: settings.model || null,
      at: new Date().toISOString(),
    },
    reviewRequest: req.reviewRequest,
    areas: areasWithStats(agent.areas, facts.files),
    sinceLastReview:
      since && agent.sinceLastReview
        ? { ...agent.sinceLastReview, fromCommit: since.fromCommit, toCommit: since.toCommit }
        : null,
    coverage: coverage(
      changed,
      facts.inPrompt,
      filesReadByAgent(facts.toolCalls, changed, req.clone.path, facts.prepared),
    ),
    commentable: Object.fromEntries(
      changed.map((f) => [f, toRanges(facts.lines.get(f) ?? new Set())]),
    ),
    skipped: facts.skipped,
  };
}

/** Whatever is stored may be opened, shared or quoted into a review: no credentials in it. */
function refuseSecrets(guide: PrGuide): void {
  const secret = findSecret(JSON.stringify(guide));
  if (secret)
    throw new Error(
      `The agent's reply holds what looks like ${secret}, so the guide was not stored.`,
    );
}

/** Fetches the PR, runs the agent and returns the finished guide; throws when the run fails. */
export async function writeGuide(req: GuideRequest): Promise<PrGuide> {
  const { clone, pr } = req;
  const refs = await fetchPr(clone, pr);
  try {
    return await runWithFiles(req, refs);
  } finally {
    // Success, failure or a stopped run: the PR's files never outlive it.
    await removeRunFiles(clone.path, pr.number).catch((e: unknown) =>
      req.log(`${req.key}: could not remove the run's files: ${message(e)}`),
    );
  }
}

/** What the agent would otherwise fetch with git: the PR's files and the diffs left out. */
async function prepareRun(
  req: GuideRequest,
  refs: PrRefs,
  files: readonly FileDiff[],
  outside: readonly FileDiff[],
  skipped: readonly SkippedFile[],
): Promise<RunFiles> {
  await hideGuideFolder(req.clone.path).catch((e: unknown) =>
    req.log(`could not add .pr-tour/ to git's exclude list: ${message(e)}`),
  );
  return writeRunFiles({
    cwd: req.clone.path,
    pr: req.pr.number,
    headRef: refs.head,
    files,
    outside,
    skipped: new Set(skipped.map((f) => f.path)),
  });
}

async function runWithFiles(req: GuideRequest, refs: PrRefs): Promise<PrGuide> {
  const { key, repo, clone, pr, settings } = req;
  const { files, lines, ctx: base } = await prFiles(clone.path, refs);
  const changed = base.changed;
  // Decided before the run, so the agent spends no stop on them and can't skim a risky file.
  const triage = await req.triage({ cwd: clone.path, repo, key }, pr.headRefOid, refs.base);
  const rules: TourRules = {
    skipped: new Map(triage.skipped.map((f) => [f.path, f.reason])),
    risky: new Map([...triage.risky].filter(([path]) => changed.includes(path))),
  };
  const budget = budgetDiff(files);
  const since = await sinceInput(req, refs.head);
  const run = await prepareRun(req, refs, files, budget.outside, triage.skipped);
  const prompt = buildPrompt({
    repo,
    pr,
    inPrompt: budget.inPrompt,
    outside: budget.outside,
    since,
    extraInstructions: settings.extraInstructions,
    run,
    skipped: triage.skipped,
    risky: rules.risky,
  });
  req.log(
    `generating ${key} at ${pr.headRefOid.slice(0, 7)} with ${settings.harness}${settings.model ? ` (${settings.model})` : ""}; skipped by design: ${triage.skipped.map((f) => `${f.path} (${f.reason})`).join(", ") || "none"}; must be deep: ${[...rules.risky.keys()].join(", ") || "none"}`,
  );
  const started = Date.now();
  // A run that changed the clone's git config or hooks stores nothing (GitTampered).
  const { guide: replied, toolCalls } = await watchGit(clone.path, () =>
    askAgent(req, prompt, { ...base, tour: rules }),
  );
  const covered = enforceCoverage(replied.readingOrder, changed, replied.findings, rules);
  if (covered.fixed.length) req.log(`${key}: coverage: ${covered.fixed.join("; ")}`);
  const guide = withFacts(
    req,
    { ...replied, readingOrder: covered.stops },
    {
      files,
      lines,
      since,
      inPrompt: budget.inPrompt.map((f) => f.path),
      toolCalls,
      prepared: run.byPrepared,
      skipped: triage.skipped,
    },
  );
  refuseSecrets(guide);
  logReady(req, guide, started);
  return guide;
}
