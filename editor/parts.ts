// Pieces of the guide the tour views draw: headlines with their detail behind "More", sections,
// the Before merge checklist, claims, flows and coverage. Everything
// from a guide goes in as text, never as HTML.
import type {
  Finding,
  Point,
  PrGuide,
  Severity,
  SkipReason,
  StopDepth,
  StopWhy,
} from "../src/schema";
import { SEVERITIES } from "../src/schema";
import { h, prose } from "./dom";

export const RISK_LABEL = { high: "High risk", medium: "Medium risk", low: "Low risk" } as const;
export const SEVERITY_LABEL: Record<Severity, string> = {
  blocker: "Blocker",
  major: "Major",
  minor: "Minor",
  nit: "Nit",
};
export const DEPTH_LABEL: Record<StopDepth, string> = { deep: "Deep", skim: "Skim" };
/** Why a stop has its depth, as the overview's stop list says it. */
export const WHY_LABEL: Record<StopWhy, string> = {
  finding: "has findings",
  risky: "risky kind of change",
  core: "core logic",
  routine: "routine",
  repeated: "repeated change",
  tests: "tests",
  docs: "docs",
};
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
    const id = `check:${guide.pr.repo}#${guide.pr.number}@${guide.pr.commit}:${i}`;
    const input = h("input", { type: "checkbox" }) as HTMLInputElement;
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

export function claims(guide: PrGuide): HTMLElement {
  if (!guide.claimsCheck.length)
    return section(
      "claims-h",
      "Claims check",
      null,
      "h3",
      h(
        "p",
        { class: "muted" },
        guide.pr.hasDescription
          ? "The description makes no claims to check."
          : "No description to check against the diff.",
      ),
    );
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
  if (!c || !c.notRead.length) return null;
  const total = c.notRead.length + new Set([...c.inPrompt, ...c.readByAgent]).size;
  const codex = guide.generatedBy.harness === "codex";
  return h(
    "p",
    { class: "coverage small", role: "note" },
    h("strong", {}, `Agent read ${total - c.notRead.length} of ${total} files`),
    ` · not read: `,
    ...c.notRead.flatMap((f, i) => [i ? ", " : "", h("span", { class: "mono" }, f)]),
    codex ? ". Codex does not report which files it opened, so only the prompt counts." : "",
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
    `${g.harness === "codex" ? "Codex" : "Claude Code"}${g.model ? ` · ${g.model}` : ""} · ${when(g.at)} · `,
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
