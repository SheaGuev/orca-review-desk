// The guide as a tour of the whole PR: an overview with no diffs, then one stop at a time (deep
// stops explain one idea next to only the hunks that matter; skim stops show one example of a
// routine change and list the other files), the files skipped by design last, then a wrap-up with
// the review to post. Each view is drawn from scratch by editor/main.ts when the reviewer moves;
// this file only draws.
import type { Breakdown } from "../src/breakdown/assemble";
import type { DiffFile } from "../src/diff-model";
import { severityCounts, splitFindings, stopForFinding, type StopLike } from "../src/overview";
import { pendingByStop } from "../src/pending";
import type { Finding, PrGuide, SkippedFile, Stop } from "../src/schema";
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
import { createDiffView } from "./diff-view";
import { h, prose } from "./dom";
import {
  basename,
  checklist,
  claims,
  coverageLine,
  DEPTH_LABEL,
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
  WHY_LABEL,
} from "./parts";
import type { Review } from "./review";

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
 * A changed file in a list (a skim stop's other files, the skipped files, Since your last review):
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
  return h("li", {}, view.el);
}

function since(ctx: TourContext): HTMLElement | null {
  const s = ctx.guide.sinceLastReview;
  if (!s) return null;
  return section(
    "since-h",
    "Since your last review",
    `${s.fromCommit.slice(0, 7)} → ${s.toCommit.slice(0, 7)}`,
    "h2",
    h(
      "ul",
      { class: "file-rows" },
      ...s.changes.map((c) =>
        fileRow(ctx, c.file, [
          h("p", {}, prose(c.headline)),
          c.answersComment ? h("span", { class: "tag new" }, "answers your comment") : null,
        ]),
      ),
    ),
    h(
      "p",
      { class: "muted small" },
      s.riskChanged ? "The risk level changed. " : "Risk unchanged. ",
      s.openComments !== null ? `${plural(s.openComments, "of your comments")} still open.` : "",
    ),
  );
}

/** The way into the tour: Start, or Resume and Restart once there is progress. */
function startActions(ctx: TourContext): HTMLElement {
  const n = ctx.count;
  const resume = resumeStop(ctx.state, n);
  const actions = h("div", { class: "row wrap start-actions" });
  if (n === 0) {
    const wrap = h("button", { type: "button", class: "btn primary" }, "Go to wrap-up →");
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
    restart.addEventListener("click", () => ctx.restart());
    actions.append(go, restart);
  }
  return actions;
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

function findingsSection(ctx: TourContext): HTMLElement {
  const { guide } = ctx;
  if (!guide.findings.length)
    return section("findings-h", "Findings", null, "h2", h("p", { class: "muted" }, "None found."));
  const { visible, hidden } = splitFindings(guide.findings);
  const row = (f: Finding, folded: boolean) => {
    const at = stopForFinding(ctx.lookup, f);
    const where = `${f.file}${f.line !== null ? `:${f.line}` : ""}`;
    const loc = h(
      "button",
      {
        type: "button",
        class: "file",
        title: where,
        "aria-label": at !== null ? `${where}: show it at ${stopName(ctx, at)}` : where,
      },
      `${basename(f.file)}${f.line !== null ? `:${f.line}` : ""}`,
    );
    // A finding on a file the guide and git disagree about has nowhere to go.
    if (at === null) loc.setAttribute("disabled", "");
    else
      loc.addEventListener("click", () =>
        ctx.go(stopView(at), "heading", { file: f.file, line: f.line }),
      );
    let goTo: HTMLElement;
    if (at !== null) {
      goTo = h(
        "button",
        {
          type: "button",
          class: "btn sm ghost",
          "aria-label": isSkip(ctx, at)
            ? "Go to the skipped files"
            : `Go to stop ${at + 1}: ${ctx.stops[at].headline}`,
        },
        isSkip(ctx, at) ? "Skipped →" : `Stop ${at + 1} →`,
      );
      goTo.addEventListener("click", () => ctx.go(stopView(at)));
    } else goTo = h("span", {});
    const li = h(
      "li",
      { class: "finding-row" },
      h("span", { class: `tag sev ${f.severity}` }, SEVERITY_LABEL[f.severity]),
      h("div", { class: "stack-xs" }, h("p", { class: "headline" }, prose(f.headline)), loc),
      goTo,
    );
    if (folded) li.hidden = true;
    return li;
  };
  const list = h(
    "ul",
    { class: "finding-list", id: "finding-list" },
    ...visible.map((f) => row(f, false)),
    ...hidden.map((f) => row(f, true)),
  );
  let toggle: HTMLElement | null = null;
  if (hidden.length) {
    const label = `Show ${hidden.length} more`;
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
        if (i >= visible.length) el.hidden = !open;
      });
    });
    toggle = b;
  }
  return section("findings-h", "Findings", severityCounts(guide.findings), "h2", list, toggle);
}

/**
 * A stop's depth as a text tag, and why it has it, for the stop list. "has findings" is left out
 * when the row's severity tags already say so.
 */
function depthTags(stop: Stop, flagged: boolean): HTMLElement[] {
  const why = stop.why === "finding" && flagged ? null : WHY_LABEL[stop.why];
  return [
    h("span", { class: `tag depth ${stop.depth}` }, DEPTH_LABEL[stop.depth]),
    ...(why
      ? [
          h("span", { class: "small muted" }, why),
          h("span", { class: "small muted", "aria-hidden": "true" }, "·"),
        ]
      : []),
  ];
}

/** "1 lockfile, 4 whitespace only": the skipped files by reason. */
function skipSummary(skipped: readonly SkippedFile[]): string {
  const counts = new Map<string, number>();
  for (const f of skipped) counts.set(f.reason, (counts.get(f.reason) ?? 0) + 1);
  return [...counts]
    .map(([reason, n]) => `${n} ${SKIP_LABEL[reason as SkippedFile["reason"]].toLowerCase()}`)
    .join(", ");
}

function tourSection(ctx: TourContext): HTMLElement {
  const { stops, state, guide } = ctx;
  if (!ctx.count)
    return section(
      "tour-h",
      "Tour",
      null,
      "h2",
      h("p", { class: "muted small" }, "This guide has no reading order, so there are no stops."),
    );
  const row = (i: number, title: Node | string, meta: (Node | null)[], aria: string) => {
    const seen = state.visited.includes(i);
    const b = h(
      "button",
      { type: "button", class: "stop-link" },
      h("span", { class: "stop-num", "aria-hidden": "true" }, isSkip(ctx, i) ? "–" : String(i + 1)),
      h(
        "span",
        { class: "stack-xs" },
        h("span", { class: "stop-title" }, title),
        h(
          "span",
          { class: "row wrap stop-meta" },
          ...meta,
          seen ? h("span", { class: "small seen-mark" }, "✓ seen") : null,
        ),
      ),
    );
    b.setAttribute("aria-label", `${aria}${seen ? " (seen)" : ""}`);
    b.addEventListener("click", () => ctx.go(stopView(i)));
    return h("li", {}, b);
  };
  const list = h(
    "ol",
    { class: "stop-list" },
    ...stops.map((stop, i) =>
      row(
        i,
        prose(stop.headline),
        [
          ...depthTags(stop, findingsIn(guide, stop.files).length > 0),
          h(
            "span",
            { class: "mono small muted" },
            stop.files.length > 1 ? plural(stop.files.length, "file") : basename(stop.files[0]),
          ),
          ...severityTags(findingsIn(guide, stop.files)),
        ],
        `Stop ${i + 1}, ${DEPTH_LABEL[stop.depth].toLowerCase()}, ${plural(stop.files.length, "file")}: ${stop.headline}`,
      ),
    ),
    ctx.skipped.length
      ? row(
          stops.length,
          `${SKIP_TITLE} · ${plural(ctx.skipped.length, "file")}`,
          [h("span", { class: "small muted" }, skipSummary(ctx.skipped))],
          `${SKIP_TITLE}: ${plural(ctx.skipped.length, "file")}, ${skipSummary(ctx.skipped)}`,
        )
      : null,
  );
  const { total } = filesCovered([], shapeOf(ctx));
  return section(
    "tour-h",
    "Tour",
    `${plural(stops.length, "stop")} · covers ${plural(total, "file")} · ~${tourMinutes({ ...guide, readingOrder: stops })} min`,
    "h2",
    list,
  );
}

export function overview(ctx: TourContext): HTMLElement {
  const { guide } = ctx;
  return h(
    "main",
    { class: "page overview" },
    ctx.older
      ? h(
          "div",
          { class: "banner", role: "note" },
          h("strong", {}, "Made by an older version of PR Tour."),
          " It has no findings or file notes. ",
          ctx.regenerate("Regenerate"),
        )
      : null,
    header(ctx),
    since(ctx),
    h(
      "div",
      { class: "ov-top" },
      h(
        "section",
        { class: "points", "aria-label": "Summary" },
        pointRow("What", guide.summary.what),
        pointRow("Why", guide.summary.why),
        pointRow("Impact", guide.summary.impact),
      ),
      h("div", { class: "stack ov-side" }, riskCard(ctx), changesSection(ctx)),
    ),
    findingsSection(ctx),
    tourSection(ctx),
    ctx.notice,
  );
}

// ---------------------------------------------------------------- stops and wrap-up

type Here = { kind: "stop"; index: number } | { kind: "wrapup" };

/** Every place the tour can go, as buttons: the rail on a wide tab, the menu on a narrower one. */
function steps(ctx: TourContext, here: Here, onPick?: () => void): HTMLElement {
  const { stops, state, guide } = ctx;
  const item = (
    view: TourView,
    label: Node[],
    aria: string,
    current: boolean,
    focus?: FocusTarget,
  ) => {
    const b = h("button", { type: "button", class: "step-link", "aria-label": aria }, ...label);
    if (current) b.setAttribute("aria-current", "step");
    b.addEventListener("click", () => {
      onPick?.();
      ctx.go(view, focus);
    });
    return h("li", {}, b);
  };
  const mark = (text: string, cls = "") =>
    h("span", { class: `mark ${cls}`, "aria-hidden": "true" }, text);
  /** Each stop's pending-comment count, kept current as comments are added and deleted. */
  const counts: { el: HTMLElement; button: HTMLElement; aria: string }[] = [];
  const drawCounts = () => {
    const n = pendingByStop(ctx.lookup, ctx.review?.all() ?? []);
    counts.forEach(({ el, button, aria }, i) => {
      el.textContent = n[i] ? String(n[i]) : "";
      el.hidden = !n[i];
      button.setAttribute(
        "aria-label",
        n[i] ? `${aria} (${plural(n[i], "pending comment")})` : aria,
      );
    });
  };
  /** One stop's entry; `name` is what the rail shows, `extra` sits after the pending count. */
  const stopItem = (i: number, name: Node[], aria: string, extra: (HTMLElement | null)[]) => {
    const current = here.kind === "stop" && here.index === i;
    const seen = state.visited.includes(i);
    const count = h("span", { class: "step-pending", "aria-hidden": "true" });
    const full = `${aria}${current ? " (current)" : seen ? " (seen)" : ""}`;
    const li = item(
      stopView(i),
      [
        mark(
          current ? "●" : seen ? "✓" : isSkip(ctx, i) ? "–" : String(i + 1),
          current ? "now" : seen ? "seen" : "",
        ),
        ...name,
        count,
        ...extra.filter((x): x is HTMLElement => x !== null),
      ],
      full,
      current,
    );
    counts.push({ el: count, button: li.querySelector("button") as HTMLElement, aria: full });
    return li;
  };
  const list = h(
    "ol",
    { class: "steps" },
    item("overview", [mark("◇"), h("span", {}, "Overview")], "Overview", false),
    ...stops.map((stop, i) => {
      const flagged = findingsIn(guide, stop.files).length > 0;
      const more = stop.files.length - 1;
      return stopItem(
        i,
        [
          h("span", { class: "step-name" }, basename(stop.files[0])),
          more ? h("span", { class: "step-more", "aria-hidden": "true" }, `+${more}`) : null,
          // The depth in words (short), so a skim stop doesn't read as a deep one by colour alone.
          h("span", { class: `step-depth ${stop.depth}`, "aria-hidden": "true" }, stop.depth),
        ].filter((x): x is HTMLElement => x !== null),
        `Stop ${i + 1}, ${stop.depth}, ${plural(stop.files.length, "file")}: ${stop.headline}${flagged ? " (has findings)" : ""}`,
        [flagged ? mark("⚑", "flag") : null],
      );
    }),
    ctx.skipped.length
      ? stopItem(
          stops.length,
          [
            h(
              "span",
              { class: "step-name plain" },
              `Skipped · ${plural(ctx.skipped.length, "file")}`,
            ),
          ],
          `${SKIP_TITLE}: ${plural(ctx.skipped.length, "file")}`,
          [],
        )
      : null,
    item(
      "wrapup",
      [
        mark(here.kind === "wrapup" ? "●" : "◇", here.kind === "wrapup" ? "now" : ""),
        h("span", {}, "Wrap-up"),
      ],
      "Wrap-up",
      here.kind === "wrapup",
    ),
  );
  drawCounts();
  if (ctx.review) ctx.track(ctx.review.onChange(drawCounts));
  return list;
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
    if (!list.hidden && !box.contains(e.target as Node)) close(false);
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

function topBar(ctx: TourContext, here: Here): HTMLElement {
  const n = ctx.count;
  const { covered, total } = filesCovered(ctx.state.visited, shapeOf(ctx));
  const stop = here.kind === "stop" && !isSkip(ctx, here.index) ? ctx.stops[here.index] : null;
  const area = stop ? (ctx.guide.areas.find((a) => a.id === stop.areaId)?.label ?? null) : null;
  const label =
    here.kind === "wrapup"
      ? // The page's own heading says Wrap-up; the bar says where that is.
        "End of the tour"
      : stop
        ? `Stop ${here.index + 1} of ${ctx.stops.length} · ${DEPTH_LABEL[stop.depth]}${area ? ` · ${area}` : ""}`
        : SKIP_TITLE;
  const text = coveredText(ctx);
  const progress = h(
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
  );
  const prevView: TourView | null =
    here.kind === "wrapup"
      ? n
        ? stopView(n - 1)
        : "overview"
      : here.index > 0
        ? stopView(here.index - 1)
        : null;
  const nextView: TourView | null =
    here.kind === "stop" ? (here.index + 1 < n ? stopView(here.index + 1) : "wrapup") : null;
  const nav = (view: TourView | null, text: string, aria: string, focus: FocusTarget) => {
    // Kept in place (hidden) at the ends, so the other buttons don't jump as you step.
    const b = h(
      "button",
      { type: "button", class: `btn sm nav-${focus}`, "aria-label": aria },
      text,
    );
    if (view === null) b.classList.add("invisible");
    else b.addEventListener("click", () => ctx.go(view, focus));
    return b;
  };
  const prevIndex = here.kind === "stop" ? here.index - 1 : n - 1;
  // Leaving keeps progress: the overview then offers Resume.
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
  return h(
    "div",
    { class: "topbar" },
    exit,
    h("p", { class: "topbar-label" }, label),
    stepMenu(ctx, here, label),
    h(
      "div",
      { class: "row progress-wrap" },
      progress,
      h("span", { class: "muted small progress-text", "aria-hidden": "true" }, text),
    ),
    h(
      "div",
      { class: "row" },
      nav(
        prevView,
        "‹ Prev",
        prevView === "overview" ? "Previous: overview" : `Previous: ${stopName(ctx, prevIndex)}`,
        "prev",
      ),
      nav(
        nextView,
        nextView === "wrapup" ? "Wrap-up ›" : "Next ›",
        nextView === "wrapup"
          ? "Next: wrap-up"
          : `Next: ${here.kind === "stop" ? stopName(ctx, here.index + 1) : ""}`,
        "next",
      ),
    ),
  );
}

function shell(ctx: TourContext, here: Here, body: HTMLElement): HTMLElement {
  return h(
    "div",
    { class: "tour" },
    h("nav", { class: "rail", "aria-label": "Tour stops" }, steps(ctx, here)),
    h("div", { class: "tour-main" }, topBar(ctx, here), body, ctx.notice),
  );
}

/** A deep or skim stop: the explanation, the first file's focused hunks, then its other files. */
export function stop(ctx: TourContext, index: number): HTMLElement {
  if (isSkip(ctx, index)) return skippedStop(ctx, index);
  const s = ctx.stops[index];
  const [primary, ...others] = s.files;
  const target = ctx.target;
  // A finding's file:line opens the file at that line, even if the reviewer had closed it here.
  const line = target?.file === primary ? target.line : null;
  const closed = ctx.state.collapsed.includes(index) && target?.file !== primary;
  if (!closed && ctx.state.collapsed.includes(index)) ctx.setCollapsed(index, false);
  const diff = createDiffView({
    guide: ctx.guide,
    load: ctx.load,
    review: ctx.review,
    openInOrca: ctx.openInOrca,
    focus: s.focus ?? null,
    expanded: !closed,
    onToggle: (open) => ctx.setCollapsed(index, !open),
    focusComment: target?.file === primary ? target.commentId : null,
  });
  ctx.track(() => diff.dispose());
  void diff.show(primary, line);
  const notes = new Map(ctx.guide.files.map((f) => [f.path, f.note]));
  // A skim stop's other files make the same change: closed, each opens to its whole diff.
  const rest = others.length
    ? h(
        "section",
        { class: "section", "aria-labelledby": "others-h" },
        h(
          "h3",
          { id: "others-h" },
          s.depth === "skim"
            ? `Same change in ${plural(others.length, "more file")}`
            : `Also in this stop · ${plural(others.length, "file")}`,
        ),
        h(
          "ul",
          { class: "file-rows" },
          ...others.map((path) => {
            const note = notes.get(path);
            const tags = severityTags(findingsIn(ctx.guide, [path]));
            return fileRow(
              ctx,
              path,
              [
                tags.length ? h("div", { class: "row wrap" }, ...tags) : null,
                note ? h("p", { class: "muted small measure" }, prose(note)) : null,
              ],
              target?.file === path ? target.line : undefined,
            );
          }),
        ),
      )
    : null;
  const body = h(
    "article",
    { class: "stop", "aria-labelledby": "stop-h" },
    h(
      "h2",
      { id: "stop-h", class: "view-heading stop-headline", tabindex: "-1" },
      prose(s.headline),
    ),
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
    diff.el,
    rest,
  );
  return shell(ctx, { kind: "stop", index }, body);
}

/** The last stop: every file skipped by design, with why, each openable to check. */
function skippedStop(ctx: TourContext, index: number): HTMLElement {
  const target = ctx.target;
  const body = h(
    "article",
    { class: "stop", "aria-labelledby": "stop-h" },
    h("h2", { id: "stop-h", class: "view-heading stop-headline", tabindex: "-1" }, SKIP_TITLE),
    h(
      "p",
      { class: "measure explain" },
      "No stop for these: nothing in them to review. Each says why; open one to check.",
    ),
    h(
      "ul",
      { class: "file-rows" },
      ...ctx.skipped.map((f) =>
        fileRow(ctx, f.path, [], target?.file === f.path ? target.line : undefined, [
          h("span", { class: "tag skip" }, SKIP_LABEL[f.reason]),
        ]),
      ),
    ),
  );
  return shell(ctx, { kind: "stop", index }, body);
}

export function wrapUp(ctx: TourContext): HTMLElement {
  const { guide, stops, state } = ctx;
  const unseen = [...Array(ctx.count).keys()].filter((i) => !state.visited.includes(i));
  const { covered, total } = filesCovered(state.visited, shapeOf(ctx));
  const left = total - covered;
  const seenLine = h(
    "section",
    { class: "section", "aria-label": "Files covered" },
    // The top bar says how many files are covered; this says what is left, and where.
    h(
      "p",
      {},
      h(
        "strong",
        {},
        left
          ? `${plural(left, "file")} not covered yet, in ${unseen.length === 1 ? "this stop" : "these stops"}:`
          : `You’ve covered all ${plural(total, "file")}.`,
      ),
    ),
    unseen.length
      ? h(
          "ul",
          { class: "unseen" },
          ...unseen.map((i) => {
            const b = h(
              "button",
              { type: "button", class: "link" },
              ...(isSkip(ctx, i)
                ? [`${SKIP_TITLE}: ${plural(ctx.skipped.length, "file")}`]
                : [`Stop ${i + 1}: `, prose(stops[i].headline)]),
            );
            b.addEventListener("click", () => ctx.go(stopView(i)));
            return h("li", {}, b);
          }),
        )
      : null,
  );
  if (ctx.review) ctx.review.place("inline");
  const body = h(
    "article",
    { class: "wrapup", "aria-labelledby": "wrapup-h" },
    h("h2", { id: "wrapup-h", class: "view-heading", tabindex: "-1" }, "Wrap-up"),
    seenLine,
    claims(guide),
    coverageLine(guide),
    ...flows(guide),
    ctx.review ? ctx.review.bar : null,
    footer(guide),
  );
  return shell(ctx, { kind: "wrapup" }, body);
}

/** The view for a stored view name. */
export function draw(ctx: TourContext): HTMLElement {
  const v = parseView(ctx.state.view, ctx.count);
  if (v.kind === "stop") return stop(ctx, v.index);
  if (v.kind === "wrapup") return wrapUp(ctx);
  return overview(ctx);
}
