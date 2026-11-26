// One PR as the queue shows it: found by a search, then filled in from storage and the local
// clone (its guide, tour progress, draft, and whether a guide is made for it automatically).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Clone } from "./git";
import { mapLimit } from "./cache";
import { GH_AT_ONCE, searchPrs, type PrDetails, type SearchHit } from "./github";
import type { ItemStatus, Lane, QueueItem } from "./protocol";
import { countOwnedFiles, isLockfileOnly, parseCodeowners, prKey } from "./repo";
import { riskHeadline, SCHEMA_ID } from "./schema";
import type { Settings } from "./settings";
import type { Meta, SavedPr, Store, StoredGuide } from "./store";

const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

/** A PR the worker follows: its queue row, its head branch, and where its code is locally. */
export type Tracked = { item: QueueItem; branch: string; clone: Clone | null; auto: boolean };

/** A PR a search found, the lane it came in by and, for a team request, the team. */
export type Found = { hit: SearchHit; lane: Lane; team: string | null };

/** What an agent run is doing for a PR right now, if anything. */
export type RunState = "generating" | "queued" | null;

/** Every lane's search, GH_AT_ONCE at a time; a PR found by several keeps the first lane, in this order. */
export async function searchLanes(
  settings: Pick<Settings, "teams" | "includeAuthored">,
): Promise<Map<string, Found>> {
  const lanes: { qualifier: string; lane: Lane; team: string | null }[] = [
    { qualifier: "user-review-requested:@me", lane: "user", team: null },
    ...settings.teams.map((team) => ({
      qualifier: `team-review-requested:${team}`,
      lane: "team" as const,
      team,
    })),
    ...(settings.includeAuthored
      ? [{ qualifier: "author:@me", lane: "authored" as const, team: null }]
      : []),
  ];
  const results = await mapLimit(lanes, GH_AT_ONCE, (l) => searchPrs(l.qualifier));
  const found = new Map<string, Found>();
  lanes.forEach(({ lane, team }, i) => {
    for (const hit of results[i] ?? []) {
      const key = prKey(hit.repo, hit.number);
      if (!found.has(key)) found.set(key, { hit, lane, team });
    }
  });
  return found;
}

/** How many of `files` the person's teams own per the clone's CODEOWNERS; null when it has none. */
async function ownedFiles(
  clone: Clone | null,
  files: readonly string[],
  teams: readonly string[],
): Promise<number | null> {
  if (!clone || teams.length === 0) return null;
  const texts = await Promise.all(
    CODEOWNERS_PATHS.map((rel) => readFile(join(clone.path, rel), "utf8").catch(() => null)),
  );
  // The first of the three places that has one, as GitHub reads them.
  const text = texts.find((t) => t !== null);
  return typeof text === "string" ? countOwnedFiles(parseCodeowners(text), files, teams) : null;
}

/** Authors whose PRs get automatic runs; anyone else's PR is only run when the person asks. */
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** Why this PR gets no automatic guide, or null when it does. */
export function manualReason(
  pr: { lane: Lane; details: PrDetails; owned: number | null; association: string | null },
  repo: { optIn: boolean | null; hasClone: boolean },
  settings: Settings,
): string | null {
  const { lane, details: d } = pr;
  if (!repo.hasClone) return "No local clone in Orca";
  if (repo.optIn !== true)
    return repo.optIn === false ? "Repository turned off" : "Repository not turned on yet";
  if (d.isDraft && settings.skipDrafts) return "Draft";
  // A stranger's PR (say, through a CODEOWNERS team request) is not run unasked. Your own are.
  if (lane !== "authored" && !TRUSTED.has(pr.association ?? ""))
    return pr.association === null
      ? "Couldn't check the author's access"
      : "Author is not a collaborator";
  if (lane === "user" && !settings.autoRequested) return "Automatic guides are off";
  if (lane === "team") {
    if (!settings.autoTeams) return "Automatic team guides are off";
    if (d.additions + d.deletions < settings.teamMinLines)
      return `Under ${settings.teamMinLines} lines`;
    if (settings.teamRequireOwnership && pr.owned === 0) return "No files your teams own";
  }
  return null;
}

/** Where the guide for a PR at `head` stands. */
export function statusOf(input: {
  run: RunState;
  guide: StoredGuide | null;
  meta: Meta;
  head: string;
  lockfileOnly: boolean;
}): ItemStatus {
  const { guide, meta, head } = input;
  if (input.run) return input.run;
  // A guide made by an older version counts as stale, so the next automatic run replaces it.
  if (guide?.schema === SCHEMA_ID && guide.pr.commit === head) return "ready";
  if (meta.error && meta.errorCommit === head) return "failed";
  if (guide) return "stale";
  return input.lockfileOnly ? "lockfile" : "none";
}

export type PrFound = {
  key: string;
  repo: string;
  lane: Lane;
  details: PrDetails;
  clone: Clone | null;
  team: string | null;
  requestedAt: number;
  /** GitHub's author_association; null when unknown or not asked (your own PRs). */
  association: string | null;
};

/** The part of a queue row that comes straight from GitHub and the search that found the PR. */
function rowBase(pr: PrFound) {
  const { key, repo, lane, details: d, clone } = pr;
  return {
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
    hasClone: clone !== null,
    requestedAt: pr.requestedAt,
    team: pr.team,
    position: null,
    repoLabel: repo,
  };
}

type ItemDeps = {
  store: Store;
  settings: Settings;
  run: RunState;
  tourLabel: (key: string, guide: StoredGuide | null, stored: unknown) => Promise<string | null>;
};

/** The parts of a queue row read from storage and the runs under way, for the PR at `head`. */
async function storedParts(key: string, head: string, lockfileOnly: boolean, deps: ItemDeps) {
  const { store } = deps;
  const [guide, meta, tour, draft] = await Promise.all([
    store.guide(key),
    store.meta(key),
    store.tour(key),
    store.draft(key, head),
  ]);
  const status = statusOf({ run: deps.run, guide, meta, head, lockfileOnly });
  return {
    status,
    risk: guide?.risk.level ?? null,
    riskSummary: guide ? riskHeadline(guide) : null,
    newSinceYourReview: Boolean(meta.lastViewedCommit && meta.lastViewedCommit !== head),
    error: status === "failed" ? (meta.error ?? null) : null,
    tour: status === "ready" ? await deps.tourLabel(key, guide, tour) : null,
    pendingComments: draft.comments.length,
  };
}

/** The PR with everything the queue row shows, read from storage and the local clone. */
export async function buildItem(pr: PrFound, deps: ItemDeps): Promise<Tracked> {
  const { key, repo, lane, details: d, clone } = pr;
  const files = d.files.map((f) => f.path);
  const lockfileOnly = isLockfileOnly(files);
  const [stored, optIn, owned] = await Promise.all([
    storedParts(key, d.headRefOid, lockfileOnly, deps),
    deps.store.optIn(repo),
    lane === "team" ? ownedFiles(clone, files, deps.settings.teams) : null,
  ]);
  const reason = lockfileOnly
    ? "Lockfile only"
    : manualReason(
        { lane, details: d, owned, association: pr.association },
        { optIn, hasClone: clone !== null },
        deps.settings,
      );
  return {
    branch: d.headRefName,
    clone,
    auto: reason === null,
    item: { ...rowBase(pr), ...stored, ownedFiles: owned, manualReason: reason },
  };
}

/** What the last check knew of a tracked PR, saved so a restarted worker can list it again. */
export function savedPr(t: Tracked, association: string | undefined): SavedPr {
  const { item: i } = t;
  return {
    ...(association ? { association } : {}),
    key: i.key,
    repo: i.repo,
    number: i.number,
    title: i.title,
    author: i.author,
    url: i.url,
    lane: i.lane,
    draft: i.draft,
    additions: i.additions,
    deletions: i.deletions,
    changedFiles: i.changedFiles,
    headSha: i.headSha,
    hasClone: i.hasClone,
    requestedAt: i.requestedAt,
    team: i.team,
    ownedFiles: i.ownedFiles,
    manualReason: i.manualReason,
    branch: t.branch,
  };
}

/**
 * A saved PR tracked again, its guide and run state read as `buildItem` reads them. The clone is
 * found again when needed; the next check replaces the whole entry.
 */
export async function restoreItem(saved: SavedPr, deps: ItemDeps): Promise<Tracked> {
  const { branch, association: _association, ...row } = saved;
  const lockfileOnly = saved.manualReason === "Lockfile only";
  return {
    branch,
    clone: null,
    auto: saved.manualReason === null,
    item: {
      ...row,
      position: null,
      repoLabel: saved.repo,
      ...(await storedParts(saved.key, saved.headSha, lockfileOnly, deps)),
    },
  };
}
