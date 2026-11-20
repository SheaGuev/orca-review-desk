// The plugin's worker: finds the PRs waiting for your review, has an agent write a guide for each,
// keeps them current as authors push, and opens them in Orca. The status bar item keeps it
// running while the plugin is enabled, so it can poll.
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { JsonValue, OrcaWorkerApi } from "orca/worker";
import { asHarness, runAgent } from "./agent";
import { buildBreakdown, type Breakdown } from "./breakdown/assemble";
import type { Ecosystem } from "./breakdown/categories";
import {
  createClassifier,
  detectEcosystems,
  parseOverrides,
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
import type { Classifier } from "./breakdown/classify";
import { enforceCoverage, fullTour } from "./coverage";
import {
  budgetDiff,
  commentableLines,
  coverage,
  inRanges,
  filesReadByAgent,
  splitDiff,
  toRanges,
  type FileDiff,
  type ToolCall,
} from "./diff";
import { fileDiffView, type DiffFile } from "./diff-model";
import { loadLoginPath, run, runOk } from "./exec";
import {
  canonicalRepo,
  currentLogin,
  myReviewComments,
  prDetails,
  requestTimes,
  searchPrs,
  type PrDetails,
  type SearchHit,
} from "./github";
import { buildPrompt, buildRepairPrompt, type SinceInput } from "./prompt";
import type {
  ItemStatus,
  Lane,
  Notice,
  QueueItem,
  QueueState,
  RepoState,
  ReviewInfo,
  ReviewSubmitResult,
} from "./protocol";
import { buildQueue } from "./queue";
import {
  asDraft,
  fileCommentPayloads,
  reviewPayload,
  reviewProblem,
  staleComments,
  type Draft,
  type DraftComment,
  type ReviewEvent,
} from "./review";
import {
  countOwnedFiles,
  isLockfileOnly,
  parseCodeowners,
  parseTeams,
  repoSlugFromRemote,
} from "./repo";
import { stopCount, tourKey, tourLabel, tourState, type TourShape, type TourState } from "./tour";
import { riskyFiles, skippedFiles } from "./triage";
import {
  checkAgentGuide,
  extractJson,
  riskHeadline,
  SCHEMA_ID,
  settle,
  upgradeGuide,
  withoutDetail,
  type AgentGuide,
  type DiffContext,
  type PrGuide,
  type PrGuideV1,
  type ReviewRequest,
  type SkippedFile,
  type TourRules,
} from "./schema";

const POLL_MS = 5 * 60_000;
/** Orca refuses a storage value over 256 KiB; leave room for the key and encoding. */
const GUIDE_STORAGE_LIMIT = 250_000;
/** After an author pushes, wait this long for more pushes before updating the guide. */
const SETTLE_MS = 90_000;
const MAX_PRS = 40;
const SINCE_DIFF_LIMIT = 60_000;
/** File diffs the guide tab asked for, kept in memory; dropped all at once past this many. */
const DIFF_CACHE_LIMIT = 300;
/** Changes breakdowns (and the ecosystems behind them) kept in memory; dropped all at once past this. */
const BREAKDOWN_CACHE_LIMIT = 50;
const COMMIT = /^[0-9a-f]{7,64}$/i;
const LOCKFILE_EXCLUDES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "uv.lock",
  "Gemfile.lock",
  "composer.lock",
].map((f) => `:(exclude,glob)**/${f}`);

type Settings = {
  harness: "claude" | "codex";
  model: string;
  autoRequested: boolean;
  teams: string[];
  autoTeams: boolean;
  teamRequireOwnership: boolean;
  teamMinLines: number;
  includeAuthored: boolean;
  skipDrafts: boolean;
  dailyLimit: number;
  extraInstructions: string;
};

type Meta = { lastViewedCommit?: string; error?: string; errorCommit?: string };
type Clone = { path: string; projectId: string };
type Tracked = { item: QueueItem; details: PrDetails; clone: Clone | null; auto: boolean };

let stopTimers: () => void = () => {};

/** Clears the poll and settle timers before Orca stops the worker. */
export function deactivate(): void {
  stopTimers();
}

const keyOf = (repo: string, number: number) => `${repo}#${number}`;
/** The local date, so the daily limit resets at the person's midnight, not UTC's. */
export const localDay = (at = new Date()) => at.toLocaleDateString("en-CA");
const today = () => localDay();
const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
/** Errors from the agent CLI that mean it has no working sign-in. */
const SIGNED_OUT =
  /not logged in|log ?in required|please (run )?\/?login|not signed in|invalid api key|authenticat/i;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  const tracked = new Map<string, Tracked>();
  const repos = new Map<string, RepoState>();
  const generating = new Set<string>();
  const queued: string[] = [];
  const firstSeen = new Map<string, { sha: string; at: number }>();
  /** Guides started from a command open themselves when they are written. */
  const openWhenReady = new Set<string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let checking: Promise<void> | null = null;
  let checkedAt: number | null = null;
  let lastError: string | null = null;
  /** The last agent run failed for want of a sign-in; cleared by the next run that works. */
  let agentSignedOut = false;
  /** Review-request times per PR head, so GitHub is asked again only after a push. */
  const requestedCache = new Map<string, { head: string; at: number }>();
  let settings = await readSettings();
  let runsToday = await readRuns();
  let focused: { workspaceId?: string; branch: string } | null = null;
  /** QueueState.openKey: the guide last opened or moved through. */
  let openKey: string | null = null;

  // ---------------------------------------------------------------- settings and storage

  async function readSettings(): Promise<Settings> {
    const s = await orca.settings.get();
    return {
      harness: asHarness(s.harness),
      model: typeof s.model === "string" ? s.model : "",
      autoRequested: s.autoRequested !== false,
      teams: parseTeams(s.teams),
      autoTeams: s.autoTeams !== false,
      teamRequireOwnership: s.teamRequireOwnership !== false,
      teamMinLines: typeof s.teamMinLines === "number" ? s.teamMinLines : 200,
      includeAuthored: s.includeAuthored === true,
      skipDrafts: s.skipDrafts !== false,
      dailyLimit: typeof s.dailyLimit === "number" ? s.dailyLimit : 20,
      extraInstructions: typeof s.extraInstructions === "string" ? s.extraInstructions : "",
    };
  }

  async function readRuns(): Promise<number> {
    const v = (await orca.storage.get("runs")) as { day?: string; count?: number } | null;
    return v && v.day === today() ? (v.count ?? 0) : 0;
  }

  async function countRun(): Promise<void> {
    runsToday = (await readRuns()) + 1;
    await orca.storage.set("runs", { day: today(), count: runsToday });
  }

  /** The stored guide; a v2 guide comes back in the current shape (stops with depth and files). */
  const getGuide = async (key: string) => {
    const g = (await orca.storage.get(`guide:${key}`)) as PrGuide | PrGuideV1 | null;
    return g && g.schema === SCHEMA_ID ? upgradeGuide(g) : g;
  };
  const getMeta = async (key: string) =>
    ((await orca.storage.get(`meta:${key}`)) as Meta | null) ?? {};
  // Storage takes JSON only: a field set to undefined is refused, so drop those first.
  const setMeta = async (key: string, meta: Meta) =>
    orca.storage.set(`meta:${key}`, JSON.parse(JSON.stringify(meta)));
  const getOptIn = async (repo: string) => {
    const v = await orca.storage.get(`optin:${repo}`);
    return typeof v === "boolean" ? v : null;
  };

  /**
   * The tour of a current-version guide as progress counts it: its stops with full coverage, then
   * the skipped files (asked of git for a guide written before they were stored). Null for v1.
   */
  async function tourShape(
    key: string,
    guide: PrGuide | PrGuideV1 | null,
  ): Promise<TourShape | null> {
    if (!guide || guide.schema !== SCHEMA_ID) return null;
    const skipped =
      guide.skipped ??
      (await skippedAt(key, guide, guide.pr.commit).catch((e) => {
        orca.log(`${key}: skipped files: ${message(e)}`);
        return [] as SkippedFile[];
      }));
    return { stops: fullTour(guide, skipped), skipped: skipped.map((f) => f.path) };
  }

  /** Tour progress on a current-version guide ("18 of 23 files"); v1 guides have no tour. */
  const tourOf = async (key: string, guide: PrGuide | PrGuideV1 | null, stored: unknown) => {
    const shape = await tourShape(key, guide);
    return shape && guide ? tourLabel(stored, guide.pr.commit, shape) : null;
  };

  // ---------------------------------------------------------------- state for the panel

  function notice(items: readonly QueueItem[]): Notice | null {
    if (lastError)
      return {
        tone: "warning",
        text: `Couldn't reach GitHub${checkedAt !== null ? ` · last checked ${clock(checkedAt)}` : ""}`,
      };
    if (agentSignedOut)
      return {
        tone: "danger",
        text: `${settings.harness === "codex" ? "Codex" : "Claude Code"} is not signed in · sign in from a terminal, then Generate`,
      };
    const waiting = items.some(
      (i) =>
        i.manualReason === null &&
        (i.status === "none" || i.status === "stale") &&
        tracked.get(i.key)?.auto,
    );
    if (waiting && runsToday >= settings.dailyLimit)
      return {
        tone: "warning",
        text: "Automatic guides paused until tomorrow · Generate still works",
      };
    return null;
  }

  function state(): QueueState {
    const items = [...tracked.values()].map((t) => t.item);
    return {
      ...buildQueue(items),
      repos: [...repos.values()].sort((a, b) => a.repo.localeCompare(b.repo)),
      checking: checking !== null,
      checkedAt,
      notice: notice(items),
      agentLabel: `${settings.harness === "codex" ? "Codex" : "Claude Code"}${settings.model ? ` · ${settings.model}` : ""}`,
      includeAuthored: settings.includeAuthored,
      openKey,
    };
  }

  function publish(): void {
    orca.panels.post("queue.changed", state());
    void updateStatusBar();
  }

  // ---------------------------------------------------------------- local clones

  async function localClones(): Promise<Map<string, Clone>> {
    const clones = new Map<string, Clone>();
    const { projects } = await orca.host.call("project.list");
    for (const p of projects) {
      if (p.kind !== "git" || (p.hostId && p.hostId !== "local")) continue;
      const remote = await run("git", ["-C", p.path, "remote", "get-url", "origin"], {
        timeoutMs: 10_000,
      }).catch(() => null);
      const raw = remote && remote.code === 0 ? repoSlugFromRemote(remote.stdout) : null;
      const slug = raw ? await canonicalRepo(raw) : null;
      if (slug && !clones.has(slug)) clones.set(slug, { path: p.path, projectId: p.id });
    }
    return clones;
  }

  async function ownedFiles(clone: Clone | null, files: string[]): Promise<number | null> {
    if (!clone || settings.teams.length === 0) return null;
    for (const rel of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
      const text = await readFile(join(clone.path, rel), "utf8").catch(() => null);
      if (text !== null) return countOwnedFiles(parseCodeowners(text), files, settings.teams);
    }
    return null;
  }

  // ---------------------------------------------------------------- checking GitHub

  type Found = { hit: SearchHit; lane: Lane; team: string | null };
  async function searchLanes(): Promise<Map<string, Found>> {
    const found = new Map<string, Found>();
    const add = (hits: SearchHit[], lane: Lane, team: string | null = null) => {
      for (const hit of hits) {
        const key = keyOf(hit.repo, hit.number);
        if (!found.has(key)) found.set(key, { hit, lane, team });
      }
    };
    add(await searchPrs("user-review-requested:@me"), "user");
    for (const team of settings.teams)
      add(await searchPrs(`team-review-requested:${team}`), "team", team);
    if (settings.includeAuthored) add(await searchPrs("author:@me"), "authored");
    return found;
  }

  /** Why this PR gets no automatic guide, or null when it does. */
  function manualReason(
    lane: Lane,
    d: PrDetails,
    owned: number | null,
    optIn: boolean | null,
    clone: Clone | null,
  ): string | null {
    if (!clone) return "No local clone in Orca";
    if (optIn !== true)
      return optIn === false ? "Repository turned off" : "Repository not turned on yet";
    if (d.isDraft && settings.skipDrafts) return "Draft";
    if (lane === "user" && !settings.autoRequested) return "Automatic guides are off";
    if (lane === "team") {
      if (!settings.autoTeams) return "Automatic team guides are off";
      if (d.additions + d.deletions < settings.teamMinLines)
        return `Under ${settings.teamMinLines} lines`;
      if (settings.teamRequireOwnership && owned === 0) return "No files your teams own";
    }
    return null;
  }

  function statusOf(
    key: string,
    guide: PrGuide | PrGuideV1 | null,
    meta: Meta,
    d: PrDetails,
    lockfile: boolean,
  ): ItemStatus {
    if (generating.has(key)) return "generating";
    if (queued.includes(key)) return "queued";
    // A guide made by an older version counts as stale, so the next automatic run replaces it.
    if (guide && guide.schema === SCHEMA_ID && guide.pr.commit === d.headRefOid) return "ready";
    if (meta.error && meta.errorCommit === d.headRefOid) return "failed";
    if (guide) return "stale";
    return lockfile ? "lockfile" : "none";
  }

  async function buildItem(
    key: string,
    lane: Lane,
    d: PrDetails,
    repo: string,
    clone: Clone | null,
    extra: { team: string | null; requestedAt: number },
  ): Promise<Tracked> {
    const [guide, meta, optIn, tour, draft] = await Promise.all([
      getGuide(key),
      getMeta(key),
      getOptIn(repo),
      orca.storage.get(tourKey(key)),
      getDraft(key, d.headRefOid),
    ]);
    const files = d.files.map((f) => f.path);
    const lockfile = isLockfileOnly(files);
    const owned = lane === "team" ? await ownedFiles(clone, files) : null;
    const reason = lockfile ? "Lockfile only" : manualReason(lane, d, owned, optIn, clone);
    const status = statusOf(key, guide, meta, d, lockfile);
    return {
      details: d,
      clone,
      auto: reason === null,
      item: {
        key,
        repo,
        number: d.number,
        title: d.title,
        author: d.author,
        url: d.url,
        lane,
        draft: d.isDraft,
        additions: d.additions,
        deletions: d.deletions,
        changedFiles: d.changedFiles,
        headSha: d.headRefOid,
        status,
        risk: guide?.risk.level ?? null,
        riskSummary: guide ? riskHeadline(guide) : null,
        newSinceYourReview: Boolean(
          meta.lastViewedCommit && meta.lastViewedCommit !== d.headRefOid,
        ),
        ownedFiles: owned,
        manualReason: reason,
        error: status === "failed" ? (meta.error ?? null) : null,
        hasClone: clone !== null,
        requestedAt: extra.requestedAt,
        team: extra.team,
        position: null,
        repoLabel: repo,
        tour: status === "ready" ? await tourOf(key, guide, tour) : null,
        pendingComments: draft.comments.length,
      },
    };
  }

  /**
   * Review-request times for the PRs found, one GraphQL query per repository, cached per head. A
   * failed query falls back to when the PR was opened, so the queue still orders.
   */
  async function requestedTimes(list: { key: string; repo: string; d: PrDetails }[]) {
    const byRepo = new Map<string, number[]>();
    for (const { key, repo, d } of list) {
      if (requestedCache.get(key)?.head === d.headRefOid) continue;
      byRepo.set(repo, [...(byRepo.get(repo) ?? []), d.number]);
    }
    for (const [repo, numbers] of byRepo) {
      const times = await requestTimes(repo, numbers, settings.teams).catch((e) => {
        orca.log(`request times for ${repo}: ${message(e)}`);
        return new Map<number, number>();
      });
      for (const { key, repo: r, d } of list)
        if (r === repo && times.has(d.number))
          requestedCache.set(key, { head: d.headRefOid, at: times.get(d.number) as number });
    }
    return (key: string, d: PrDetails, fallback: string) =>
      requestedCache.get(key)?.at ??
      (Date.parse(d.createdAt) || Date.parse(fallback) || Date.now());
  }

  async function check(): Promise<void> {
    settings = await readSettings();
    runsToday = await readRuns();
    const clones = await localClones();
    const found = await searchLanes();
    const next = new Map<string, Tracked>();
    const fetched: { key: string; repo: string; d: PrDetails; found: Found }[] = [];
    for (const [key, f] of [...found].slice(0, MAX_PRS))
      fetched.push({
        key,
        repo: f.hit.repo,
        d: await prDetails(f.hit.repo, f.hit.number),
        found: f,
      });
    const requestedAt = await requestedTimes(fetched);
    for (const { key, repo, d, found: f } of fetched) {
      next.set(
        key,
        await buildItem(key, f.lane, d, repo, clones.get(repo) ?? null, {
          team: f.team,
          requestedAt: requestedAt(key, d, f.hit.updatedAt),
        }),
      );
    }
    tracked.clear();
    for (const [k, v] of next) tracked.set(k, v);
    repos.clear();
    for (const t of next.values()) {
      const r = repos.get(t.item.repo) ?? {
        repo: t.item.repo,
        optIn: await getOptIn(t.item.repo),
        hasClone: t.clone !== null,
        pending: 0,
      };
      r.pending += 1;
      repos.set(t.item.repo, r);
    }
    checkedAt = Date.now();
    lastError = null;
    scheduleAutomatic();
    await prune().catch((e) => orca.log(`prune: ${message(e)}`));
  }

  /** Storage holds 5 MiB and 1,024 keys: forget guides of PRs that left the queue two weeks ago. */
  async function prune(): Promise<void> {
    const cutoff = Date.now() - 14 * 24 * 60 * 60_000;
    for (const key of await orca.storage.keys()) {
      if (!key.startsWith("guide:")) continue;
      const pr = key.slice("guide:".length);
      if (tracked.has(pr)) continue;
      const guide = (await orca.storage.get(key)) as PrGuide | PrGuideV1 | null;
      if (guide && Date.parse(guide.generatedBy.at) < cutoff) {
        await orca.storage.delete(key);
        await orca.storage.delete(`meta:${pr}`);
        await orca.storage.delete(`draft:${pr}`);
        await orca.storage.delete(tourKey(pr));
      }
    }
  }

  function refresh(): Promise<void> {
    if (!checking) {
      checking = check()
        .catch((e) => {
          lastError = message(e);
          orca.log(`check failed: ${lastError}`);
        })
        .finally(() => {
          checking = null;
          publish();
        });
      publish();
    }
    return checking;
  }

  // ---------------------------------------------------------------- automatic runs

  function scheduleAutomatic(): void {
    const now = Date.now();
    for (const t of tracked.values()) {
      const { item } = t;
      if (!t.auto || (item.status !== "none" && item.status !== "stale")) continue;
      if (item.status === "stale") {
        // Wait for the author to stop pushing before spending a run.
        const seen = firstSeen.get(item.key);
        if (!seen || seen.sha !== item.headSha) {
          firstSeen.set(item.key, { sha: item.headSha, at: now });
          const timer = setTimeout(() => {
            timers.delete(timer);
            void refresh();
          }, SETTLE_MS + 1_000);
          timers.add(timer);
          continue;
        }
        if (now - seen.at < SETTLE_MS) continue;
      }
      if (runsToday + queued.length + generating.size >= settings.dailyLimit) break;
      enqueue(item.key, true);
    }
  }

  function enqueue(key: string, automatic: boolean): void {
    if (generating.has(key) || queued.includes(key)) return;
    queued.push(key);
    const t = tracked.get(key);
    if (t) t.item = { ...t.item, status: "queued", error: null };
    publish();
    void drain(automatic);
  }

  let draining = false;
  async function drain(automatic: boolean): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (queued.length) {
        const key = queued.shift() as string;
        generating.add(key);
        const t = tracked.get(key);
        if (t) t.item = { ...t.item, status: "generating" };
        publish();
        try {
          await generate(key, automatic);
        } finally {
          generating.delete(key);
        }
      }
    } finally {
      draining = false;
    }
  }

  // ---------------------------------------------------------------- writing a guide

  const prRefs = (number: number) => ({
    head: `refs/pr-tour/pr-${number}`,
    base: `refs/pr-tour/base-${number}`,
  });

  async function fetchPr(
    clone: Clone,
    d: { number: number; baseRefName: string },
  ): Promise<{ head: string; base: string }> {
    const { head, base } = prRefs(d.number);
    await runOk(
      "git",
      [
        "-C",
        clone.path,
        "fetch",
        "--no-tags",
        "--quiet",
        "origin",
        `+refs/pull/${d.number}/head:${head}`,
        `+refs/heads/${d.baseRefName}:${base}`,
      ],
      { timeoutMs: 180_000 },
    );
    return { head, base };
  }

  async function diffText(
    cwd: string,
    args: string[],
    limit: number,
  ): Promise<{ text: string; truncated: boolean }> {
    const out = await runOk("git", ["-C", cwd, "diff", "--no-color", "--no-ext-diff", ...args], {
      timeoutMs: 60_000,
    });
    return out.length > limit
      ? { text: out.slice(0, limit), truncated: true }
      : { text: out, truncated: false };
  }

  /**
   * The PR's diff per file (lockfiles left out), from one `git diff` of base...head, and the lines
   * a review comment may sit on.
   */
  async function prFiles(cwd: string, refs: { head: string; base: string }) {
    const out = await runOk(
      "git",
      ["-C", cwd, "diff", "--no-color", "--no-ext-diff", `${refs.base}...${refs.head}`],
      { timeoutMs: 120_000 },
    );
    const files = splitDiff(out);
    const lines = commentableLines(out);
    const ctx: DiffContext = {
      changed: files.map((f) => f.path),
      isCommentable: (path, line) => lines.get(path)?.has(line) ?? false,
    };
    return { files, lines, ctx };
  }

  async function sinceInput(
    key: string,
    repo: string,
    clone: Clone,
    d: PrDetails,
    head: string,
  ): Promise<SinceInput | null> {
    const { lastViewedCommit } = await getMeta(key);
    if (!lastViewedCommit || lastViewedCommit === d.headRefOid) return null;
    const known = await run(
      "git",
      ["-C", clone.path, "cat-file", "-e", `${lastViewedCommit}^{commit}`],
      { timeoutMs: 10_000 },
    );
    if (known.code !== 0) return null; // force-pushed away; the whole guide is new anyway
    const [log, diff, comments] = await Promise.all([
      runOk(
        "git",
        ["-C", clone.path, "log", "--oneline", "--no-decorate", `${lastViewedCommit}..${head}`],
        { timeoutMs: 30_000 },
      ),
      diffText(
        clone.path,
        [lastViewedCommit, head, "--", ".", ...LOCKFILE_EXCLUDES],
        SINCE_DIFF_LIMIT,
      ),
      myReviewComments(repo, d.number).catch(() => []),
    ]);
    return {
      fromCommit: lastViewedCommit,
      toCommit: d.headRefOid,
      log: log.trim(),
      diff: diff.text,
      comments,
    };
  }

  /** Area counts from the diff itself (lockfiles left out), with ungrouped files under Other. */
  function withStats(agent: AgentGuide, changed: readonly FileDiff[]): PrGuide["areas"] {
    const byPath = new Map(changed.map((f) => [f.path, f]));
    const seen = new Set<string>();
    const areas = agent.areas.map((a) => {
      const files = a.files.filter((f) => byPath.has(f) && !seen.has(f));
      files.forEach((f) => seen.add(f));
      const additions = files.reduce((n, f) => n + (byPath.get(f)?.additions ?? 0), 0);
      const deletions = files.reduce((n, f) => n + (byPath.get(f)?.deletions ?? 0), 0);
      return { ...a, files, additions, deletions };
    });
    const rest = changed.filter((f) => !seen.has(f.path));
    if (rest.length) {
      areas.push({
        id: "other",
        label: "Other",
        question: "Not grouped by the agent",
        files: rest.map((f) => f.path),
        additions: rest.reduce((n, f) => n + f.additions, 0),
        deletions: rest.reduce((n, f) => n + f.deletions, 0),
      });
    }
    return areas.filter((a) => a.files.length > 0);
  }

  async function generate(key: string, automatic: boolean): Promise<void> {
    const t = tracked.get(key);
    const [repo, num] = key.split("#");
    try {
      const clones = t?.clone ? null : await localClones();
      const clone = t?.clone ?? clones?.get(repo) ?? null;
      if (!clone)
        throw new Error(`No local clone of ${repo} in Orca. Add it as a project to make guides.`);
      // A new run replaces the last failure, so a worker restart mid-run never shows a stale error.
      const before = await getMeta(key);
      if (before.error) await setMeta(key, { lastViewedCommit: before.lastViewedCommit });
      const d = await prDetails(repo, Number(num));
      const refs = await fetchPr(clone, d);
      const { files, lines, ctx: base } = await prFiles(clone.path, refs);
      const changed = base.changed;
      // Decided before the run, so the agent spends no stop on them and can't skim a risky file.
      const triage = await triageAt(clone.path, repo, key, d.headRefOid, refs.base);
      const rules: TourRules = {
        skipped: new Map(triage.skipped.map((f) => [f.path, f.reason])),
        risky: new Map([...triage.risky].filter(([path]) => changed.includes(path))),
      };
      const ctx: DiffContext = { ...base, tour: rules };
      const budget = budgetDiff(files);
      const since = await sinceInput(key, repo, clone, d, refs.head);
      const prompt = buildPrompt({
        repo,
        pr: d,
        inPrompt: budget.inPrompt,
        outside: budget.outside,
        since,
        extraInstructions: settings.extraInstructions,
        headRef: refs.head,
        baseRef: refs.base,
        skipped: triage.skipped,
        risky: rules.risky,
      });
      orca.log(
        `generating ${key} at ${d.headRefOid.slice(0, 7)} with ${settings.harness}${settings.model ? ` (${settings.model})` : ""}; skipped by design: ${triage.skipped.map((f) => `${f.path} (${f.reason})`).join(", ") || "none"}; must be deep: ${[...rules.risky.keys()].join(", ") || "none"}`,
      );
      const started = Date.now();
      const toolCalls: ToolCall[] = [];
      let { text: reply, toolCalls: calls } = await runAgent(
        settings.harness,
        settings.model,
        prompt,
        clone.path,
      );
      toolCalls.push(...calls);
      let parsed: unknown;
      let problems: string[];
      try {
        parsed = extractJson(reply);
        problems = checkAgentGuide(parsed, ctx);
      } catch (e) {
        problems = [message(e)];
      }
      if (problems.length) {
        orca.log(
          `${key}: reply did not match prguide v2 (${problems.slice(0, 3).join("; ")}), asking once more`,
        );
        ({ text: reply, toolCalls: calls } = await runAgent(
          settings.harness,
          settings.model,
          buildRepairPrompt(prompt, reply, problems),
          clone.path,
        ));
        toolCalls.push(...calls);
        parsed = extractJson(reply);
        // After the repair round, long headlines are tolerated and lines outside the diff or
        // missing file notes are settled by the worker; anything else still fails the run.
        problems = checkAgentGuide(parsed, undefined, { words: false, tour: false });
        if (!problems.length) {
          const settled = settle(parsed as AgentGuide, ctx);
          if (settled.fixed.length) orca.log(`${key}: settled ${settled.fixed.join("; ")}`);
          parsed = settled.guide;
          // Coverage is no longer the agent's to fix: the worker enforces it below.
          problems = checkAgentGuide(parsed, base, { words: false, tour: false });
        }
        if (problems.length)
          throw new Error(
            `The agent's guide did not match prguide v2: ${problems.slice(0, 3).join("; ")}`,
          );
      }
      const replied = parsed as AgentGuide;
      const covered = enforceCoverage(replied.readingOrder, changed, replied.findings, rules);
      if (covered.fixed.length) orca.log(`${key}: coverage: ${covered.fixed.join("; ")}`);
      const agent: AgentGuide = { ...replied, readingOrder: covered.stops };
      const lane: ReviewRequest = t ? t.item.lane : "manual";
      const guide: PrGuide = {
        schema: SCHEMA_ID,
        ...agent,
        pr: {
          repo,
          number: d.number,
          url: d.url,
          author: d.author,
          commit: d.headRefOid,
          baseRef: d.baseRefName,
          headRef: d.headRefName,
          additions: d.additions,
          deletions: d.deletions,
          fileCount: d.changedFiles,
          requestedAt: t ? new Date(t.item.requestedAt).toISOString() : null,
          hasDescription: d.body.trim() !== "",
        },
        generatedBy: {
          harness: settings.harness,
          model: settings.model || null,
          at: new Date().toISOString(),
        },
        reviewRequest: lane,
        areas: withStats(agent, files),
        sinceLastReview:
          since && agent.sinceLastReview
            ? { ...agent.sinceLastReview, fromCommit: since.fromCommit, toCommit: since.toCommit }
            : null,
        coverage: coverage(
          changed,
          budget.inPrompt.map((f) => f.path),
          filesReadByAgent(toolCalls, changed, clone.path),
        ),
        commentable: Object.fromEntries(
          changed.map((f) => [f, toRanges(lines.get(f) ?? new Set())]),
        ),
        skipped: triage.skipped,
      };
      const stored =
        JSON.stringify(guide).length > GUIDE_STORAGE_LIMIT ? withoutDetail(guide) : guide;
      await orca.storage.set(`guide:${key}`, stored as unknown as JsonValue);
      const meta = await getMeta(key);
      await setMeta(key, { lastViewedCommit: meta.lastViewedCommit });
      agentSignedOut = false;
      // Ready before the tab asks; a failure here is retried when the tab asks.
      void breakdown(key).catch((e) => orca.log(`${key}: changes breakdown: ${message(e)}`));
      if (automatic) await countRun();
      const focused = guide.readingOrder.filter((r) => r.focus?.length);
      const deep = guide.readingOrder.filter((r) => r.depth === "deep").length;
      orca.log(
        `${key}: guide ready in ${Math.round((Date.now() - started) / 1000)} s (${guide.risk.level} risk, ${guide.findings.length} findings, ${guide.readingOrder.length} stops: ${deep} deep, ${guide.readingOrder.length - deep} skim; ${triage.skipped.length} skipped; ${focused.length} with focus, ${focused.reduce((n, r) => n + (r.focus?.length ?? 0), 0)} ranges) · ${guide.readingOrder.map((r, i) => `${i + 1} ${r.depth} ${r.why} ${r.files.length}f`).join(", ")}`,
      );
      if (t) {
        t.item = {
          ...t.item,
          status: "ready",
          risk: guide.risk.level,
          riskSummary: guide.risk.headline,
          error: null,
          headSha: d.headRefOid,
          tour: await tourOf(key, guide, await orca.storage.get(tourKey(key))),
        };
      }
      if (openWhenReady.delete(key)) {
        await openGuide(key).catch((e) =>
          orca.log(`${key}: could not open the guide: ${message(e)}`),
        );
      }
      if (automatic && t?.item.lane === "user") {
        await orca.host
          .call("notifications.show", {
            title: `Review guide ready: #${d.number}`,
            body: `${guide.risk.level[0].toUpperCase()}${guide.risk.level.slice(1)} risk. ${guide.risk.headline}`,
          })
          .catch(() => undefined);
      }
    } catch (e) {
      const error = message(e);
      if (SIGNED_OUT.test(error)) agentSignedOut = true;
      orca.log(`${key}: ${error}`);
      const meta = await getMeta(key);
      await setMeta(key, { ...meta, error, errorCommit: t?.item.headSha });
      if (t) t.item = { ...t.item, status: "failed", error };
    } finally {
      publish();
    }
  }

  // ---------------------------------------------------------------- opening guides and files

  async function workspaceFor(
    repo: string,
    branch: string | null,
  ): Promise<{ id: string; path: string }> {
    const clones = await localClones();
    const clone = clones.get(repo);
    if (!clone)
      throw Object.assign(new Error(`No local clone of ${repo} in Orca`), { code: "unavailable" });
    const { workspaces } = await orca.host.call("workspace.list");
    const mine = workspaces.filter(
      (w) => w.projectId === clone.projectId && (!w.hostId || w.hostId === "local"),
    );
    const pick =
      mine.find((w) => branch && w.branch === branch) ??
      mine.find((w) => w.path === clone.path) ??
      mine[0];
    if (!pick)
      throw Object.assign(new Error(`No Orca workspace for ${repo}`), { code: "unavailable" });
    return { id: pick.id, path: pick.path };
  }

  async function hideFolder(workspacePath: string): Promise<void> {
    const out = await runOk("git", ["-C", workspacePath, "rev-parse", "--git-common-dir"], {
      timeoutMs: 10_000,
    });
    const common = out.trim();
    const infoDir = join(isAbsolute(common) ? common : join(workspacePath, common), "info");
    const exclude = join(infoDir, "exclude");
    const current = await readFile(exclude, "utf8").catch(() => "");
    if (!current.split("\n").some((l) => l.trim() === ".pr-tour/")) {
      await mkdir(infoDir, { recursive: true });
      await appendFile(
        exclude,
        `${current.endsWith("\n") || current === "" ? "" : "\n"}.pr-tour/\n`,
      );
    }
  }

  async function openGuide(key: string): Promise<boolean> {
    const guide = await getGuide(key);
    if (!guide) throw Object.assign(new Error("No guide for this PR yet"), { code: "unavailable" });
    const ws = await workspaceFor(guide.pr.repo, guide.pr.headRef);
    const rel = `.pr-tour/${guide.pr.number}.prtour.json`;
    await mkdir(join(ws.path, ".pr-tour"), { recursive: true });
    await hideFolder(ws.path).catch((e) =>
      orca.log(`could not add .pr-tour/ to git's exclude list: ${message(e)}`),
    );
    await writeFile(join(ws.path, rel), `${JSON.stringify(guide, null, 2)}\n`);
    await orca.host.call("workspace.open", { workspaceId: ws.id });
    await orca.host.call("editor.open", { workspaceId: ws.id, path: rel });
    const meta = await getMeta(key);
    await setMeta(key, { ...meta, lastViewedCommit: guide.pr.commit });
    const t = tracked.get(key);
    if (t) t.item = { ...t.item, newSinceYourReview: false };
    openKey = key;
    publish();
    return true;
  }

  // ---------------------------------------------------------------- reviewing from the guide

  const getDraft = async (key: string, commit: string) =>
    asDraft(await orca.storage.get(`draft:${key}`), commit);
  const setDraft = async (key: string, draft: Draft) => {
    await orca.storage.set(`draft:${key}`, JSON.parse(JSON.stringify(draft)) as JsonValue);
    showPending(key, draft.comments.length);
  };
  /** Keeps the queue row's pending-comment count in step with the stored draft. */
  function showPending(key: string, n: number): void {
    const t = tracked.get(key);
    if (!t || t.item.pendingComments === n) return;
    t.item = { ...t.item, pendingComments: n };
    publish();
  }

  async function requireGuide(key: string) {
    const guide = await getGuide(key);
    if (!guide) throw Object.assign(new Error("No guide for this PR yet"), { code: "unavailable" });
    return guide;
  }

  async function reviewInfo(key: string): Promise<ReviewInfo> {
    const guide = await requireGuide(key);
    const me = await currentLogin().catch(() => "");
    return {
      draft: await getDraft(key, guide.pr.commit),
      canApprove: !me || guide.pr.author.toLowerCase() !== me.toLowerCase(),
      head: tracked.get(key)?.item.headSha ?? guide.pr.commit,
    };
  }

  /** The diff's files and comment lines at `head`: from the guide when it is current, else git. */
  async function diffAt(guide: PrGuide | PrGuideV1, d: PrDetails): Promise<DiffContext> {
    if (guide.schema === SCHEMA_ID && guide.pr.commit === d.headRefOid) {
      const ranges = guide.commentable;
      return {
        changed: Object.keys(ranges),
        isCommentable: (path, line) => inRanges(ranges[path] ?? [], line),
      };
    }
    const clone = (await localClones()).get(guide.pr.repo);
    if (!clone) throw new Error(`No local clone of ${guide.pr.repo} in Orca to check the diff`);
    return (await prFiles(clone.path, await fetchPr(clone, d))).ctx;
  }

  /**
   * Posts the stored draft as one GitHub review (line comments inside it), then each whole-file
   * comment, which GitHub only takes on its own. Only a press in the guide tab gets here.
   */
  async function submitReview(
    key: string,
    event: ReviewEvent,
    body: string,
  ): Promise<ReviewSubmitResult> {
    const guide = await requireGuide(key);
    const draft = { ...(await getDraft(key, guide.pr.commit)), body };
    const { repo, number } = guide.pr;
    let d: PrDetails;
    let me: string;
    let ctx: DiffContext;
    try {
      [d, me] = await Promise.all([prDetails(repo, number), currentLogin()]);
      ctx = await diffAt(guide, d);
    } catch (e) {
      await setDraft(key, draft);
      return { outcome: "refused", message: message(e) };
    }
    const problem = reviewProblem(draft, event, body, d.author.toLowerCase() !== me.toLowerCase());
    if (problem) {
      await setDraft(key, draft);
      return { outcome: "refused", message: problem };
    }
    const stale = staleComments(draft, ctx.isCommentable, ctx.changed);
    if (stale.length) {
      await setDraft(key, draft);
      return { outcome: "conflict", head: d.headRefOid, stale };
    }
    let url: string | null = null;
    try {
      const out = await runOk(
        "gh",
        ["api", "-X", "POST", `repos/${repo}/pulls/${number}/reviews`, "--input", "-"],
        {
          input: JSON.stringify(reviewPayload(draft, event, body, d.headRefOid)),
          timeoutMs: 60_000,
        },
      );
      url = (JSON.parse(out) as { html_url?: string }).html_url ?? null;
    } catch (e) {
      await setDraft(key, draft);
      return { outcome: "refused", message: message(e) };
    }
    orca.log(`${key}: posted a ${event} review with ${draft.comments.length} comment(s)`);
    const notPosted: DraftComment[] = [];
    for (const { comment, payload } of fileCommentPayloads(draft, d.headRefOid)) {
      await runOk(
        "gh",
        ["api", "-X", "POST", `repos/${repo}/pulls/${number}/comments`, "--input", "-"],
        { input: JSON.stringify(payload), timeoutMs: 60_000 },
      ).catch((e) => {
        orca.log(`${key}: file comment on ${comment.path} was not posted: ${message(e)}`);
        notPosted.push(comment);
      });
    }
    if (notPosted.length)
      await setDraft(key, {
        commitId: d.headRefOid,
        body: "",
        comments: notPosted,
        dismissedFindings: draft.dismissedFindings,
      });
    else {
      await orca.storage.delete(`draft:${key}`);
      showPending(key, 0);
    }
    const meta = await getMeta(key);
    await setMeta(key, { ...meta, lastViewedCommit: d.headRefOid });
    void refresh();
    return { outcome: "posted", event, url, notPosted };
  }

  // ---------------------------------------------------------------- the guided tour

  async function getTour(key: string, commitIn: unknown, stops: unknown): Promise<TourState> {
    if (commitIn !== undefined && (typeof commitIn !== "string" || !COMMIT.test(commitIn)))
      throw Object.assign(new Error("Expected a commit id"), { code: "invalid" });
    if (typeof stops !== "number" || !Number.isInteger(stops) || stops < 0)
      throw Object.assign(new Error("Expected a number of stops"), { code: "invalid" });
    const commit = (commitIn as string | undefined) ?? (await requireGuide(key)).pr.commit;
    return tourState(await orca.storage.get(tourKey(key)), commit, stops);
  }

  async function saveTour(key: string, state: unknown): Promise<void> {
    const guide = await requireGuide(key);
    const commit = (state as { commit?: unknown } | null)?.commit;
    if (typeof commit !== "string" || !COMMIT.test(commit))
      throw Object.assign(new Error("Expected a tour state"), { code: "invalid" });
    // Normalised against the guide the tab shows (its commit), so storage only holds plain JSON.
    const shape = await tourShape(key, guide);
    const stops = shape ? stopCount(shape) : 0;
    const clean = tourState(
      state,
      commit,
      commit === guide.pr.commit ? stops : Number.MAX_SAFE_INTEGER,
    );
    await orca.storage.set(tourKey(key), clean as unknown as JsonValue);
    // Moving through a guide tab makes it the one the panel marks as current.
    const reopened = openKey !== key;
    openKey = key;
    const t = tracked.get(key);
    const tour = t ? await tourOf(key, guide, clean) : null;
    const moved = Boolean(t && tour !== t.item.tour);
    if (t && moved) t.item = { ...t.item, tour };
    if (reopened || moved) publish();
  }

  // ---------------------------------------------------------------- file diffs for the guide tab

  /** By `key@commit:path`; a failed lookup is dropped so pressing the file again retries. */
  const diffCache = new Map<string, Promise<DiffFile>>();
  /** `--name-status -M` of a guide's range by `key@commit`: renames for diffs, status letters for Changes. */
  const statusCache = new Map<string, Promise<NameStatus[]>>();

  const hasCommit = async (cwd: string, rev: string) =>
    (await run("git", ["-C", cwd, "cat-file", "-e", `${rev}^{commit}`], { timeoutMs: 10_000 }))
      .code === 0;

  function nameStatus(cwd: string, range: string, cacheKey: string): Promise<NameStatus[]> {
    let found = statusCache.get(cacheKey);
    if (!found) {
      found = runOk("git", ["-C", cwd, "diff", "--name-status", "-M", "-z", range], {
        timeoutMs: 60_000,
      }).then(parseNameStatusZ);
      found.catch(() => statusCache.delete(cacheKey));
      statusCache.set(cacheKey, found);
    }
    return found;
  }

  /**
   * The local clone, with the guide's commit and base ref present: they are fetched when a guide
   * is written, but a fresh clone or a pruned object needs them again.
   */
  async function cloneAt(guide: PrGuide | PrGuideV1, key: string, commit: string) {
    const clone = tracked.get(key)?.clone ?? (await localClones()).get(guide.pr.repo);
    if (!clone)
      throw Object.assign(new Error(`No local clone of ${guide.pr.repo} in Orca`), {
        code: "unavailable",
      });
    const refs = prRefs(guide.pr.number);
    if (!(await hasCommit(clone.path, commit)) || !(await hasCommit(clone.path, refs.base))) {
      await fetchPr(clone, { number: guide.pr.number, baseRefName: guide.pr.baseRef });
      if (!(await hasCommit(clone.path, commit)))
        throw Object.assign(
          new Error(
            `Commit ${commit.slice(0, 7)} is no longer on GitHub (the branch was probably force-pushed). Regenerate the guide.`,
          ),
          { code: "unavailable" },
        );
    }
    return { clone, range: `${refs.base}...${commit}` };
  }

  async function computeFileDiff(
    guide: PrGuide | PrGuideV1,
    key: string,
    commit: string,
    path: string,
  ): Promise<DiffFile> {
    const { clone, range } = await cloneAt(guide, key, commit);
    const oldPath = (await nameStatus(clone.path, range, `${key}@${commit}`)).find(
      (s) => s.status === "R" && s.path === path,
    )?.oldPath;
    const out = await runOk(
      "git",
      [
        "-C",
        clone.path,
        // Paths are file names, never pathspec magic such as ":(exclude)".
        "--literal-pathspecs",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "-M",
        range,
        "--",
        ...(oldPath ? [oldPath] : []),
        path,
      ],
      { timeoutMs: 60_000 },
    );
    const file = splitDiff(out, { keepLockfiles: true }).find((f) => f.path === path) ?? null;
    return fileDiffView(file, path, commit);
  }

  async function fileDiff(key: string, path: unknown, commitIn: unknown): Promise<DiffFile> {
    if (typeof path !== "string" || !path || path.includes("\0"))
      throw Object.assign(new Error("Expected a file path"), { code: "invalid" });
    if (commitIn !== undefined && (typeof commitIn !== "string" || !COMMIT.test(commitIn)))
      throw Object.assign(new Error("Expected a commit id"), { code: "invalid" });
    const guide = await requireGuide(key);
    const commit = (commitIn as string | undefined) ?? guide.pr.commit;
    const cacheKey = `${key}@${commit}:${path}`;
    let found = diffCache.get(cacheKey);
    if (!found) {
      if (diffCache.size >= DIFF_CACHE_LIMIT) {
        diffCache.clear();
        statusCache.clear();
      }
      found = computeFileDiff(guide, key, commit, path);
      found.catch(() => diffCache.delete(cacheKey));
      diffCache.set(cacheKey, found);
    }
    return found;
  }

  // ---------------------------------------------------------------- the Changes breakdown

  /** By `key@commit`; failures are dropped so opening the guide again retries. */
  const breakdownCache = new Map<string, Promise<Breakdown>>();
  /** Ecosystems whose presets apply, by `repo@commit`: one `ls-tree` of the whole repo each. */
  const ecosystemCache = new Map<string, Promise<Ecosystem[]>>();

  function ecosystemsAt(cwd: string, repo: string, commit: string): Promise<Ecosystem[]> {
    const cacheKey = `${repo}@${commit}`;
    let found = ecosystemCache.get(cacheKey);
    if (!found) {
      if (ecosystemCache.size >= BREAKDOWN_CACHE_LIMIT) ecosystemCache.clear();
      found = runOk("git", ["-C", cwd, "ls-tree", "-r", "--name-only", "-z", commit], {
        timeoutMs: 60_000,
      }).then((out) => detectEcosystems(parseNulList(out)));
      found.catch(() => ecosystemCache.delete(cacheKey));
      ecosystemCache.set(cacheKey, found);
    }
    return found;
  }

  /** The repo's own category rules at the PR head, as Diff Breakdown reads them from a checkout. */
  async function overridesAt(cwd: string, commit: string): Promise<Overrides | undefined> {
    const out = await run("git", ["-C", cwd, "show", `${commit}:${OVERRIDES_PATH}`], {
      timeoutMs: 10_000,
    });
    if (out.code !== 0) return undefined; // the repo has none
    try {
      return parseOverrides(out.stdout);
    } catch (e) {
      orca.log(`${OVERRIDES_PATH} at ${commit.slice(0, 7)} ignored: ${message(e)}`);
      return undefined;
    }
  }

  /** linguist-* attributes from the PR head's .gitattributes (not the working tree's). */
  async function attributesAt(cwd: string, commit: string, paths: string[]) {
    if (!paths.length) return new Map<string, PathAttributes>();
    const out = await run(
      "git",
      ["-C", cwd, "check-attr", "-z", `--source=${commit}`, "--stdin", ...LINGUIST],
      { input: `${paths.join("\0")}\0`, timeoutMs: 30_000 },
    );
    if (out.code !== 0) {
      orca.log(`check-attr at ${commit.slice(0, 7)} failed: ${out.stderr.trim()}`);
      return new Map<string, PathAttributes>();
    }
    return parseLinguistAttributes(out.stdout);
  }

  /** The range's files as git counts them, their status letters, and how each is classified. */
  type ChangedFiles = { statuses: NameStatus[]; numstat: NumStat[]; classify: Classifier };
  /** By `key@commit`, shared by the Changes breakdown and the tour's triage. */
  const changedCache = new Map<string, Promise<ChangedFiles>>();

  function changedFilesAt(
    cwd: string,
    repo: string,
    key: string,
    commit: string,
    range: string,
  ): Promise<ChangedFiles> {
    const cacheKey = `${key}@${commit}`;
    let found = changedCache.get(cacheKey);
    if (!found) {
      if (changedCache.size >= BREAKDOWN_CACHE_LIMIT) changedCache.clear();
      found = (async () => {
        const [statuses, numstat, ecosystems, overrides] = await Promise.all([
          nameStatus(cwd, range, cacheKey),
          runOk("git", ["-C", cwd, "diff", "--numstat", "-M", "-z", "--no-textconv", range], {
            timeoutMs: 60_000,
          }).then(parseNumstatZ),
          ecosystemsAt(cwd, repo, commit),
          overridesAt(cwd, commit),
        ]);
        const attributes = await attributesAt(
          cwd,
          commit,
          numstat.map((f) => f.path),
        );
        return {
          statuses,
          numstat,
          classify: createClassifier({ ecosystems, overrides, attributes }),
        };
      })();
      found.catch(() => changedCache.delete(cacheKey));
      changedCache.set(cacheKey, found);
    }
    return found;
  }

  async function computeBreakdown(
    guide: PrGuide | PrGuideV1,
    key: string,
    commit: string,
  ): Promise<Breakdown> {
    const { clone, range } = await cloneAt(guide, key, commit);
    const { statuses, numstat, classify } = await changedFilesAt(
      clone.path,
      guide.pr.repo,
      key,
      commit,
      range,
    );
    return buildBreakdown({
      headRef: guide.pr.headRef,
      baseRef: guide.pr.baseRef,
      numstat,
      nameStatus: statuses,
      classify,
    });
  }

  // ---------------------------------------------------------------- the tour's triage

  /**
   * Files the tour skips by design and risky files that need a deep stop, at `commit` against the
   * base ref: the classifier's Generated and lockfiles, whitespace-only changes (missing from a
   * `git diff -w --numstat`) and pure renames.
   */
  async function triageAt(
    cwd: string,
    repo: string,
    key: string,
    commit: string,
    baseRef: string,
  ): Promise<{ skipped: SkippedFile[]; risky: Map<string, string> }> {
    const range = `${baseRef}...${commit}`;
    const [{ statuses, numstat, classify }, ignoringSpace] = await Promise.all([
      changedFilesAt(cwd, repo, key, commit, range),
      runOk("git", ["-C", cwd, "diff", "-w", "--numstat", "-M", "-z", "--no-textconv", range], {
        timeoutMs: 60_000,
      }).then(parseNumstatZ),
    ]);
    const skipped = skippedFiles({
      numstat,
      nameStatus: statuses,
      numstatIgnoringSpace: ignoringSpace,
      classify,
    });
    const risky = riskyFiles(
      numstat.map((f) => f.path),
      classify,
      new Set(skipped.map((f) => f.path)),
    );
    return { skipped, risky };
  }

  /** By `key@commit`; for guides written before they stored their skipped files. */
  const skippedCache = new Map<string, Promise<SkippedFile[]>>();

  /** The guide's skipped files at `commit`: stored with it when it is that commit's, else from git. */
  function skippedAt(key: string, guide: PrGuide | PrGuideV1, commit: string) {
    if (guide.schema === SCHEMA_ID && guide.skipped && guide.pr.commit === commit)
      return Promise.resolve(guide.skipped);
    const cacheKey = `${key}@${commit}`;
    let found = skippedCache.get(cacheKey);
    if (!found) {
      if (skippedCache.size >= BREAKDOWN_CACHE_LIMIT) skippedCache.clear();
      found = cloneAt(guide, key, commit).then(
        async ({ clone }) =>
          (await triageAt(clone.path, guide.pr.repo, key, commit, prRefs(guide.pr.number).base))
            .skipped,
      );
      found.catch(() => skippedCache.delete(cacheKey));
      skippedCache.set(cacheKey, found);
    }
    return found;
  }

  async function skippedRequest(key: string, commitIn?: unknown): Promise<SkippedFile[]> {
    if (commitIn !== undefined && (typeof commitIn !== "string" || !COMMIT.test(commitIn)))
      throw Object.assign(new Error("Expected a commit id"), { code: "invalid" });
    const guide = await requireGuide(key);
    return skippedAt(key, guide, (commitIn as string | undefined) ?? guide.pr.commit);
  }

  async function breakdown(key: string, commitIn?: unknown): Promise<Breakdown> {
    if (commitIn !== undefined && (typeof commitIn !== "string" || !COMMIT.test(commitIn)))
      throw Object.assign(new Error("Expected a commit id"), { code: "invalid" });
    const guide = await requireGuide(key);
    const commit = (commitIn as string | undefined) ?? guide.pr.commit;
    const cacheKey = `${key}@${commit}`;
    let found = breakdownCache.get(cacheKey);
    if (!found) {
      if (breakdownCache.size >= BREAKDOWN_CACHE_LIMIT) breakdownCache.clear();
      found = computeBreakdown(guide, key, commit);
      found.catch(() => breakdownCache.delete(cacheKey));
      breakdownCache.set(cacheKey, found);
    }
    return found;
  }

  // ---------------------------------------------------------------- the focused workspace

  async function focusedPr(): Promise<{ repo: string; branch: string } | null> {
    if (!focused?.workspaceId) return null;
    const { workspaces } = await orca.host.call("workspace.list");
    const ws = workspaces.find((w) => w.id === focused?.workspaceId);
    if (!ws) return null;
    const remote = await run("git", ["-C", ws.path, "remote", "get-url", "origin"], {
      timeoutMs: 10_000,
    });
    const raw = remote.code === 0 ? repoSlugFromRemote(remote.stdout) : null;
    const repo = raw ? await canonicalRepo(raw) : null;
    return repo && focused.branch ? { repo, branch: focused.branch } : null;
  }

  function trackedForBranch(repo: string, branch: string): Tracked | undefined {
    return [...tracked.values()].find(
      (t) => t.item.repo === repo && t.details.headRefName === branch,
    );
  }

  async function updateStatusBar(): Promise<void> {
    try {
      const f = await focusedPr().catch(() => null);
      const t = f ? trackedForBranch(f.repo, f.branch) : undefined;
      const guide = t ? await getGuide(t.item.key) : null;
      if (t && t.item.status === "generating") {
        await orca.host.call("statusBar.update", {
          id: "guide",
          text: `PR tour: writing #${t.item.number}…`,
          tone: "accent",
          icon: "gauge",
        });
      } else if (guide && t) {
        const level = guide.risk.level;
        await orca.host.call("statusBar.update", {
          id: "guide",
          text: `PR tour: ${level[0].toUpperCase()}${level.slice(1)} risk${t.item.status === "stale" ? " (older commit)" : ""}`,
          tone: level === "high" ? "danger" : level === "medium" ? "warning" : "success",
          tooltip: riskHeadline(guide).slice(0, 200),
          icon: "gauge",
        });
      } else {
        const waiting = [...tracked.values()].filter((x) => x.item.lane !== "authored").length;
        await orca.host.call("statusBar.update", {
          id: "guide",
          text: waiting ? `Reviews: ${waiting}` : "PR tour",
          tone: "neutral",
          tooltip: f ? "Open or generate the guide for this branch" : "PR Tour",
          icon: "gauge",
        });
      }
    } catch (e) {
      orca.log(`status bar: ${message(e)}`);
    }
  }

  /** The focused branch's PR, tracked if it is in the queue, else looked up for a manual run. */
  async function focusedKey(): Promise<string> {
    const f = await focusedPr();
    if (!f)
      throw Object.assign(new Error("Focus a workspace of a GitHub repository first"), {
        code: "unavailable",
      });
    const t = trackedForBranch(f.repo, f.branch);
    if (t) return t.item.key;
    const d = await prDetails(f.repo, f.branch).catch(() => null);
    if (!d) throw Object.assign(new Error(`No open PR for ${f.branch}`), { code: "unavailable" });
    const clones = await localClones();
    const key = keyOf(f.repo, d.number);
    const built = await buildItem(key, "authored", d, f.repo, clones.get(f.repo) ?? null, {
      team: null,
      requestedAt: Date.parse(d.createdAt) || Date.now(),
    });
    tracked.set(key, { ...built, auto: false });
    return key;
  }

  // ---------------------------------------------------------------- wiring

  orca.panels.handle("queue.get", () => state());
  orca.panels.handle("queue.refresh", async () => {
    await refresh();
    return state();
  });
  orca.panels.handle("repo.setOptIn", async ({ repo, optIn }) => {
    await orca.storage.set(`optin:${repo}`, optIn);
    await refresh();
    return state();
  });
  orca.panels.handle("lane.showAuthored", async ({ show }) => {
    await orca.settings.set("includeAuthored", show);
    await refresh();
    return state();
  });
  orca.panels.handle("guide.generate", ({ key }) => {
    if (!tracked.has(key))
      throw Object.assign(new Error("That PR is no longer in your queue"), { code: "conflict" });
    enqueue(key, false);
    return state();
  });
  orca.panels.handle("guide.open", async ({ key }) => ({ opened: await openGuide(key) }));
  orca.panels.handle("review.get", ({ key }) => reviewInfo(key));
  orca.panels.handle("review.save", async ({ key, draft }) => {
    const guide = await requireGuide(key);
    await setDraft(key, asDraft(draft, guide.pr.commit));
    return { saved: true as const };
  });
  orca.panels.handle("review.submit", ({ key, event, body }) => {
    if (event !== "APPROVE" && event !== "REQUEST_CHANGES" && event !== "COMMENT")
      throw Object.assign(new Error("Unknown review event"), { code: "invalid" });
    return submitReview(key, event, typeof body === "string" ? body : "");
  });
  orca.panels.handle("tour.get", ({ key, commit, stops }) => getTour(key, commit, stops));
  orca.panels.handle("tour.save", async ({ key, state }) => {
    await saveTour(key, state);
    return { saved: true as const };
  });
  orca.panels.handle("diff.get", ({ key, path, commit }) => fileDiff(key, path, commit));
  orca.panels.handle("breakdown.get", ({ key, commit }) => breakdown(key, commit));
  orca.panels.handle("skipped.get", ({ key, commit }) => skippedRequest(key, commit));
  orca.panels.handle("file.open", async ({ repo, number, path }) => {
    const guide = await getGuide(keyOf(repo, number));
    const ws = await workspaceFor(repo, guide?.pr.headRef ?? null);
    await orca.host.call("editor.open", { workspaceId: ws.id, path });
    return { opened: true };
  });

  orca.commands.register("refresh", async () => {
    await refresh();
    const s = state();
    return lastError
      ? `Could not check GitHub: ${lastError}`
      : `${s.queue.length} PR${s.queue.length === 1 ? "" : "s"} in your review queue`;
  });
  orca.commands.register("openCurrent", async () => {
    const key = await focusedKey();
    if (await getGuide(key)) {
      await openGuide(key);
      return "Opened the review guide";
    }
    openWhenReady.add(key);
    enqueue(key, false);
    return "No guide for this PR yet: writing one now. It opens when it is ready.";
  });
  orca.commands.register("generateCurrent", async () => {
    const key = await focusedKey();
    openWhenReady.add(key);
    enqueue(key, false);
    return `Writing a review guide for ${key}. It opens when it is ready.`;
  });

  orca.events.on("workspace.changed", ({ context }) => {
    focused = context ? { workspaceId: context.workspaceId, branch: context.branch } : null;
    void updateStatusBar();
  });
  orca.settings.onDidChange(() => void refresh());

  await loadLoginPath();
  const poll = setInterval(() => void refresh(), POLL_MS);
  stopTimers = () => {
    clearInterval(poll);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
  void refresh();
}
