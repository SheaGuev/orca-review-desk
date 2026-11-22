// Pieces of the guide the tour views draw: headlines with their detail behind "More", sections,
// the Before merge checklist, claims, flows and coverage. Everything
// from a guide goes in as text, never as HTML.
import {
  SEVERITIES,
  type Finding,
  type Point,
  type PrGuide,
  type Severity,
  type SkipReason,
  type StopDepth,
} from "../src/schema";
import { agentNames } from "../src/agent-names";
import { prKey } from "../src/repo";
import { h, prose } from "./dom";

export const RISK_LABEL = { high: "High risk", medium: "Medium risk", low: "Low risk" } as const;
export const SEVERITY_LABEL: Record<Severity, string> = {
  blocker: "Blocker",
  major: "Major",
  minor: "Minor",
  nit: "Nit",
};
export const DEPTH_LABEL: Record<StopDepth, string> = { deep: "Deep", skim: "Skim" };
/**
 * The last step's one name, wherever it shows (the bar's button, Next, the step list, the menu,
 * the heading): it says what the reviewer does there, as GitHub's "Finish your review" does.
 */
export const FINISH = "Finish review";
export const SKIP_LABEL: Record<SkipReason, string> = {
  lockfile: "Lockfile",
  generated: "Generated",
  whitespace: "Whitespace only",
  rename: "Renamed, no changes",
};
const VERDICT = {
  matches: { label: "Matches", cls: "ok" },
  mismatch: { label: "Doesn’t match", cls: "bad" },
  unclear: { label: "Can’t tell", cls: "muted" },
} as const;

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
export const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Paragraphs of agent prose, split on blank lines. */
export function paragraphs(text: string, cls = ""): HTMLElement[] {
  return text
    .split(/\n{2,}/)
    .filter((para) => para.trim())
    .map((para) => h("p", cls ? { class: cls } : {}, prose(para)));
}

/** The detail behind a headline: a native disclosure, so it works by keyboard with no script. */
export function more(detail: string | undefined): HTMLElement | null {
  if (!detail?.trim()) return null;
  return h(
    "details",
    { class: "more" },
    h("summary", {}, "More"),
    h("div", { class: "detail" }, ...paragraphs(detail)),
  );
}

/** What / Why / Impact: the headline alone. Older guides' `detail` is left out on purpose. */
export function pointRow(label: string, p: Point): HTMLElement {
  return h(
    "div",
    { class: "point" },
    h("div", { class: "label" }, label),
    h("p", {}, prose(p.headline)),
  );
}

export function section(
  id: string,
  title: string,
  aside: string | null,
  level: "h2" | "h3",
  ...body: (Node | null)[]
): HTMLElement {
  return h(
    "section",
    { class: "section", "aria-labelledby": id },
    h(
      "div",
      { class: "row baseline" },
      h(level, { id }, title),
      aside ? h("span", { class: "muted small" }, aside) : null,
    ),
    ...body,
  );
}

/** Severity tags for a set of findings, most severe first: "⚑ Major", "⚑ 2 Minor". */
export function severityTags(findings: readonly Finding[]): HTMLElement[] {
  return SEVERITIES.flatMap((sev) => {
    const n = findings.filter((f) => f.severity === sev).length;
    if (!n) return [];
    return [
      h("span", { class: `tag sev ${sev}` }, `⚑ ${n > 1 ? `${n} ` : ""}${SEVERITY_LABEL[sev]}`),
    ];
  });
}

function steps(list: PrGuide["flows"][number]["before"], kind: "before" | "after"): HTMLElement {
  const col = h(
    "div",
    { class: `flow-col ${kind}` },
    h("div", { class: "eyebrow" }, kind === "before" ? "Before" : "After"),
  );
  list.forEach((s, i) => {
    if (i > 0) col.append(h("div", { class: "arrow", "aria-hidden": "true" }, "↓"));
    col.append(
      h(
        "div",
        { class: `step${s.changed ? " changed" : ""}` },
        h("span", {}, prose(s.label)),
        s.changed ? h("span", { class: "tag new" }, "changed") : null,
      ),
    );
  });
  return col;
}

export function flows(guide: PrGuide): HTMLElement[] {
  return guide.flows.map((f, i) =>
    section(
      `flow-h-${i}`,
      f.title,
      "flow",
      "h3",
      h("div", { class: "flows" }, steps(f.before, "before"), steps(f.after, "after")),
    ),
  );
}

/**
 * Before merge: the steps outside the code review the merge depends on, as a checklist. Shown only
 * when the guide has some; headlines only, since each is one action.
 */
export function checklist(guide: PrGuide, level: "h2" | "h3" = "h2"): HTMLElement | null {
  if (!guide.risk.beforeMerge.length) return null;
  const list = h("ul", { class: "checklist" });
  guide.risk.beforeMerge.forEach((step, i) => {
    // Ticks are a reading aid for this reviewer, kept in this frame's own storage per commit.
    const id = `check:${prKey(guide.pr.repo, guide.pr.number)}@${guide.pr.commit}:${i}`;
    const input = h("input", { type: "checkbox" });
    try {
      input.checked = localStorage.getItem(id) === "1";
    } catch {
      // storage unavailable: the tick just isn't remembered
    }
    input.addEventListener("change", () => {
      try {
        localStorage.setItem(id, input.checked ? "1" : "0");
      } catch {
        // ignore
      }
    });
    list.append(
      h("li", {}, h("label", { class: "check" }, input, h("span", {}, prose(step.headline)))),
    );
  });
  return section("before-h", "Before merge", null, level, list);
}

export function claims(guide: PrGuide): HTMLElement | null {
  // Nothing to check (no description, or one that claims nothing) is a section with nothing in it.
  if (!guide.claimsCheck.length) return null;
  return section(
    "claims-h",
    "Claims check",
    "the PR description against the diff",
    "h3",
    h(
      "ul",
      { class: "rows" },
      ...guide.claimsCheck.map((c) =>
        h(
          "li",
          { class: "claim" },
          h("span", { class: `tag ${VERDICT[c.verdict].cls}` }, VERDICT[c.verdict].label),
          h(
            "div",
            { class: "measure" },
            h("strong", {}, "“", prose(c.claim), "”"),
            h("p", { class: "muted" }, prose(c.evidence)),
          ),
        ),
      ),
    ),
  );
}

export function coverageLine(guide: PrGuide): HTMLElement | null {
  const c = guide.coverage;
  if (!c?.notRead.length) return null;
  const total = c.notRead.length + new Set([...c.inPrompt, ...c.readByAgent]).size;
  const agent = agentNames(guide.generatedBy.harness);
  return h(
    "p",
    { class: "coverage small", role: "note" },
    h("strong", {}, `Agent read ${total - c.notRead.length} of ${total} files`),
    ` · not read: `,
    ...c.notRead.flatMap((f, i) => [i ? ", " : "", h("span", { class: "mono" }, f)]),
    agent && !agent.toolEvents
      ? `. ${agent.label} does not report which files it opened, so only the prompt counts.`
      : "",
  );
}

function when(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

/** Who wrote the guide, when, at which commit; with Regenerate. */
/** Which agent made the guide, when, and for which commit. */
export function provenance(guide: PrGuide): (Node | string)[] {
  const g = guide.generatedBy;
  return [
    `${agentNames(g.harness)?.label ?? g.harness}${g.model ? ` · ${g.model}` : ""} · ${when(g.at)} · `,
    h("span", { class: "mono" }, guide.pr.commit.slice(0, 7)),
  ];
}

export function footer(guide: PrGuide): HTMLElement {
  return h(
    "footer",
    { class: "footer muted small" },
    ...provenance(guide),
    guide.trimmed ? " · Details were left out of this guide to fit Orca's storage." : "",
  );
}
