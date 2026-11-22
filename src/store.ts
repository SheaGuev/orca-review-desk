// The plugin's storage, by what is kept in it. Every read is checked before it is trusted: the
// store is shared with older versions of the plugin and holds only plain JSON.
//
//   guide:<repo#n>  the guide            meta:<repo#n>   what you last saw, the last failure
//   draft:<repo#n>  the review draft     tour:<repo#n>   tour progress
//   optin:<repo>    automatic guides     runs            automatic runs today
//   lastCheck       the PRs the last check found, so a restart lists them before checking
import type { OrcaWorkerApi } from "orca/worker";
import { asObj, asString, isObj, plainJson } from "./json";
import type { QueueItem } from "./protocol";
import { asDraft, type Draft } from "./review";
import { parseGuide, SCHEMA_ID, upgradeGuide, type PrGuide, type PrGuideV1 } from "./schema";
import { tourKey, type TourState } from "./tour";

type Storage = OrcaWorkerApi["storage"];

export type StoredGuide = PrGuide | PrGuideV1;

/** What the worker remembers about a PR besides its guide. */
export type Meta = {
  /** The guide commit you last opened, or the head you last reviewed. */
  lastViewedCommit?: string;
  /** The last run's failure and the head it failed on. */
  error?: string;
  errorCommit?: string;
};

/** The local date, so the daily limit resets at the person's midnight, not UTC's. */
export const localDay = (at = new Date()): string => at.toLocaleDateString("en-CA");

/** A stored value as a guide of either version, or null when it is not one the tab could draw. */
function asGuide(value: unknown): StoredGuide | null {
  const parsed = parseGuide(value);
  return parsed.ok ? parsed.guide : null;
}

function asMeta(value: unknown): Meta {
  if (!isObj(value)) return {};
  const meta: Meta = {};
  if (typeof value.lastViewedCommit === "string") meta.lastViewedCommit = value.lastViewedCommit;
  if (typeof value.error === "string") meta.error = value.error;
  if (typeof value.errorCommit === "string") meta.errorCommit = value.errorCommit;
  return meta;
}

/** A PR as the last check found it on GitHub; its guide and run state are read afresh. */
export type SavedPr = Pick<
  QueueItem,
  | "key"
  | "repo"
  | "number"
  | "title"
  | "author"
  | "url"
  | "lane"
  | "draft"
  | "additions"
  | "deletions"
  | "changedFiles"
  | "headSha"
  | "hasClone"
  | "requestedAt"
  | "team"
  | "ownedFiles"
  | "manualReason"
> & { branch: string };

/** The PRs the last successful check found, and when it ran. */
export type LastCheck = { checkedAt: number; prs: SavedPr[] };

const isString = (v: unknown): v is string => typeof v === "string";
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function asSavedPr(v: unknown): SavedPr | null {
  if (!isObj(v)) return null;
  const { key, repo, number, title, author, url, lane, draft, additions, deletions } = v;
  const { changedFiles, headSha, hasClone, requestedAt, team, ownedFiles, manualReason } = v;
  const { branch } = v;
  if (
    !isString(key) ||
    !isString(repo) ||
    !isString(title) ||
    !isString(author) ||
    !isString(url) ||
    !isString(headSha) ||
    !isString(branch) ||
    !isNumber(number) ||
    !isNumber(additions) ||
    !isNumber(deletions) ||
    !isNumber(changedFiles) ||
    !isNumber(requestedAt) ||
    (lane !== "user" && lane !== "team" && lane !== "authored") ||
    typeof draft !== "boolean" ||
    typeof hasClone !== "boolean" ||
    !(team === null || isString(team)) ||
    !(ownedFiles === null || isNumber(ownedFiles)) ||
    !(manualReason === null || isString(manualReason))
  )
    return null;
  return {
    key,
    repo,
    number,
    title,
    author,
    url,
    lane,
    draft,
    additions,
    deletions,
    changedFiles,
    headSha,
    hasClone,
    requestedAt,
    team,
    ownedFiles,
    manualReason,
    branch,
  };
}

/** The saved list, or null when there is none or any part of it is not in this shape. */
function asLastCheck(v: unknown): LastCheck | null {
  if (!isObj(v) || !isNumber(v.checkedAt) || !Array.isArray(v.prs)) return null;
  const prs = v.prs.map(asSavedPr);
  return prs.every((p) => p !== null) ? { checkedAt: v.checkedAt, prs } : null;
}

export type Store = ReturnType<typeof createStore>;

/** Automatic runs counted so far today. */
async function runsToday(storage: Storage): Promise<number> {
  const v = await storage.get("runs");
  return isObj(v) && v.day === localDay() && typeof v.count === "number" ? v.count : 0;
}

/**
 * Storage holds 5 MiB and 1,024 keys: forgets everything about PRs that are not `tracked` and
 * whose guide was written before `cutoff`.
 */
async function prune(
  storage: Storage,
  tracked: (key: string) => boolean,
  cutoff: number,
): Promise<void> {
  for (const storageKey of await storage.keys()) {
    if (!storageKey.startsWith("guide:")) continue;
    const key = storageKey.slice("guide:".length);
    if (tracked(key)) continue;
    // Read as stored, not as a checked guide: one this version can no longer draw still ages out.
    const written = asObj(asObj(await storage.get(storageKey)).generatedBy).at;
    if (!(Date.parse(asString(written)) < cutoff)) continue;
    await Promise.all([
      storage.delete(storageKey),
      storage.delete(`meta:${key}`),
      storage.delete(`draft:${key}`),
      storage.delete(tourKey(key)),
    ]);
  }
}

export function createStore(storage: Storage) {
  return {
    /** The stored guide; a v2 guide comes back in the current shape (stops with depth and files). */
    guide: async (key: string): Promise<StoredGuide | null> => {
      const g = asGuide(await storage.get(`guide:${key}`));
      return g?.schema === SCHEMA_ID ? upgradeGuide(g) : g;
    },
    setGuide: (key: string, value: PrGuide): Promise<void> =>
      storage.set(`guide:${key}`, plainJson(value)),

    meta: async (key: string): Promise<Meta> => asMeta(await storage.get(`meta:${key}`)),
    setMeta: (key: string, meta: Meta): Promise<void> =>
      storage.set(`meta:${key}`, plainJson(meta)),

    /** Whether guides are made automatically in `repo`; null until the person answered. */
    optIn: async (repo: string): Promise<boolean | null> => {
      const v = await storage.get(`optin:${repo}`);
      return typeof v === "boolean" ? v : null;
    },
    setOptIn: (repo: string, optIn: boolean): Promise<void> => storage.set(`optin:${repo}`, optIn),

    draft: async (key: string, commit: string): Promise<Draft> =>
      asDraft(await storage.get(`draft:${key}`), commit),
    setDraft: (key: string, draft: Draft): Promise<void> =>
      storage.set(`draft:${key}`, plainJson(draft)),
    deleteDraft: (key: string): Promise<void> => storage.delete(`draft:${key}`),

    /** Tour progress as stored; `tourState` checks it against the guide it is read for. */
    tour: (key: string): Promise<unknown> => storage.get(tourKey(key)),
    setTour: (key: string, state: TourState): Promise<void> =>
      storage.set(tourKey(key), plainJson(state)),

    runsToday: (): Promise<number> => runsToday(storage),
    /** Counts one more automatic run today and answers the new total. */
    countRun: async (): Promise<number> => {
      const count = (await runsToday(storage)) + 1;
      await storage.set("runs", { day: localDay(), count });
      return count;
    },
    lastCheck: async (): Promise<LastCheck | null> => asLastCheck(await storage.get("lastCheck")),
    setLastCheck: (value: LastCheck): Promise<void> => storage.set("lastCheck", plainJson(value)),
    prune: (tracked: (key: string) => boolean, cutoff: number): Promise<void> =>
      prune(storage, tracked, cutoff),
  };
}
