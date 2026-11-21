// One PR as the queue shows it: found by a search, then filled in from storage and the local
// clone (its guide, tour progress, draft, and whether a guide is made for it automatically).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Clone } from "./git";
import { searchPrs, type PrDetails, type SearchHit } from "./github";
import type { ItemStatus, Lane, QueueItem } from "./protocol";
import { countOwnedFiles, isLockfileOnly, parseCodeowners, prKey } from "./repo";
import { riskHeadline, SCHEMA_ID } from "./schema";
import type { Settings } from "./settings";
import type { Meta, Store, StoredGuide } from "./store";

const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

/** A PR the worker follows: its queue row, GitHub's details, and where its code is locally. */
export type Tracked = { item: QueueItem; details: PrDetails; clone: Clone | null; auto: boolean };

/** A PR a search found, the lane it came in by and, for a team request, the team. */
export type Found = { hit: SearchHit; lane: Lane; team: string | null };

/** What an agent run is doing for a PR right now, if anything. */
export type RunState = "generating" | "queued" | null;

/** Every lane's search at once; a PR found by several keeps the first lane, in this order. */
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
  const results = await Promise.all(lanes.map((l) => searchPrs(l.qualifier)));
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

/** Why this PR gets no automatic guide, or null when it does. */
export function manualReason(
  pr: { lane: Lane; details: PrDetails; owned: number | null },
  repo: { optIn: boolean | null; hasClone: boolean },
  settings: Settings,
): string | null {
  const { lane, details: d } = pr;
  if (!repo.hasClone) return "No local clone in Orca";
  if (repo.optIn !== true)
    return repo.optIn === false ? "Repository turned off" : "Repository not turned on yet";
  if (d.isDraft && settings.skipDrafts) return "Draft";
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

/** The PR with everything the queue row shows, read from storage and the local clone. */
export async function buildItem(
  pr: PrFound,
  deps: {
    store: Store;
    settings: Settings;
    run: RunState;
    tourLabel: (key: string, guide: StoredGuide | null, stored: unknown) => Promise<string | null>;
  },
): Promise<Tracked> {
  const { key, repo, lane, details: d, clone } = pr;
  const { store, settings } = deps;
  const files = d.files.map((f) => f.path);
  const [guide, meta, optIn, tour, draft, owned] = await Promise.all([
    store.guide(key),
    store.meta(key),
    store.optIn(repo),
    store.tour(key),
    store.draft(key, d.headRefOid),
    lane === "team" ? ownedFiles(clone, files, settings.teams) : null,
  ]);
  const lockfileOnly = isLockfileOnly(files);
  const reason = lockfileOnly
    ? "Lockfile only"
    : manualReason({ lane, details: d, owned }, { optIn, hasClone: clone !== null }, settings);
  const status = statusOf({ run: deps.run, guide, meta, head: d.headRefOid, lockfileOnly });
  return {
    details: d,
    clone,
    auto: reason === null,
    item: {
      ...rowBase(pr),
      status,
      risk: guide?.risk.level ?? null,
      riskSummary: guide ? riskHeadline(guide) : null,
      newSinceYourReview: Boolean(meta.lastViewedCommit && meta.lastViewedCommit !== d.headRefOid),
      ownedFiles: owned,
      manualReason: reason,
      error: status === "failed" ? (meta.error ?? null) : null,
      tour: status === "ready" ? await deps.tourLabel(key, guide, tour) : null,
      pendingComments: draft.comments.length,
    },
  };
}
