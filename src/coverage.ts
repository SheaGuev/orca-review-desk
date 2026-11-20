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

/** The skim stop that collects files the agent left out of every stop. */
export const OTHER_HEADLINE = "Other changes the agent didn’t place in a stop";

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The stops with every rule applied, and what changed (for the log):
 *
 * 1. Skipped files, files the PR doesn't change, and files already in an earlier stop leave the
 *    stop; a stop left with no file is dropped. Focus belongs to the first file, so it goes when
 *    that file does.
 * 2. Risky files and files with a blocker or major finding in a skim stop move to a deep stop of
 *    their own, placed right after it (the first one takes the skim's text if nothing is left).
 * 3. Files in no stop are appended: risky or severe ones each as a deep stop, the rest in one skim
 *    stop, "Other changes".
 */
export function enforceCoverage(
  stops: readonly Stop[],
  changed: readonly string[],
  findings: readonly Pick<Finding, "file" | "severity" | "headline">[],
  rules: TourRules,
): { stops: Stop[]; fixed: string[] } {
  const fixed: string[] = [];
  const isChanged = new Set(changed);
  /** The most severe blocker or major finding per file: its headline names the deep stop. */
  const severe = new Map<string, string>();
  for (const sev of SEVERITIES.filter((s) => DEEP_SEVERITIES.includes(s)))
    for (const f of findings)
      if (f.severity === sev && !severe.has(f.file)) severe.set(f.file, f.headline);
  const mustBeDeep = (f: string) => severe.has(f) || rules.risky.has(f);
  const deepStop = (file: string, areaId: string): Stop => ({
    depth: "deep",
    files: [file],
    why: severe.has(file) ? "finding" : "risky",
    areaId,
    headline:
      severe.get(file) ?? `${capital(rules.risky.get(file) ?? "file")} ${basename(file)} changed`,
  });

  const placed = new Set<string>();
  const out: Stop[] = [];
  stops.forEach((s, i) => {
    const files = s.files.filter((f) => {
      const reason = rules.skipped.get(f);
      if (reason) fixed.push(`stop ${i + 1}: ${f} is skipped by design (${reason}), taken out`);
      else if (!isChanged.has(f)) fixed.push(`stop ${i + 1}: ${f} is not changed, taken out`);
      else if (placed.has(f)) fixed.push(`stop ${i + 1}: ${f} is in an earlier stop, kept there`);
      else {
        placed.add(f);
        return true;
      }
      return false;
    });
    if (!files.length) {
      fixed.push(`stop ${i + 1}: no files left, dropped`);
      return;
    }
    const { focus, ...rest } = s;
    /** The stop on `list`, keeping focus only while its first file is still the one focused. */
    const on = (base: Omit<Stop, "focus">, list: string[]): Stop =>
      focus && list[0] === s.files[0] ? { ...base, files: list, focus } : { ...base, files: list };
    const moving = s.depth === "skim" ? files.filter(mustBeDeep) : [];
    if (!moving.length) {
      out.push(on(rest, files));
      return;
    }
    const staying = files.filter((f) => !moving.includes(f));
    const moved = moving.map((f) => deepStop(f, s.areaId));
    for (const m of moved)
      fixed.push(`stop ${i + 1}: ${m.files[0]} moved from a skim stop to its own deep stop`);
    if (staying.length) out.push(on(rest, staying));
    else {
      // Nothing routine left: the first moved file keeps the stop's explanation.
      const { depth: _d, why: _w, differences: _x, ...text } = rest;
      moved[0] = on({ ...text, depth: "deep", why: moved[0].why }, [moving[0]]);
    }
    out.push(...moved);
  });

  const missing = changed.filter((f) => !placed.has(f) && !rules.skipped.has(f));
  const routine = missing.filter((f) => !mustBeDeep(f));
  for (const f of missing.filter(mustBeDeep)) {
    out.push(deepStop(f, "other"));
    fixed.push(`${f}: in no stop, given its own deep stop`);
  }
  if (routine.length) {
    out.push({
      depth: "skim",
      files: routine,
      why: "routine",
      areaId: "other",
      headline: OTHER_HEADLINE,
    });
    fixed.push(
      `${routine.length} file(s) in no stop, added to "Other changes": ${routine.join(", ")}`,
    );
  }
  return { stops: out, fixed };
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
