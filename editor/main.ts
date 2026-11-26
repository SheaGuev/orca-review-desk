// The guide tab: draws a .prreview.json file as a guided tour (overview, one stop at a time,
// wrap-up; see editor/tour.ts) and remembers where the reviewer is through the worker. It never
// edits the file, so Orca's Source view stays the way to see the raw JSON. Everything from the
// guide goes in as text, never as HTML.
import { FINISH } from "./parts";
import type { Breakdown } from "../src/breakdown/assemble";
import { promiseCache } from "../src/cache";
import { fullTour } from "../src/coverage";
import type { DiffFile } from "../src/diff-model";
import { message } from "../src/errors";
import { stopForComment } from "../src/pending";
import { prKey } from "../src/repo";
import {
  parseGuide,
  SCHEMA_V1,
  upgradeGuide,
  upgradeV1,
  type PrGuide,
  type SkippedFile,
  type Stop,
} from "../src/schema";
import {
  filesCovered,
  freshTour,
  neighbourView,
  parseView,
  setCollapsed,
  showView,
  stopCount,
  stopView,
  type TourState,
  type TourView,
} from "../src/tour";
import { h } from "./dom";
import { startReview, type Review } from "./review";
import { codeThemeButton } from "./code-theme";
import { fitRail } from "./rail-layout";
import { STYLE } from "./style";
import { draw, type FocusTarget, type LineTarget, type TourContext } from "./tour";
import { createViewed } from "./viewed";

const style = document.createElement("style");
style.textContent = STYLE;
document.head.append(style);
const root =
  document.getElementById("root") ?? document.body.appendChild(document.createElement("div"));
// Outside `root`, so it survives every redraw and screen readers hear each move.
const announcer = h("p", { class: "sr-only", role: "status" });
document.body.append(announcer);
/** Says `text` through the status line; cleared first, so the same words twice are heard twice. */
function announce(text: string): void {
  announcer.textContent = "";
  requestAnimationFrame(() => (announcer.textContent = text));
}

const html = document.documentElement;
document.body.append(codeThemeButton(html));
/** Tab width where the overview gets its columns. */
const COLUMNS_MIN = 1100;
/** Below this, tighter page padding and stacked rows. */
const NARROW_MAX = 600;
// The tab's own width, not the window's: Orca resizes tabs as sidebars open and close. Only
// classes change, so nothing is redrawn and nothing typed is lost.
const fitWidth = () => {
  html.classList.toggle("w-cols", html.clientWidth >= COLUMNS_MIN);
  fitRail();
  html.classList.toggle("w-narrow", html.clientWidth < NARROW_MAX);
};
fitWidth();
new ResizeObserver(() => requestAnimationFrame(fitWidth)).observe(html);
// A diff is code: it takes the font, size, weight and ligatures of Orca's file editor (zoom
// included) and follows them as they change. Rows stay at least 24px for the comment button.
const fitTypography = (t: {
  cssFontFamily: string;
  fontSize: number;
  fontWeight: string;
  fontLigatures: boolean;
}) => {
  html.style.setProperty("--code-font", `${t.cssFontFamily}, var(--mono)`);
  html.style.setProperty("--code-size", `${t.fontSize}px`);
  html.style.setProperty("--code-weight", t.fontWeight);
  html.style.setProperty("--code-lh", `${Math.max(24, Math.round(t.fontSize * 1.5))}px`);
  html.style.setProperty("--code-liga", t.fontLigatures ? "normal" : "none");
};
if (orca.host.has("editor.readTypography")) {
  void orca.host
    .call("editor.readTypography")
    .then(fitTypography)
    .catch(() => {});
  orca.on("editor.typography.changed", fitTypography);
}
// Focus scrolled into view stays clear of the fixed review bar (--bar-h is measured).
const barSize = new ResizeObserver((entries) => {
  const height = Math.ceil(entries[0]?.borderBoxSize[0]?.blockSize ?? 0);
  requestAnimationFrame(() => html.style.setProperty("--bar-h", `${height}px`));
});

/** Where focus lands after a move, by what made it; a pending comment is focused by its diff. */
const FOCUS_SELECTOR: Record<Exclude<FocusTarget, "comment">, string> = {
  heading: ".view-heading",
  menu: ".menu-btn",
  file: ".is-target .dv-toggle",
  prev: ".topbar .nav-prev:not(.invisible)",
  next: ".topbar .nav-next:not(.invisible)",
};
/** Where a key press means something else: Esc and the arrows belong to the field. */
const TYPING = "input, textarea, select, [contenteditable=''], [contenteditable='true']";

function renderProblem(raw: string, problems: string[]): void {
  root.replaceChildren(
    h(
      "div",
      { class: "page" },
      h(
        "div",
        { class: "banner bad", role: "alert" },
        h("strong", {}, "This guide doesn’t match the prguide format"),
        h("ul", {}, ...problems.slice(0, 8).map((p) => h("li", { class: "mono" }, p))),
        h("p", {}, "Use Source to see the file, or Regenerate from the Reviews panel."),
      ),
      h("pre", { class: "raw" }, raw.slice(0, 200_000)),
    ),
  );
}

/** The tour for one guide: its state, and drawing the view the state names. */
type Tour = {
  draw: (focus?: FocusTarget) => void;
  setReview: (r: Review) => void;
  dispose: () => void;
};

/**
 * The guide's tour: its stops with full coverage, the files skipped by design (their stop comes
 * last), and every stop as `{ files, focus }` for finding where a file, finding or comment is.
 */
type TourData = {
  stops: Stop[];
  skipped: SkippedFile[];
  lookup: { files: string[]; focus?: Stop["focus"] }[];
};

function tourData(guide: PrGuide, skipped: SkippedFile[]): TourData {
  const stops = fullTour(guide, skipped);
  const lookup = stops.map((s) => ({ files: s.files, focus: s.focus }));
  if (skipped.length) lookup.push({ files: skipped.map((f) => f.path), focus: undefined });
  return { stops, skipped, lookup };
}

/** What the tour asks the worker for, and the two links that act on the guide. */
function workerLinks(guide: PrGuide, say: (text: string) => void) {
  const key = prKey(guide.pr.repo, guide.pr.number);
  const { commit } = guide.pr;
  /** Asked of the worker once each; a failed answer is asked for again. */
  const diffs = promiseCache<DiffFile>();
  const changes = promiseCache<Breakdown>();
  const viewed = createViewed({
    load: async () => (await orca.plugin.request("viewed.get", { key })).viewed,
    save: (path, on) => orca.plugin.request("viewed.set", { key, path, viewed: on }),
    say,
  });
  return {
    viewed,
    load: (path: string) =>
      diffs.get(path, () =>
        orca.plugin.request("diff.get", { key, path, commit }, { timeoutMs: 120_000 }),
      ),
    breakdown: () =>
      changes.get("", () =>
        orca.plugin.request("breakdown.get", { key, commit }, { timeoutMs: 120_000 }),
      ),
    resolveImport: (from: string, specifier: string) =>
      orca.plugin.request("import.resolve", { key, from, specifier }),
    openInOrca: (path: string) =>
      void orca.plugin
        .request("file.open", { repo: guide.pr.repo, number: guide.pr.number, path })
        .catch((e: unknown) => say(message(e))),
    regenerate: (label: string) => {
      const b = h("button", { type: "button", class: "link" }, label);
      b.addEventListener("click", () => {
        say(
          "Writing a new guide in the background. This tab updates when you open it again from Reviews.",
        );
        orca.plugin.request("guide.generate", { key }).catch((e: unknown) => say(message(e)));
      });
      return b;
    },
  };
}

/** A view in words, for the screen reader's announcement of each move. */
function describeView(view: TourView, data: TourData, count: number): string {
  const v = parseView(view, count);
  if (v.kind === "wrapup") return FINISH;
  if (v.kind === "overview") return "Overview";
  // The skipped files' stop comes after the others.
  return data.skipped.length && v.index === data.stops.length
    ? `Skipped by design: ${data.skipped.length} files`
    : `Stop ${v.index + 1} of ${data.stops.length}: ${data.stops[v.index]?.headline ?? ""}`;
}

/** Puts a drawn view on the page, with the review bar under it unless the view holds the review. */
function mount(view: HTMLElement, bar: HTMLElement | null, focus: FocusTarget | undefined): void {
  html.classList.toggle("has-bar", bar !== null);
  root.replaceChildren(view, ...(bar ? [bar] : []));
  barSize.disconnect();
  if (bar) barSize.observe(bar);
  else html.style.removeProperty("--bar-h");
  if (!focus) return;
  window.scrollTo(0, 0);
  // A pending comment: the heading for now; the diff moves focus to the card.
  const landing =
    focus === "comment" ? null : root.querySelector<HTMLElement>(FOCUS_SELECTOR[focus]);
  (landing ?? root.querySelector<HTMLElement>(".view-heading"))?.focus();
  landing?.scrollIntoView({ block: "nearest" });
}

/**
 * Where a key press takes the tour from `view`, or null when it is not the tour's to handle:
 * ←/→ and j/k step through it and Esc leaves it for the overview, unless focus is somewhere keys
 * mean something else (Esc in a text field belongs to it; an open menu closes first).
 */
function keyTarget(e: KeyboardEvent, view: TourView, count: number): TourView | null {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return null;
  const t = e.target instanceof Element ? e.target : null;
  if (t?.closest(TYPING)) return null;
  if (e.key === "Escape") return parseView(view, count).kind === "overview" ? null : "overview";
  const arrow = e.key === "ArrowLeft" || e.key === "ArrowRight";
  // Arrow keys scroll a diff sideways when it has focus.
  if (arrow && t?.closest(".dv-scroll")) return null;
  const forward = e.key === "ArrowRight" || e.key === "j";
  const back = e.key === "ArrowLeft" || e.key === "k";
  return forward || back ? neighbourView(view, count, forward) : null;
}

/** One guide's tour as it runs: what it shows, where the reviewer is, and what to clean up. */
type Running = {
  readonly key: string;
  readonly guide: PrGuide;
  readonly older: boolean;
  readonly data: TourData;
  /** Stops, the skipped files' stop included; it is the last index when there is one. */
  readonly count: number;
  /** The tab's status line for errors (Regenerate, Open in Orca, saving). */
  readonly notice: HTMLElement;
  readonly links: ReturnType<typeof workerLinks>;
  state: TourState;
  review: Review | null;
  /** Undone before each redraw: diff views, document listeners. */
  cleanups: (() => void)[];
};

function saveTour(t: Running): void {
  orca.plugin.request("tour.save", { key: t.key, state: t.state }).catch((e: unknown) => {
    t.notice.textContent = `Couldn’t save your place in the tour: ${message(e)}`;
  });
}

function cleanUp(t: Running): void {
  for (const c of t.cleanups) c();
  t.cleanups = [];
}

/** Moves to `view`: remembered through the worker, announced, then drawn. */
function go(
  t: Running,
  view: TourView,
  focus: FocusTarget = "heading",
  target: LineTarget | null = null,
): void {
  t.state = showView(t.state, view, t.count);
  saveTour(t);
  announce(describeView(t.state.view, t.data, t.count));
  render(t, focus, target);
}

/** What the views draw from, for the state as it is now. */
function contextOf(t: Running, target: LineTarget | null): TourContext {
  return {
    guide: t.guide,
    older: t.older,
    review: t.review,
    state: t.state,
    stops: t.data.stops,
    skipped: t.data.skipped,
    count: t.count,
    lookup: t.data.lookup,
    go: (view, focus, line) => go(t, view, focus, line),
    target,
    setCollapsed: (index, collapsed) => {
      t.state = setCollapsed(t.state, index, collapsed);
      saveTour(t);
    },
    restart: () => {
      t.state = freshTour(t.state.commit);
      go(t, stopView(0));
    },
    ...t.links,
    notice: t.notice,
    track: (dispose) => t.cleanups.push(dispose),
  };
}

function render(t: Running, focus?: FocusTarget, target: LineTarget | null = null): void {
  cleanUp(t);
  const { review } = t;
  const wrapup = parseView(t.state.view, t.count).kind === "wrapup";
  // The wrap-up holds the review composer itself; everywhere else it is the compact bar.
  if (review && !wrapup) review.place("bar");
  mount(draw(contextOf(t, target)), review && !wrapup ? review.bar : null, focus);
}

/** Connects the review's bar and jump links to the tour, then draws it with them. */
function bindReview(t: Running, r: Review): void {
  t.review = r;
  r.bind({
    finish: () => go(t, "wrapup"),
    uncovered: () => {
      const skipped = t.data.skipped.map((f) => f.path);
      const { covered, total } = filesCovered(t.state.visited, { stops: t.data.stops, skipped });
      return total - covered;
    },
    // A comment's stop (as for a finding on its line); every changed file is in one.
    jump: (c) => {
      const at = stopForComment(t.data.lookup, c);
      go(t, at === null ? "wrapup" : stopView(at), "comment", {
        file: c.path,
        line: c.line,
        commentId: c.id,
      });
    },
  });
  render(t);
}

function startTour(guide: PrGuide, older: boolean, initial: TourState, data: TourData): Tour {
  const notice = h("p", { class: "notice", role: "status" });
  const t: Running = {
    key: prKey(guide.pr.repo, guide.pr.number),
    guide,
    older,
    data,
    count: stopCount({ stops: data.stops, skipped: data.skipped.map((f) => f.path) }),
    notice,
    links: workerLinks(guide, (text) => (notice.textContent = text)),
    state: initial,
    review: null,
    cleanups: [],
  };
  const onKey = (e: KeyboardEvent): void => {
    const to = keyTarget(e, t.state.view, t.count);
    if (to === null) return;
    e.preventDefault();
    go(t, to);
  };
  document.addEventListener("keydown", onKey);
  return {
    draw: (focus) => render(t, focus),
    setReview: (r) => bindReview(t, r),
    dispose: () => {
      document.removeEventListener("keydown", onKey);
      cleanUp(t);
    },
  };
}

/** Each show() supersedes the last, so a slow request never draws over a newer file. */
let shown = 0;
let current: Tour | null = null;

async function show(text: string): Promise<void> {
  const run = ++shown;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    current?.dispose();
    current = null;
    renderProblem(text, [`(root): not valid JSON (${message(error)})`]);
    return;
  }
  const parsed = parseGuide(value);
  if (!parsed.ok) {
    current?.dispose();
    current = null;
    renderProblem(text, parsed.problems);
    return;
  }
  const older = parsed.guide.schema === SCHEMA_V1;
  const guide =
    parsed.guide.schema === SCHEMA_V1 ? upgradeV1(parsed.guide) : upgradeGuide(parsed.guide);
  const key = prKey(guide.pr.repo, guide.pr.number);
  // Guides written before the tour stored its skipped files ask the worker (git) for them.
  const skipped =
    guide.skipped ??
    (older
      ? []
      : await orca.plugin
          .request("skipped.get", { key, commit: guide.pr.commit }, { timeoutMs: 120_000 })
          .catch(() => [] as SkippedFile[]));
  if (run !== shown) return;
  const data = tourData(guide, skipped);
  const stops = stopCount({ stops: data.stops, skipped: skipped.map((f) => f.path) });
  // Where the reviewer left off on this commit; a new commit (or no worker answer) starts over.
  const state = await orca.plugin
    .request("tour.get", { key, commit: guide.pr.commit, stops })
    .catch(() => freshTour(guide.pr.commit));
  if (run !== shown) return;
  current?.dispose();
  const tour = startTour(guide, older, state, data);
  current = tour;
  tour.draw();
  // Review controls need the worker's draft; a v1 guide has no comment lines to check against.
  const review = older ? null : await startReview(guide, announce, data.lookup);
  if (!review || run !== shown) return;
  tour.setReview(review);
}

const documentApi = orca.document;
if (!documentApi) throw new Error("editor/main.ts runs as a custom editor");
const doc = await documentApi.session();
void show(doc.value);
doc.onReplace((value) => void show(value));
