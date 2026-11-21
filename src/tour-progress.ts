// How far a reviewer got through a guide's tour, for the queue row: "18 of 23 files".
import { fullTour } from "./coverage";
import { message } from "./errors";
import { SCHEMA_ID, type SkippedFile } from "./schema";
import type { StoredGuide } from "./store";
import { tourLabel, type TourShape } from "./tour";

export type TourProgress = {
  /**
   * The tour of a current-version guide as progress counts it: its stops with full coverage, then
   * the skipped files (asked of git for a guide written before they were stored). Null for v1.
   */
  shape: (key: string, guide: StoredGuide | null) => Promise<TourShape | null>;
  /** The queue row's progress line for `stored` tour state; null for v1 guides, which have no tour. */
  label: (key: string, guide: StoredGuide | null, stored: unknown) => Promise<string | null>;
};

export function createTourProgress(deps: {
  /** A guide's skipped files at a commit, from git when the guide did not store them. */
  skipped: (guide: StoredGuide, key: string, commit: string) => Promise<SkippedFile[]>;
  log: (text: string) => void;
}): TourProgress {
  const shape: TourProgress["shape"] = async (key, guide) => {
    if (guide?.schema !== SCHEMA_ID) return null;
    const skipped =
      guide.skipped ??
      (await deps.skipped(guide, key, guide.pr.commit).catch((e: unknown) => {
        deps.log(`${key}: skipped files: ${message(e)}`);
        return [];
      }));
    return { stops: fullTour(guide, skipped), skipped: skipped.map((f) => f.path) };
  };
  return {
    shape,
    label: async (key, guide, stored) => {
      const tour = await shape(key, guide);
      return tour && guide ? tourLabel(stored, guide.pr.commit, tour) : null;
    },
  };
}
