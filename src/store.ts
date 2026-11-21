// The plugin's storage, by what is kept in it. Every read is checked before it is trusted: the
// store is shared with older versions of the plugin and holds only plain JSON.
//
//   guide:<repo#n>  the guide            meta:<repo#n>   what you last saw, the last failure
//   draft:<repo#n>  the review draft     tour:<repo#n>   tour progress
//   optin:<repo>    automatic guides     runs            automatic runs today
import type { OrcaWorkerApi } from "orca/worker";
import { asObj, asString, isObj, plainJson } from "./json";
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
    prune: (tracked: (key: string) => boolean, cutoff: number): Promise<void> =>
      prune(storage, tracked, cutoff),
  };
}
