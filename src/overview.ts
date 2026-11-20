// What the guide tab's overview shows about findings (their order, which ones wait behind
// "Show more", which tour stop each one belongs to) and about changed files (the stop to review
// each in). Pure, so it is tested without a DOM.
import type { Finding, LineRange, Severity } from "./schema";
import { SEVERITIES } from "./schema";

/** Findings listed before the rest wait behind "Show N more": few enough that the tour stays in view. */
export const FINDINGS_SHOWN = 3;

const rank = (s: Severity) => SEVERITIES.indexOf(s);

/** Blocker → major → minor → nit; the agent's order within a severity. */
export function sortFindings<F extends Pick<Finding, "severity">>(findings: readonly F[]): F[] {
  return findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => rank(a.f.severity) - rank(b.f.severity) || a.i - b.i)
    .map(({ f }) => f);
}

/**
 * The sorted findings split into what is listed at once and what waits behind "Show N more": the
 * `shown` most severe, so the overview keeps the tour in view however many findings there are.
 */
export function splitFindings<F extends Pick<Finding, "severity">>(
  findings: readonly F[],
  shown = FINDINGS_SHOWN,
): { visible: F[]; hidden: F[] } {
  const sorted = sortFindings(findings);
  return { visible: sorted.slice(0, shown), hidden: sorted.slice(shown) };
}

/** A stop as far as finding where things are: its files, and focus ranges on the first one. */
export type StopLike = { files: readonly string[]; focus?: readonly LineRange[] };

/**
 * The stop that shows a finding: a stop whose first file it is on, with focus covering its line,
 * else the first stop holding its file; null when no stop holds the file.
 */
export function stopForFinding(
  stops: readonly StopLike[],
  finding: Pick<Finding, "file" | "line">,
): number | null {
  const onFile = stops.flatMap((s, i) => (s.files.includes(finding.file) ? [i] : []));
  if (!onFile.length) return null;
  const { line } = finding;
  const covering =
    line === null
      ? undefined
      : onFile.find(
          (i) =>
            stops[i].files[0] === finding.file &&
            stops[i].focus?.some((r) => line >= r.start && line <= r.end),
        );
  return covering ?? onFile[0];
}

/** "2 major · 6 minor · 4 nit": the counts as text, most severe first. */
export function severityCounts(findings: readonly Pick<Finding, "severity">[]): string {
  return SEVERITIES.flatMap((sev) => {
    const n = findings.filter((f) => f.severity === sev).length;
    return n ? [`${n} ${sev}`] : [];
  }).join(" · ");
}

/** The first stop holding a file, or null when no stop does. */
export function stopForFile(
  stops: readonly { files: readonly string[] }[],
  path: string,
): number | null {
  const i = stops.findIndex((s) => s.files.includes(path));
  return i === -1 ? null : i;
}
