// The tour covers every changed file exactly once. The agent is asked to (and gets one repair round
// for it); this is what the worker does with whatever comes back, so coverage is always complete.
// Pure, and also run when a guide is opened, so guides written before full coverage get there too.
import {
  DEEP_SEVERITIES,
  SEVERITIES,
  type Finding,
  type PrGuide,
  type SkippedFile,
  type Stop,
  type TourRules,
} from "./schema";

/** The stop that collects files the agent left out of every stop. */
export const OTHER_HEADLINE = "Other changes the agent didn’t place in a stop";

/** What enforcing coverage knows and builds up as it goes through the stops. */
type Pass = {
  rules: TourRules;
  isChanged: ReadonlySet<string>;
  /** Files with a blocker or major finding, to their most severe one's headline. */
  severe: ReadonlyMap<string, string>;
  /** Files already in a stop. */
  placed: Set<string>;
  out: Stop[];
  fixed: string[];
};

const mustBeDeep = (p: Pass, f: string): boolean => p.severe.has(f) || p.rules.risky.has(f);

/** Why a group must be deep: a severe finding outranks a risky kind. */
const deepWhy = (p: Pass, files: readonly string[]): Stop["why"] =>
  files.some((f) => p.severe.has(f)) ? "finding" : "risky";

/** The stop's files that stay in the tour here: changed, not skipped, not in an earlier stop. */
function keptFiles(p: Pass, s: Stop, i: number): string[] {
  return s.files.filter((f) => {
    const reason = p.rules.skipped.get(f);
    if (reason) p.fixed.push(`stop ${i + 1}: ${f} is skipped by design (${reason}), taken out`);
    else if (!p.isChanged.has(f)) p.fixed.push(`stop ${i + 1}: ${f} is not changed, taken out`);
    else if (p.placed.has(f)) p.fixed.push(`stop ${i + 1}: ${f} is in an earlier stop, kept there`);
    else {
      p.placed.add(f);
      return true;
    }
    return false;
  });
}

/** Rules 1 and 2 for one stop: what is left of it, made deep when a file in it must be. */
function placeStop(p: Pass, s: Stop, i: number): void {
  const files = keptFiles(p, s, i);
  if (!files.length) {
    p.fixed.push(`stop ${i + 1}: no files left, dropped`);
    return;
  }
  const { focus, ...rest } = s;
  // Focus is on the first file, so it stays only while that file still leads the stop.
  const kept: Stop =
    focus && files[0] === s.files[0] ? { ...rest, files, focus } : { ...rest, files };
  const deep = s.depth === "skim" ? files.filter((f) => mustBeDeep(p, f)) : [];
  if (!deep.length) {
    p.out.push(kept);
    return;
  }
  const { differences: _d, ...text } = kept;
  p.out.push({ ...text, depth: "deep", why: deepWhy(p, deep) });
  p.fixed.push(`stop ${i + 1}: made deep for ${deep.join(", ")}`);
}

/** Rule 3: files in no stop go in one "Other changes" stop, deep when any of them must be. */
function placeMissing(p: Pass, changed: readonly string[]): void {
  const missing = changed.filter((f) => !p.placed.has(f) && !p.rules.skipped.has(f));
  if (!missing.length) return;
  const deep = missing.filter((f) => mustBeDeep(p, f));
  // The first file is the one a group leads with, so one that must be read closely goes first.
  const files = [...deep, ...missing.filter((f) => !deep.includes(f))];
  p.out.push({
    ...(deep.length ? { depth: "deep", why: deepWhy(p, deep) } : { depth: "skim", why: "routine" }),
    files,
    areaId: "other",
    headline: OTHER_HEADLINE,
  });
  p.fixed.push(
    `${missing.length} file(s) in no stop, added to "Other changes": ${files.join(", ")}`,
  );
}

/**
 * The stops with every rule applied, and what changed (for the log):
 *
 * 1. Skipped files, files the PR doesn't change, and files already in an earlier stop leave the
 *    stop; a stop left with no file is dropped. Focus belongs to the first file, so it goes when
 *    that file does.
 * 2. A skim stop holding a risky file or one with a blocker or major finding becomes deep, its
 *    files kept together: the tour is a few groups, so a file never gets a stop of its own here.
 * 3. Files in no stop are appended in one stop, "Other changes": deep (those files first) when any
 *    of them must be, else skim.
 */
export function enforceCoverage(
  stops: readonly Stop[],
  changed: readonly string[],
  findings: readonly Pick<Finding, "file" | "severity" | "headline">[],
  rules: TourRules,
): { stops: Stop[]; fixed: string[] } {
  const severe = new Map<string, string>();
  for (const sev of SEVERITIES.filter((s) => DEEP_SEVERITIES.includes(s)))
    for (const f of findings)
      if (f.severity === sev && !severe.has(f.file)) severe.set(f.file, f.headline);
  const pass: Pass = {
    rules,
    isChanged: new Set(changed),
    severe,
    placed: new Set(),
    out: [],
    fixed: [],
  };
  stops.forEach((s, i) => placeStop(pass, s, i));
  placeMissing(pass, changed);
  return { stops: pass.out, fixed: pass.fixed };
}

/**
 * A stored guide's stops with full coverage, as the tab and the queue use them. A guide written
 * with full coverage comes back as it is; one from before gets its missing files in "Other
 * changes" and loses stops on files now skipped.
 */
export function fullTour(guide: PrGuide, skipped: readonly SkippedFile[]): Stop[] {
  const changed = [
    ...new Set([
      ...guide.readingOrder.flatMap((s) => s.files),
      ...guide.files.map((f) => f.path),
      ...Object.keys(guide.commentable),
      ...guide.areas.flatMap((a) => a.files),
    ]),
  ];
  return enforceCoverage(guide.readingOrder, changed, guide.findings, {
    skipped: new Map(skipped.map((s) => [s.path, s.reason])),
    risky: new Map(),
  }).stops;
}
