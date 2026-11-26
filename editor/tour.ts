// The guide as a tour of the whole PR: an overview with no diffs, then one stop at a time (deep
// stops explain one idea next to only the hunks that matter; skim stops show one example of a
// routine change and list the other files), the files skipped by design last, then a wrap-up with
// the review to post. Each view is drawn from scratch by editor/main.ts when the reviewer moves;
// this file only draws.
import type { Breakdown } from "../src/breakdown/assemble";
import type { DiffFile } from "../src/diff-model";
import {
  severityCounts,
  splitFindings,
  stopForFile,
  stopForFinding,
  type StopLike,
} from "../src/overview";
import { lockfileSource } from "../src/repo";
import { pendingByStop } from "../src/pending";
import {
  DEEP_SEVERITIES,
  SEVERITIES,
  type Finding,
  type PrGuide,
  type SkippedFile,
  type Stop,
} from "../src/schema";
import {
  filesCovered,
  parseView,
  resumeStop,
  stopView,
  tourMinutes,
  type TourShape,
  type TourState,
  type TourView,
} from "../src/tour";
import { changesSection } from "./changes";
import { createDiffView, type DiffView } from "./diff-view";
import { isTestPath, spyOnCards, whenNear } from "./group";
import { markRailFile, rail, type LineCounts } from "./rail";
import { railResizer, railToggle } from "./rail-layout";
import { h, prose } from "./dom";
import {
  basename,
  checklist,
  claims,
  coverageLine,
  DEPTH_LABEL,
  FINISH,
  flows,
  footer,
  provenance,
  paragraphs,
  plural,
  pointRow,
  RISK_LABEL,
  section,
  SEVERITY_LABEL,
  severityTags,
  SKIP_LABEL,
} from "./parts";
import type { Review } from "./review";
import type { Viewed } from "./viewed";

/**
 * Where focus goes after a move: the new view's heading, the control that made the move, the
 * file a finding pointed at, or a pending comment's card (the diff focuses it once drawn).
 */
export type FocusTarget = "heading" | "prev" | "next" | "menu" | "file" | "comment";

/**
 * A line to show on arrival (from a finding's file:line, or a pending comment); null line means
 * the whole file. `commentId` names the pending comment to focus there.
 */
export type LineTarget = { file: string; line: number | null; commentId?: string };

export type TourContext = {
  guide: PrGuide;
  /** Made by v0.1: no findings, file notes or focus. */
  older: boolean;
  review: Review | null;
  state: TourState;
  /** The deep and skim stops, covering every changed file not skipped. */
  stops: readonly Stop[];
  /** Files skipped by design; when there are any, their stop comes after `stops`. */
  skipped: readonly SkippedFile[];
  /** Stops in the tour, the skipped files' stop included. */
  count: number;
  /** Every stop as files and focus, the skipped files' stop included, for finding where things are. */
  lookup: readonly StopLike[];
  go: (view: TourView, focus?: FocusTarget, target?: LineTarget | null) => void;
  /** Set by the move that drew this view, when it asked for a line. */
  target: LineTarget | null;
  /** Remembers a stop's file open or closed. */
  setCollapsed: (index: number, collapsed: boolean) => void;
  restart: () => void;
  load: (path: string) => Promise<DiffFile>;
  /** GitHub's Viewed checkbox per file. */
  viewed: Viewed;
  /** The PR's files by kind, for the overview's Changes; asked once per tab, again after a failure. */
  breakdown: () => Promise<Breakdown>;
  openInOrca: (path: string) => void;
  regenerate: (label: string) => HTMLElement;
  /** The tab's status line for errors (Regenerate, Open in Orca). */
  notice: HTMLElement;
  /** Registers cleanup for when the view is drawn again (diff views, document listeners). */
  track: (dispose: () => void) => void;
};

const findingsIn = (guide: PrGuide, files: readonly string[]) =>
  guide.findings.filter((f) => files.includes(f.file));

/** Whether stop `i` is the one listing the files skipped by design. */
const isSkip = (ctx: TourContext, i: number) => ctx.skipped.length > 0 && i === ctx.stops.length;
const shapeOf = (ctx: TourContext): TourShape => ({
  stops: ctx.stops,
  skipped: ctx.skipped.map((f) => f.path),
});
const SKIP_TITLE = "Skipped by design";
/** "stop 3", or the skipped files' stop by name, for labels that say where a press goes. */
const stopName = (ctx: TourContext, i: number) =>
  isSkip(ctx, i) ? "the skipped files" : `stop ${i + 1}`;

// ---------------------------------------------------------------- shared

/**
 * A changed file in a list (a skim stop's other files, the skipped files):
 * its path as an open/close toggle with `lead` under it; the diff loads the first time it is
 * opened. With `line` it starts open there.
 */
function fileRow(
  ctx: TourContext,
  path: string,
  lead: (Node | null)[],
  line?: number | null,
  tags?: Node[],
): HTMLElement {
  const target = line !== undefined;
  const view = createDiffView({
    guide: ctx.guide,
    load: ctx.load,
    viewed: ctx.viewed,
    review: ctx.review,
    openInOrca: ctx.openInOrca,
    variant: "listed",
    expanded: target,
    lead,
    tags,
    focusComment: target && ctx.target?.file === path ? ctx.target.commentId : null,
  });
  ctx.track(() => view.dispose());
  if (target) view.el.classList.add("is-target");
  void view.show(path, line ?? null);
  return h("li", { class: "group-file", "data-path": path }, view.el);
}

/** The files changed since the reviewer's last look, for marking the tour's stops. */
const changedSince = (ctx: TourContext): ReadonlySet<string> =>
  new Set(ctx.guide.sinceLastReview?.changes.map((c) => c.file) ?? []);

type SinceReview = NonNullable<PrGuide["sinceLastReview"]>;

/** What Since your last review says, worth acting on only: no unchanged risk, no zero counts. */
function sinceText(s: SinceReview, level: PrGuide["risk"]["level"]): string {
  const n = s.changes.length;
  const answers = s.changes.filter((c) => c.answersComment).length;
  return [
    n
      ? `${plural(n, "file")} changed since you last looked`
      : "No file changes since you last looked",
    s.openComments ? `${s.openComments} of your comments still open` : "",
    answers ? `${answers} ${answers === 1 ? "answers your comment" : "answer your comments"}` : "",
    s.riskChanged ? `Risk is now ${level[0]?.toUpperCase()}${level.slice(1)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Show changes / Hide changes for the per-file list under the line. The rows are built on open
 * and removed on close, their diff views disposed then, or with the view while open.
 */
function sinceToggle(ctx: TourContext, s: SinceReview, list: HTMLElement): HTMLElement {
  const toggle = h(
    "button",
    { type: "button", class: "link small", "aria-expanded": "false", "aria-controls": list.id },
    "Show changes",
  );
  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") !== "true";
    // No diffs here: the tour shows each file's; a row says what changed and leads to its stop.
    if (open)
      list.replaceChildren(
        ...s.changes.map((c) =>
          h(
            "li",
            { class: "since-row" },
            h("span", { class: "mono small" }, c.file),
            h(
              "span",
              { class: "since-note" },
              prose(c.headline),
              c.answersComment ? h("span", { class: "tag new" }, "answers your comment") : null,
            ),
            goToStop(ctx, stopForFile(ctx.lookup, c.file)),
          ),
        ),
      );
    else list.replaceChildren();
    list.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "Hide changes" : "Show changes";
  });
  return toggle;
}

/**
 * Since your last review as one line under the header: what changed and what is still the
 * reviewer's to act on, with the per-file list behind Show changes. The commit pair is its tooltip.
 */
function since(ctx: TourContext): HTMLElement | null {
  const s = ctx.guide.sinceLastReview;
  if (!s) return null;
  const list = s.changes.length
    ? h("ul", { class: "since-rows", id: "since-files", hidden: "" })
    : null;
  return h(
    "div",
    {
      class: "since small muted",
      title: `${s.fromCommit.slice(0, 7)} → ${s.toCommit.slice(0, 7)}`,
    },
    h(
      "p",
      { class: "since-line" },
      sinceText(s, ctx.guide.risk.level),
      list ? " " : null,
      list ? sinceToggle(ctx, s, list) : null,
    ),
    list,
  );
}

/** The way into the tour: Start, or Resume and Restart once there is progress. */
function startActions(ctx: TourContext): HTMLElement {
  const n = ctx.count;
  const resume = resumeStop(ctx.state, n);
  const actions = h("div", { class: "row wrap start-actions" });
  if (n === 0) {
    const wrap = h("button", { type: "button", class: "btn primary" }, "Finish review →");
    wrap.addEventListener("click", () => ctx.go("wrapup"));
    actions.append(wrap);
  } else if (resume === null) {
    const start = h("button", { type: "button", class: "btn primary" }, "Start tour →");
    start.addEventListener("click", () => ctx.go(stopView(0)));
    actions.append(start);
  } else {
    const go = h(
      "button",
      { type: "button", class: "btn primary" },
      `Resume at ${stopName(ctx, resume)} →`,
    );
    go.addEventListener("click", () => ctx.go(stopView(resume)));
    const restart = h("button", { type: "button", class: "btn sm ghost" }, "Restart");
    restart.setAttribute("aria-label", "Restart the tour from stop 1");
    restart.addEventListener("click", () => {
      const lost = ctx.review ? discarded(ctx.review) : null;
      if (!lost) {
        ctx.restart();
        return;
      }
      // The review goes too, so ask first, in place of the buttons: nothing is lost by a stray press.
      restartConfirm(ctx, lost, actions, () => {
        actions.replaceChildren(go, restart);
        restart.focus();
      });
    });
    actions.append(go, restart);
  }
  return actions;
}

/** What restarting would discard from the review, as "1 comment and your summary"; null if nothing. */
function discarded(review: Review): string | null {
  const held = review.held();
  const parts = [
    held.comments ? plural(held.comments, "comment") : "",
    held.summary ? "your summary" : "",
    held.dismissed ? plural(held.dismissed, "dismissed finding") : "",
  ].filter(Boolean);
  if (parts.length === 0) return null;
  const last = parts.pop();
  return parts.length ? `${parts.join(", ")} and ${last}` : (last ?? null);
}

/**
 * "Restart from stop 1 and discard your review: …?" with Restart and discard, and Cancel, drawn
 * in place of what is in `into`.
 */
function restartConfirm(
  ctx: TourContext,
  lost: string,
  into: HTMLElement,
  cancel: () => void,
): void {
  const discard = h("button", { type: "button", class: "btn sm danger" }, "Restart and discard");
  discard.addEventListener("click", () => {
    ctx.review?.reset();
    ctx.restart();
  });
  const keep = h("button", { type: "button", class: "btn sm ghost" }, "Cancel");
  keep.addEventListener("click", cancel);
  const box = h(
    "div",
    { class: "restart-confirm stack-xs", role: "group", "aria-label": "Restart the review?" },
    h("p", { class: "small" }, `Restart from stop 1 and discard your review: ${lost}?`),
    h("div", { class: "row" }, discard, keep),
  );
  // Esc here means Cancel; it must not reach the tab, which would leave nothing to cancel.
  box.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    cancel();
  });
  into.replaceChildren(box);
  // Cancel is the safer place to land: Enter or Space straight away keeps the review.
  keep.focus();
}

function header(ctx: TourContext): HTMLElement {
  const { pr } = ctx.guide;
  const github = h("button", { type: "button", class: "link" }, "Open on GitHub");
  github.addEventListener("click", () => void orca.shell?.openExternal(pr.url));
  // Regenerate sits with the other things you do to this guide, not in a footer nobody reaches.
  const regenerate = ctx.regenerate("Regenerate");
  regenerate.className = "btn sm ghost";
  regenerate.setAttribute(
    "aria-label",
    "Regenerate this guide (runs the agent again, about 2 minutes)",
  );
  return h(
    "header",
    { class: "ov-head" },
    h(
      "div",
      { class: "stack-sm ov-title" },
      h("h1", { tabindex: "-1", class: "view-heading" }, prose(ctx.guide.title)),
      h(
        "p",
        { class: "meta muted small" },
        // Branches, line counts and files are in Changes, so they appear once.
        `${pr.repo.split("/").pop()} #${pr.number} · `,
        github,
      ),
    ),
    h(
      "div",
      { class: "stack-xs head-actions" },
      h("div", { class: "row wrap" }, startActions(ctx), regenerate),
      h(
        "p",
        { class: "muted small provenance" },
        ...provenance(ctx.guide),
        ctx.guide.trimmed ? " · some details left out to fit storage" : "",
      ),
    ),
  );
}

/** The overall risk, top-right next to what the PR does: level, one line, and steps outside the code. */
function riskCard(ctx: TourContext): HTMLElement {
  const { risk } = ctx.guide;
  return h(
    "section",
    { class: `risk-card ${risk.level}`, "aria-labelledby": "risk-h" },
    h(
      "div",
      { class: "row baseline" },
      // The level is the words; the dot and colour only repeat it.
      h(
        "h2",
        { id: "risk-h", class: `tag level ${risk.level}` },
        h("span", { "aria-hidden": "true" }, "●\u00a0"),
        RISK_LABEL[risk.level],
      ),
    ),
    h("p", { class: "risk-headline" }, prose(risk.headline)),
    checklist(ctx.guide, "h3"),
  );
}

// ---------------------------------------------------------------- overview

/** A finding's file and line as a button that opens its stop there. */
function findingPlace(ctx: TourContext, f: Finding, at: number | null): HTMLElement {
  const line = f.line === null ? "" : `:${f.line}`;
  const where = `${f.file}${line}`;
  const loc = h(
    "button",
    {
      type: "button",
      class: "file",
      title: where,
      "aria-label": at === null ? where : `${where}: show it at ${stopName(ctx, at)}`,
    },
    `${basename(f.file)}${line}`,
  );
  // A finding on a file the guide and git disagree about has nowhere to go.
  if (at === null) loc.setAttribute("disabled", "");
  else
    loc.addEventListener("click", () =>
      ctx.go(stopView(at), "heading", { file: f.file, line: f.line }),
    );
  return loc;
}

/** "Stop 3 →": the way to a finding's stop; an empty cell when it has none. */
function goToStop(ctx: TourContext, at: number | null): HTMLElement {
  if (at === null) return h("span", {});
  const goTo = h(
    "button",
    {
      type: "button",
      class: "btn sm ghost",
      "aria-label": isSkip(ctx, at)
        ? "Go to the skipped files"
        : `Go to stop ${at + 1}: ${ctx.stops[at]?.headline ?? ""}`,
    },
    isSkip(ctx, at) ? "Skipped →" : `Stop ${at + 1} →`,
  );
  goTo.addEventListener("click", () => ctx.go(stopView(at)));
  return goTo;
}

function findingRow(
  ctx: TourContext,
  f: Finding,
  folded: boolean,
  extra: Node | null = null,
): HTMLElement {
  const at = stopForFinding(ctx.lookup, f);
  const li = h(
    "li",
    { class: "finding-row" },
    h("span", { class: `tag sev ${f.severity}` }, SEVERITY_LABEL[f.severity]),
    h(
      "div",
      { class: "stack-xs" },
      h("p", { class: "headline" }, prose(f.headline)),
      findingPlace(ctx, f, at),
      extra,
    ),
    goToStop(ctx, at),
  );
  if (folded) li.hidden = true;
  return li;
}

/** "Show 4 more", which unfolds the rows of `list` after the first `shown`. */
function showMore(list: HTMLElement, shown: number, more: number): HTMLElement {
  const label = `Show ${more} more`;
  const b = h(
    "button",
    {
      type: "button",
      class: "btn sm",
      "aria-expanded": "false",
      "aria-controls": "finding-list",
    },
    label,
  );
  b.addEventListener("click", () => {
    const open = b.getAttribute("aria-expanded") !== "true";
    b.setAttribute("aria-expanded", String(open));
    b.textContent = open ? "Show fewer" : label;
    list.querySelectorAll<HTMLElement>(".finding-row").forEach((el, i) => {
      if (i >= shown) el.hidden = !open;
    });
  });
  return b;
}

function findingsSection(ctx: TourContext): HTMLElement {
  const { guide } = ctx;
  if (!guide.findings.length)
    return section("findings-h", "Findings", null, "h2", h("p", { class: "muted" }, "None found."));
  const { visible, hidden } = splitFindings(guide.findings);
  const list = h(
    "ul",
    { class: "finding-list", id: "finding-list" },
    ...visible.map((f) => findingRow(ctx, f, false)),
    ...hidden.map((f) => findingRow(ctx, f, true)),
  );
  const toggle = hidden.length ? showMore(list, visible.length, hidden.length) : null;
  return section("findings-h", "Findings", severityCounts(guide.findings), "h2", list, toggle);
}

/** "1 lockfile, 4 whitespace only": the skipped files by reason. */
function skipSummary(skipped: readonly SkippedFile[]): string {
  const counts = new Map<SkippedFile["reason"], number>();
  for (const f of skipped) counts.set(f.reason, (counts.get(f.reason) ?? 0) + 1);
  return [...counts].map(([reason, n]) => `${n} ${SKIP_LABEL[reason].toLowerCase()}`).join(", ");
}

/**
 * "1 file skipped by design · 1 lockfile", under the route: the skipped files are not a stop to
 * read, so they are a quiet link to their list, with ✓ once it was opened.
 */
function skippedLink(ctx: TourContext): HTMLElement | null {
  if (!ctx.skipped.length) return null;
  const at = ctx.stops.length;
  const seen = ctx.state.visited.includes(at);
  const files = plural(ctx.skipped.length, "file");
  const link = h(
    "button",
    {
      type: "button",
      class: "link",
      "aria-label": `${SKIP_TITLE}: ${files}, ${skipSummary(ctx.skipped)}${seen ? " (seen)" : ""}`,
    },
    `${files} skipped by design`,
  );
  link.addEventListener("click", () => ctx.go(stopView(at)));
  return h(
    "p",
    { class: "small muted route-skipped" },
    link,
    ` · ${skipSummary(ctx.skipped)}`,
    seen ? h("span", { class: "route-seen", "aria-hidden": "true" }, " ✓") : null,
  );
}

/** What a step card says it is: where the tour starts or resumes, or that it was seen. */
type StepMark = "start" | "resume" | "seen" | null;

const MARK_TEXT = { start: "Start here", resume: "Resume here", seen: "✓" } as const;
const MARK_ARIA = { start: " (start here)", resume: " (resume here)", seen: " (seen)" } as const;

/**
 * A stop as a card in the overview's tour, kept to what tells stops apart at a glance: its number,
 * a short name (its title, else its file), its worst finding in words, and where the tour is.
 * The sentence waits for the stop itself; the label and tooltip carry it for whoever wants it now.
 */
function stepCard(
  ctx: TourContext,
  s: Stop,
  i: number,
  mark: StepMark,
  changed: boolean,
): HTMLElement {
  const findings = findingsIn(ctx.guide, s.files);
  const worst = SEVERITIES.find((sev) => findings.some((f) => f.severity === sev));
  const more = s.files.length - 1;
  const name = s.title ?? `${basename(s.files[0] ?? "")}${more ? ` +${more}` : ""}`;
  const found = findings.length ? ` ${severityCounts(findings)}.` : "";
  const here = mark === "start" || mark === "resume";
  const b = h(
    "button",
    {
      type: "button",
      class: `tour-step${s.depth === "skim" ? " skim" : ""}${here ? " here" : ""}`,
      title: s.headline,
      "aria-label": `Stop ${i + 1}${mark ? MARK_ARIA[mark] : ""}${changed ? " (changed since your last review)" : ""}: ${name}, ${DEPTH_LABEL[s.depth].toLowerCase()}. ${s.headline}${found}`,
    },
    h(
      "span",
      { class: "tour-step-top", "aria-hidden": "true" },
      h(
        "span",
        {},
        String(i + 1),
        changed ? h("span", { class: "tour-step-changed" }, " · changed ") : null,
      ),
      mark ? h("span", { class: `tour-step-mark ${mark}` }, MARK_TEXT[mark]) : null,
    ),
    h(
      "span",
      { class: "tour-step-main", "aria-hidden": "true" },
      h("span", { class: `tour-step-text${s.title ? "" : " mono"}` }, name),
      worst ? h("span", { class: `tag sev ${worst}` }, SEVERITY_LABEL[worst]) : null,
    ),
  );
  b.addEventListener("click", () => ctx.go(stopView(i)));
  return h("li", {}, b);
}

/**
 * The tour across the page's full width, under the summary and the risk: every stop as a card in
 * reading order, so the whole route and what each stop covers read at a glance.
 */
function tourSection(ctx: TourContext): HTMLElement {
  const { stops, guide } = ctx;
  if (!ctx.count)
    return section(
      "tour-h",
      "Tour",
      null,
      "h2",
      h("p", { class: "muted small" }, "This guide has no reading order, so there are no stops."),
    );
  const resume = resumeStop(ctx.state, ctx.count);
  const markOf = (i: number): StepMark => {
    if (resume === null) return i === 0 ? "start" : null;
    if (i === resume) return "resume";
    return ctx.state.visited.includes(i) ? "seen" : null;
  };
  const { total } = filesCovered([], shapeOf(ctx));
  const changed = changedSince(ctx);
  return section(
    "tour-h",
    "Tour",
    `${plural(stops.length, "stop")} · covers ${plural(total, "file")} · ~${tourMinutes({ ...guide, readingOrder: stops })} min`,
    "h2",
    h(
      "ol",
      { class: "tour-steps" },
      ...stops.map((s, i) =>
        stepCard(
          ctx,
          s,
          i,
          markOf(i),
          s.files.some((f) => changed.has(f)),
        ),
      ),
    ),
    skippedLink(ctx),
  );
}

function overview(ctx: TourContext): HTMLElement {
  const { guide } = ctx;
  return h(
    "main",
    { class: "page overview" },
    ctx.older
      ? h(
          "div",
          { class: "banner", role: "note" },
          h("strong", {}, "Made by an older guide format."),
          " It has no findings or file notes. ",
          ctx.regenerate("Regenerate"),
        )
      : null,
    header(ctx),
    since(ctx),
    h(
      "div",
      { class: "ov-top" },
      // Findings sit under the summary, so the column beside the risk and Changes is filled.
      h(
        "div",
        { class: "ov-main" },
        h(
          "section",
          { class: "points", "aria-label": "Summary" },
          pointRow("What", guide.summary.what),
          pointRow("Why", guide.summary.why),
          pointRow("Impact", guide.summary.impact),
        ),
        findingsSection(ctx),
      ),
      h("div", { class: "stack ov-side" }, riskCard(ctx), changesSection(ctx)),
    ),
    tourSection(ctx),
    ctx.notice,
  );
}

// ---------------------------------------------------------------- stops and wrap-up

type Here = { kind: "stop"; index: number } | { kind: "wrapup" };

/** A step's marker in the rail: its number, ✓ once seen, ● where you are. Decorative. */
const mark = (text: string, cls = ""): HTMLElement =>
  h("span", { class: `mark ${cls}`, "aria-hidden": "true" }, text);

/** What a stop's marker shows, and the class that styles it. */
function stopMark(n: string, current: boolean, seen: boolean): HTMLElement {
  if (current) return mark("●", "now");
  return seen ? mark("✓", "seen") : mark(n);
}

/** Where a list of steps is drawn: the view it marks as current, and what a pick does first. */
type StepList = { ctx: TourContext; here: Here; onPick?: () => void };

/** One place the tour can go, as a list item holding its button. */
function stepItem(
  list: StepList,
  o: { view: TourView; label: Node[]; aria: string; current: boolean },
): { li: HTMLElement; button: HTMLElement } {
  const button = h(
    "button",
    { type: "button", class: "step-link", "aria-label": o.aria },
    ...o.label,
  );
  if (o.current) button.setAttribute("aria-current", "step");
  button.addEventListener("click", () => {
    list.onPick?.();
    list.ctx.go(o.view);
  });
  return { li: h("li", {}, button), button };
}

/** A stop's pending-comment count in the list, and the button whose label says it too. */
type StepCount = { el: HTMLElement; button: HTMLElement; aria: string };

/** Brings each stop's pending-comment count up to date. */
function drawCounts(ctx: TourContext, counts: readonly StepCount[]): void {
  const pending = pendingByStop(ctx.lookup, ctx.review?.all() ?? []);
  counts.forEach(({ el, button, aria }, i) => {
    const n = pending[i] ?? 0;
    el.textContent = n ? String(n) : "";
    el.hidden = !n;
    button.setAttribute("aria-label", n ? `${aria} (${plural(n, "pending comment")})` : aria);
  });
}

/** One stop's entry; `name` is what the rail shows, `extra` sits after the pending count. */
function stopStep(
  list: StepList,
  i: number,
  o: { name: Node[]; aria: string; extra: HTMLElement[] },
): { li: HTMLElement; count: StepCount } {
  const { ctx, here } = list;
  const current = here.kind === "stop" && here.index === i;
  const seen = ctx.state.visited.includes(i);
  const el = h("span", { class: "step-pending", "aria-hidden": "true" });
  const nowTag = current ? " (current)" : "";
  const aria = `${o.aria}${nowTag || (seen ? " (seen)" : "")}`;
  const { li, button } = stepItem(list, {
    view: stopView(i),
    label: [
      stopMark(isSkip(ctx, i) ? "–" : String(i + 1), current, seen),
      ...o.name,
      el,
      ...o.extra,
    ],
    aria,
    current,
  });
  return { li, count: { el, button, aria } };
}

/** A deep or skim stop's entry: its first file, how many more, its depth, and a flag for findings. */
function tourStep(list: StepList, s: Stop, i: number): { li: HTMLElement; count: StepCount } {
  const flagged = findingsIn(list.ctx.guide, s.files).length > 0;
  const others = s.files.length - 1;
  return stopStep(list, i, {
    name: [
      h("span", { class: "step-name" }, basename(s.files[0] ?? "")),
      others ? h("span", { class: "step-more", "aria-hidden": "true" }, `+${others}`) : null,
    ].filter((x): x is HTMLElement => x !== null),
    aria: `Stop ${i + 1}, ${s.depth}, ${plural(s.files.length, "file")}: ${s.headline}${flagged ? " (has findings)" : ""}`,
    extra: flagged ? [mark("⚑", "flag")] : [],
  });
}

/** The skipped files' entry, after the stops. */
function skippedStep(list: StepList): { li: HTMLElement; count: StepCount } {
  const files = plural(list.ctx.skipped.length, "file");
  return stopStep(list, list.ctx.stops.length, {
    name: [h("span", { class: "step-name plain" }, `Skipped · ${files}`)],
    aria: `${SKIP_TITLE}: ${files}`,
    extra: [],
  });
}

/** Every place the tour can go, as buttons: the rail on a wide tab, the menu on a narrower one. */
function steps(ctx: TourContext, here: Here, onPick?: () => void): HTMLElement {
  const list: StepList = { ctx, here, onPick };
  const atWrapUp = here.kind === "wrapup";
  const entries = [
    ...ctx.stops.map((s, i) => tourStep(list, s, i)),
    ...(ctx.skipped.length ? [skippedStep(list)] : []),
  ];
  const el = h(
    "ol",
    { class: "steps" },
    stepItem(list, {
      view: "overview",
      label: [mark("◇"), h("span", {}, "Overview")],
      aria: "Overview",
      current: false,
    }).li,
    ...entries.map((e) => e.li),
    stepItem(list, {
      view: "wrapup",
      label: [mark(atWrapUp ? "●" : "◇", atWrapUp ? "now" : ""), h("span", {}, FINISH)],
      aria: FINISH,
      current: atWrapUp,
    }).li,
  );
  /** Each stop's pending-comment count, kept current as comments are added and deleted. */
  const counts = entries.map((e) => e.count);
  drawCounts(ctx, counts);
  if (ctx.review) ctx.track(ctx.review.onChange(() => drawCounts(ctx, counts)));
  return el;
}

/** "Stop n of N ▾": the steps as a menu, for a tab too narrow for the rail. */
function stepMenu(ctx: TourContext, here: Here, label: string): HTMLElement {
  const id = "tour-menu";
  const button = h(
    "button",
    { type: "button", class: "btn sm menu-btn", "aria-expanded": "false", "aria-controls": id },
    label,
    h("span", { "aria-hidden": "true" }, " ▾"),
  );
  const close = (refocus: boolean) => {
    list.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (refocus) button.focus();
  };
  const list = steps(ctx, here, () => close(false));
  list.id = id;
  list.classList.add("menu-list");
  list.hidden = true;
  button.addEventListener("click", () => {
    const opening = list.hidden;
    list.hidden = !opening;
    button.setAttribute("aria-expanded", String(opening));
    if (opening)
      (
        list.querySelector<HTMLElement>("[aria-current]") ??
        list.querySelector<HTMLElement>("button")
      )?.focus();
  });
  const box = h("div", { class: "menu" }, button, list);
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !list.hidden) {
      e.stopPropagation();
      close(true);
    }
  });
  const outside = (e: Event) => {
    const inside = e.target instanceof Node && box.contains(e.target);
    if (!list.hidden && !inside) close(false);
  };
  document.addEventListener("click", outside);
  ctx.track(() => document.removeEventListener("click", outside));
  return box;
}

/** "18 of 23 files covered · 5 skipped by design": progress counts files, not stops. */
function coveredText(ctx: TourContext): string {
  const { covered, total, skipped } = filesCovered(ctx.state.visited, shapeOf(ctx));
  return `${covered} of ${plural(total, "file")} covered${skipped ? ` · ${skipped} skipped by design` : ""}`;
}

/** The top bar's line for where the reviewer is: "Stop 2 of 5 · Card primitive". */
function whereLabel(ctx: TourContext, here: Here): string {
  if (here.kind === "wrapup") return FINISH;
  const at = isSkip(ctx, here.index) ? undefined : ctx.stops[here.index];
  if (!at) return SKIP_TITLE;
  // The stop's own title tells stops apart; an older guide has none, so it says the area.
  const name = at.title ?? ctx.guide.areas.find((a) => a.id === at.areaId)?.label;
  return `Stop ${here.index + 1} of ${ctx.stops.length}${name ? ` · ${name}` : ""}`;
}

/** The view Prev goes to from `here`, or null on the first stop (Exit leads to the overview). */
function prevViewOf(here: Here, count: number): TourView | null {
  if (here.kind === "wrapup") return count ? stopView(count - 1) : "overview";
  return here.index > 0 ? stopView(here.index - 1) : null;
}

/** The view Next goes to from `here`, or null on the wrap-up. */
function nextViewOf(here: Here, count: number): TourView | null {
  if (here.kind === "wrapup") return null;
  return here.index + 1 < count ? stopView(here.index + 1) : "wrapup";
}

/** The bar showing how many files are covered, and the same in words beside it. */
function progress(ctx: TourContext): HTMLElement {
  const { covered, total } = filesCovered(ctx.state.visited, shapeOf(ctx));
  const text = coveredText(ctx);
  return h(
    "div",
    { class: "row progress-wrap" },
    h(
      "div",
      {
        class: "progress",
        role: "progressbar",
        "aria-label": "Files covered",
        "aria-valuemin": "0",
        "aria-valuemax": String(total),
        "aria-valuenow": String(covered),
        "aria-valuetext": text,
      },
      h("span", { class: "progress-fill", style: `width:${total ? (covered / total) * 100 : 0}%` }),
    ),
    h("span", { class: "muted small progress-text", "aria-hidden": "true" }, text),
  );
}

/** Prev or Next. Kept in place (hidden) at the ends, so the other buttons don't jump as you step. */
/** The keys that do what each button does (editor/main.ts `keyTarget`), shown in its tooltip. */
const NAV_KEYS = {
  prev: { aria: "ArrowLeft k", hint: "← or K" },
  next: { aria: "ArrowRight j", hint: "→ or J" },
} as const;

function navButton(
  ctx: TourContext,
  view: TourView | null,
  o: { caption: string; aria: string; focus: "prev" | "next" },
): HTMLElement {
  const keys = NAV_KEYS[o.focus];
  const b = h(
    "button",
    {
      type: "button",
      class: `btn sm nav-${o.focus}`,
      "aria-label": o.aria,
      "aria-keyshortcuts": keys.aria,
      title: `${o.aria} (${keys.hint})`,
    },
    o.caption,
  );
  if (view === null) b.classList.add("invisible");
  else b.addEventListener("click", () => ctx.go(view, o.focus));
  return b;
}

/** Leaving keeps progress: the overview then offers Resume. */
function exitButton(ctx: TourContext): HTMLElement {
  const exit = h(
    "button",
    {
      type: "button",
      class: "btn sm exit",
      title: "Back to the overview (Esc)",
      "aria-keyshortcuts": "Escape",
    },
    h("span", { "aria-hidden": "true" }, "✕\u00a0"),
    "Exit tour",
  );
  exit.addEventListener("click", () => ctx.go("overview"));
  return exit;
}

function topBar(ctx: TourContext, here: Here): HTMLElement {
  const n = ctx.count;
  const label = whereLabel(ctx, here);
  const prevView = prevViewOf(here, n);
  const nextView = nextViewOf(here, n);
  const prevIndex = here.kind === "stop" ? here.index - 1 : n - 1;
  const nextName = here.kind === "stop" ? stopName(ctx, here.index + 1) : "";
  return h(
    "div",
    { class: "topbar" },
    railToggle(),
    exitButton(ctx),
    h("p", { class: "topbar-label" }, label),
    stepMenu(ctx, here, label),
    progress(ctx),
    h(
      "div",
      { class: "row topbar-nav" },
      navButton(ctx, prevView, {
        caption: "‹ Prev",
        aria:
          prevView === "overview" ? "Previous: overview" : `Previous: ${stopName(ctx, prevIndex)}`,
        focus: "prev",
      }),
      navButton(ctx, nextView, {
        caption: nextView === "wrapup" ? `${FINISH} ›` : "Next ›",
        aria: nextView === "wrapup" ? `Next: ${FINISH.toLowerCase()}` : `Next: ${nextName}`,
        focus: "next",
      }),
    ),
  );
}

function shell(ctx: TourContext, here: Here, body: HTMLElement): HTMLElement {
  const nav = h(
    "nav",
    { class: "rail", id: "tour-rail", "aria-label": "Tour groups and files" },
    h("div", { class: "rail-scroll" }, railFor(ctx, here)),
  );
  nav.append(railResizer(nav));
  return h(
    "div",
    { class: "tour" },
    nav,
    h("div", { class: "tour-main" }, topBar(ctx, here), body, ctx.notice),
  );
}

/** Each changed file's added and removed line counts, for the rail; empty when unknown. */
const lineCounts = (ctx: TourContext): Promise<LineCounts> =>
  ctx
    .breakdown()
    .then((b) => {
      const files = b.categories.flatMap((c) => c.files);
      return new Map(
        files.map((f) => [f.path, { additions: f.additions, deletions: f.deletions }]),
      );
    })
    .catch(() => new Map());

/** Scrolls to `path`'s card on this page, opening it; false when the page has none. */
function scrollToCard(path: string): boolean {
  const card = Array.from(document.querySelectorAll<HTMLElement>(".group-file")).find(
    (c) => c.dataset.path === path,
  );
  const toggle = card?.querySelector<HTMLButtonElement>(".dv-toggle");
  if (!card || !toggle) return false;
  if (toggle.getAttribute("aria-expanded") === "false") toggle.click();
  card.scrollIntoView({ block: "start" });
  toggle.focus({ preventScroll: true });
  return true;
}

function railFor(ctx: TourContext, here: Here): HTMLElement {
  const groups = [
    ...ctx.stops.map((s) => ({
      title: s.title ?? basename(s.files[0] ?? ""),
      files: s.files,
      flagged: findingsIn(ctx.guide, s.files).length > 0,
    })),
    ...(ctx.skipped.length
      ? [{ title: SKIP_TITLE, files: ctx.skipped.map((f) => f.path), flagged: false }]
      : []),
  ];
  const at = here.kind === "stop" ? here.index : null;
  return rail({
    groups,
    current: at,
    seen: ctx.state.visited,
    atWrapUp: here.kind === "wrapup",
    finishLabel: FINISH,
    skipped: new Map(ctx.skipped.map((f) => [f.path, SKIP_LABEL[f.reason]])),
    viewed: ctx.viewed,
    counts: lineCounts(ctx),
    pending: () => pendingByStop(ctx.lookup, ctx.review?.all() ?? []),
    onPendingChange: (listener) => ctx.review?.onChange(listener) ?? (() => undefined),
    goGroup: (i) => ctx.go(stopView(i)),
    goFile: (i, path) => {
      if (i !== at || !scrollToCard(path)) ctx.go(stopView(i), "file", { file: path, line: null });
    },
    goOverview: () => ctx.go("overview"),
    goWrapUp: () => ctx.go("wrapup"),
    track: ctx.track,
  });
}

/** Cards drawn and loaded at once; the rest open as they scroll near. */
const EAGER_CARDS = 4;

/** A file's severity tags and note, under its path. */
function cardLead(ctx: TourContext, path: string): (Node | null)[] {
  const note = ctx.guide.files.find((f) => f.path === path)?.note;
  const tags = severityTags(findingsIn(ctx.guide, [path]));
  return [
    tags.length ? h("div", { class: "row wrap" }, ...tags) : null,
    note ? h("p", { class: "muted small measure" }, prose(note)) : null,
  ];
}

/** "Test files start closed · Show diff", hidden once the card is open. */
function testHint(view: () => DiffView | null): HTMLElement {
  const show = h("button", { type: "button", class: "link" }, "Show diff");
  show.addEventListener("click", () => view()?.toggle.click());
  return h("p", { class: "test-hint muted small" }, "Test files start closed · ", show);
}

type Card = { index: number; k: number; path: string; focus: Stop["focus"] };

/**
 * One file of a group as a diff card. The first file carries the stop's open or closed state and
 * the agent's focus lines (marked, not filtered); test files start closed.
 */
function fileCard(ctx: TourContext, c: Card): HTMLElement {
  const target = ctx.target?.file === c.path ? ctx.target : null;
  const primary = c.k === 0;
  const remembered = primary && ctx.state.collapsed.includes(c.index);
  if (remembered && target) ctx.setCollapsed(c.index, false);
  const test = isTestPath(c.path);
  const open = target !== null || (!test && !(remembered && !target));
  const eager = target !== null || c.k < EAGER_CARDS;
  let made: DiffView | null = null;
  const view = createDiffView({
    guide: ctx.guide,
    load: ctx.load,
    viewed: ctx.viewed,
    review: ctx.review,
    openInOrca: ctx.openInOrca,
    marks: primary ? (c.focus ?? null) : null,
    expanded: open && eager,
    onToggle: primary ? (o) => ctx.setCollapsed(c.index, !o) : undefined,
    lead: [...cardLead(ctx, c.path), test ? testHint(() => made) : null],
    focusComment: target?.commentId ?? null,
  });
  made = view;
  ctx.track(() => view.dispose());
  void view.show(c.path, target?.line ?? null);
  const li = h("li", { class: "group-file", "data-path": c.path }, view.el);
  if (target) li.classList.add("is-target");
  if (open && !eager)
    ctx.track(
      whenNear(li, () => {
        if (view.toggle.getAttribute("aria-expanded") === "false") view.toggle.click();
      }),
    );
  return li;
}

/** Every file of a group, stacked as diff cards; the rail marks the one on screen. */
function groupCards(ctx: TourContext, s: Stop, index: number): HTMLElement {
  const list = h(
    "ul",
    { class: "group-files", "aria-label": plural(s.files.length, "file") },
    ...s.files.map((path, k) => fileCard(ctx, { index, k, path, focus: s.focus })),
  );
  ctx.track(spyOnCards(list, markRailFile));
  return list;
}

/** The top bar says how many files are covered; this says what is left, and where. */
/** A stop not seen yet, as a chip that goes to it; its sentence is the chip's tooltip. */
function unseenChip(ctx: TourContext, i: number): HTMLElement {
  const s = isSkip(ctx, i) ? undefined : ctx.stops[i];
  const files = plural(ctx.skipped.length, "file");
  const more = s && s.files.length > 1 ? ` +${s.files.length - 1}` : "";
  const b = h(
    "button",
    {
      type: "button",
      class: `route-stop${!s || s.depth === "skim" ? " skim" : ""}`,
      title: s ? s.headline : `${SKIP_TITLE}: ${files}`,
      "aria-label": s ? `Go to stop ${i + 1}: ${s.headline}` : `Go to the skipped files: ${files}`,
    },
    h("span", { class: "route-num" }, s ? String(i + 1) : "–"),
    h(
      "span",
      { class: "route-name" },
      s ? `${basename(s.files[0] ?? "")}${more}` : `Skipped · ${files}`,
    ),
  );
  b.addEventListener("click", () => ctx.go(stopView(i)));
  return h("li", {}, b);
}

/**
 * What is left before the review covers the whole PR: the stops not seen yet, each one press
 * away. The top bar already says how many files are covered; this says where the rest are.
 */
function leftToCover(ctx: TourContext): HTMLElement {
  const unseen = [...Array(ctx.count).keys()].filter((i) => !ctx.state.visited.includes(i));
  const { covered, total } = filesCovered(ctx.state.visited, shapeOf(ctx));
  if (!unseen.length)
    return section(
      "cover-h",
      "Covered",
      null,
      "h3",
      h("p", { class: "muted" }, `You’ve been through all ${plural(total, "file")}.`),
    );
  return section(
    "cover-h",
    "Not covered yet",
    // With a review, the line by Post to GitHub already counts the files; the chips say where.
    // The skipped files' list is not a stop to read, so it is not counted as one.
    ctx.review
      ? null
      : `${plural(total - covered, "file")} in ${plural(unseen.filter((i) => !isSkip(ctx, i)).length, "stop")}`,
    "h3",
    h("ol", { class: "route plain" }, ...unseen.map((i) => unseenChip(ctx, i))),
  );
}

/**
 * The blocker and major findings not acted on yet, each with its suggested comment to add or
 * dismiss right here: the question to settle before posting. Redraws as the draft changes, and
 * keeps focus in the list when a row it was in goes away.
 */
function toHandle(ctx: TourContext, review: Review): HTMLElement | null {
  if (!ctx.guide.findings.some((f) => DEEP_SEVERITIES.includes(f.severity))) return null;
  const box = h("div", {});
  const fill = (): void => {
    const hadFocus = box.contains(document.activeElement);
    const open = review.openFindings();
    box.replaceChildren(
      open.length
        ? section(
            "handle-h",
            "Findings to handle",
            // The line by Post to GitHub counts them; this says what to do.
            "add each to your review or dismiss it",
            "h3",
            h(
              "ul",
              { class: "finding-list" },
              ...open.map((f) => findingRow(ctx, f, false, review.finding(f, { compact: true }))),
            ),
          )
        : h(
            "p",
            { class: "handled", role: "status" },
            "✓ Every blocker and major finding is in your review or dismissed.",
          ),
    );
    if (hadFocus && !box.contains(document.activeElement))
      box.querySelector<HTMLElement>(".finding-row button")?.focus();
  };
  fill();
  ctx.track(review.onChange(fill));
  return box;
}

/** A group: the explanation, then every one of its files as a diff card. */
function stopPage(ctx: TourContext, index: number): HTMLElement {
  const s = ctx.stops[index];
  if (isSkip(ctx, index) || !s?.files.length) return skippedStop(ctx, index);
  const body = h(
    "article",
    { class: "stop", "aria-labelledby": "stop-h" },
    // A short title names the stop and its sentence leads under it; without one, the sentence heads.
    h(
      "h2",
      { id: "stop-h", class: "view-heading stop-headline", tabindex: "-1" },
      prose(s.title ?? s.headline),
    ),
    s.title ? h("p", { class: "measure stop-lead" }, prose(s.headline)) : null,
    s.detail?.trim() ? h("div", { class: "measure explain" }, ...paragraphs(s.detail)) : null,
    s.differences?.trim()
      ? h(
          "div",
          { class: "measure differences", role: "note" },
          h("strong", {}, "Differences: "),
          prose(s.differences),
        )
      : null,
    s.check?.trim()
      ? h("p", { class: "measure check-q" }, h("strong", {}, "Check: "), prose(s.check))
      : null,
    groupCards(ctx, s, index),
  );
  return shell(ctx, { kind: "stop", index }, body);
}

/** Why a skipped file holds nothing to review, in a sentence the reviewer can check against it. */
const SKIP_WHY = {
  lockfile: "Written by the package manager from its manifest: the change to review is there.",
  generated: "Written by a tool: review the source it is generated from instead.",
  whitespace: "Only spacing or line endings changed.",
  rename: "Moved or renamed with its content unchanged.",
} as const;

/** "Reviewed at stop 1: package.json →", for a lockfile whose manifest is in a stop. */
function sourceLink(ctx: TourContext, path: string): HTMLElement | null {
  const source = lockfileSource(
    path,
    ctx.stops.flatMap((s) => s.files),
  );
  const at = source === null ? null : stopForFile(ctx.stops, source);
  if (source === null || at === null) return null;
  const go = h(
    "button",
    { type: "button", class: "link" },
    `Reviewed at stop ${at + 1}: ${basename(source)} →`,
  );
  go.addEventListener("click", () => ctx.go(stopView(at), "heading", { file: source, line: null }));
  return go;
}

/**
 * The files skipped by design. The heading says what they are; each file says why in a sentence
 * and, for a lockfile, where the change behind it is reviewed. Each opens to its diff to check.
 */
function skippedStop(ctx: TourContext, index: number): HTMLElement {
  const target = ctx.target;
  const body = h(
    "article",
    { class: "stop", "aria-labelledby": "stop-h" },
    h(
      "h2",
      { id: "stop-h", class: "view-heading stop-headline", tabindex: "-1" },
      `${plural(ctx.skipped.length, "file")} with nothing to review`,
    ),
    h(
      "ul",
      { class: "file-rows" },
      ...ctx.skipped.map((f) =>
        fileRow(
          ctx,
          f.path,
          [
            h(
              "p",
              { class: "row wrap small skip-why" },
              h("span", { class: "muted" }, SKIP_WHY[f.reason]),
              f.reason === "lockfile" ? sourceLink(ctx, f.path) : null,
            ),
          ],
          target?.file === f.path ? target.line : undefined,
          [h("span", { class: "tag skip" }, SKIP_LABEL[f.reason])],
        ),
      ),
    ),
  );
  return shell(ctx, { kind: "stop", index }, body);
}

/**
 * The end of the tour is where the review is posted. The wide column runs in the order of the
 * work: the serious findings still to decide on, then the review and Post. Beside it: what is
 * left to cover, then what backs the guide up (the claims check, what the agent read, the flows).
 */
function wrapUp(ctx: TourContext): HTMLElement {
  const { guide, review } = ctx;
  if (review) review.place("inline");
  // Left, in the order of the work: decide on the serious findings, then write and post the
  // review. Beside it, what backs the decision up: what is left to cover, the claims, the flows.
  const main = review ? h("div", { class: "wrap-main" }, toHandle(ctx, review), review.bar) : null;
  const side = h(
    "aside",
    { class: "wrap-side", "aria-label": "Before you post" },
    leftToCover(ctx),
    claims(guide),
    coverageLine(guide),
    ...flows(guide),
  );
  const body = h(
    "article",
    { class: "wrapup", "aria-labelledby": "wrapup-h" },
    h("h2", { id: "wrapup-h", class: "view-heading", tabindex: "-1" }, FINISH),
    h("div", { class: `wrap-layout${review ? "" : " solo"}` }, main, side),
    footer(guide),
  );
  return shell(ctx, { kind: "wrapup" }, body);
}

/** The view for a stored view name. */
export function draw(ctx: TourContext): HTMLElement {
  const v = parseView(ctx.state.view, ctx.count);
  if (v.kind === "stop") return stopPage(ctx, v.index);
  if (v.kind === "wrapup") return wrapUp(ctx);
  return overview(ctx);
}
