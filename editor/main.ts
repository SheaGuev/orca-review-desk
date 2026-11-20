// The guide tab: draws a .prtour.json file as a guided tour (overview, one stop at a time,
// wrap-up; see editor/tour.ts) and remembers where the reviewer is through the worker. It never
// edits the file, so Orca's Source view stays the way to see the raw JSON. Everything from the
// guide goes in as text, never as HTML.
import type { Breakdown } from "../src/breakdown/assemble";
import { fullTour } from "../src/coverage";
import type { DiffFile } from "../src/diff-model";
import { stopForComment } from "../src/pending";
import {
  checkGuide,
  SCHEMA_V1,
  upgradeGuide,
  upgradeV1,
  type PrGuide,
  type PrGuideV1,
  type SkippedFile,
  type Stop,
} from "../src/schema";
import {
  freshTour,
  parseView,
  setCollapsed,
  showView,
  skipIndex,
  stopCount,
  stopView,
  type TourState,
  type TourView,
} from "../src/tour";
import { h } from "./dom";
import { startReview, type Review } from "./review";
import { STYLE } from "./style";
import { draw, type FocusTarget, type LineTarget, type TourContext } from "./tour";

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
/** Tab widths where the layout changes: overview columns and the stop menu, then the rail. */
const COLUMNS_MIN = 1100;
const RAIL_MIN = 1400;
/** Below this, tighter page padding and stacked rows. */
const NARROW_MAX = 600;
// The tab's own width, not the window's: Orca resizes tabs as sidebars open and close. Only
// classes change, so nothing is redrawn and nothing typed is lost.
const fitWidth = () => {
  html.classList.toggle("w-cols", html.clientWidth >= COLUMNS_MIN);
  html.classList.toggle("w-rail", html.clientWidth >= RAIL_MIN);
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

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

function startTour(guide: PrGuide, older: boolean, initial: TourState, data: TourData): Tour {
  const key = `${guide.pr.repo}#${guide.pr.number}`;
  const { stops, skipped, lookup } = data;
  const shape = { stops, skipped: skipped.map((f) => f.path) };
  /** Stops, the skipped files' stop included; it is the last index when there is one. */
  const count = stopCount(shape);
  const skipAt = skipIndex(shape);
  let state = initial;
  let review: Review | null = null;
  let cleanups: (() => void)[] = [];
  const notice = h("p", { class: "notice", role: "status" });
  const say = (text: string) => (notice.textContent = text);

  const cache = new Map<string, Promise<DiffFile>>();
  const load = (path: string) => {
    let found = cache.get(path);
    if (!found) {
      found = orca.plugin.request(
        "diff.get",
        { key, path, commit: guide.pr.commit },
        { timeoutMs: 120_000 },
      );
      found.catch(() => cache.delete(path));
      cache.set(path, found);
    }
    return found;
  };

  let changes: Promise<Breakdown> | null = null;
  const breakdown = () => {
    if (!changes) {
      const asked = orca.plugin.request(
        "breakdown.get",
        { key, commit: guide.pr.commit },
        { timeoutMs: 120_000 },
      );
      asked.catch(() => (changes = null));
      changes = asked;
    }
    return changes;
  };

  const save = () =>
    orca.plugin
      .request("tour.save", { key, state })
      .catch((e: unknown) => say(`Couldn’t save your place in the tour: ${message(e)}`));

  const describe = (view: TourView) => {
    const v = parseView(view, count);
    if (v.kind === "stop")
      return v.index === skipAt
        ? `Skipped by design: ${skipped.length} files`
        : `Stop ${v.index + 1} of ${stops.length}: ${stops[v.index].headline}`;
    return v.kind === "wrapup" ? "Wrap-up" : "Overview";
  };

  function go(
    view: TourView,
    focus: FocusTarget = "heading",
    target: LineTarget | null = null,
  ): void {
    state = showView(state, view, count);
    void save();
    announce(describe(state.view));
    render(focus, target);
  }

  const regenerate = (label: string) => {
    const b = h("button", { type: "button", class: "link" }, label);
    b.addEventListener("click", () => {
      say(
        "Writing a new guide in the background. This tab updates when you open it again from Reviews.",
      );
      orca.plugin.request("guide.generate", { key }).catch((e: unknown) => say(message(e)));
    });
    return b;
  };

  function render(focus?: FocusTarget, target: LineTarget | null = null): void {
    for (const c of cleanups) c();
    cleanups = [];
    const ctx: TourContext = {
      guide,
      older,
      review,
      state,
      stops,
      skipped,
      count,
      lookup,
      go,
      target,
      setCollapsed: (index, collapsed) => {
        state = setCollapsed(state, index, collapsed);
        void save();
      },
      restart: () => {
        state = freshTour(state.commit);
        go(stopView(0));
      },
      load,
      breakdown,
      openInOrca: (path) =>
        void orca.plugin
          .request("file.open", { repo: guide.pr.repo, number: guide.pr.number, path })
          .catch((e: unknown) => say(message(e))),
      regenerate,
      notice,
      track: (dispose) => cleanups.push(dispose),
    };
    const wrapup = parseView(state.view, count).kind === "wrapup";
    // The wrap-up holds the review composer itself; everywhere else it is the compact bar.
    if (review && !wrapup) review.place("bar");
    const view = draw(ctx);
    html.classList.toggle("has-bar", Boolean(review) && !wrapup);
    root.replaceChildren(view, ...(review && !wrapup ? [review.bar] : []));
    barSize.disconnect();
    if (review && !wrapup) barSize.observe(review.bar);
    else html.style.removeProperty("--bar-h");
    if (focus) {
      window.scrollTo(0, 0);
      const target =
        focus === "heading"
          ? root.querySelector<HTMLElement>(".view-heading")
          : focus === "menu"
            ? root.querySelector<HTMLElement>(".menu-btn")
            : focus === "file"
              ? root.querySelector<HTMLElement>(".is-target .dv-toggle")
              : // A pending comment: the heading for now; the diff moves focus to the card.
                focus === "comment"
                ? null
                : root.querySelector<HTMLElement>(`.topbar .nav-${focus}:not(.invisible)`);
      (target ?? root.querySelector<HTMLElement>(".view-heading"))?.focus();
      target?.scrollIntoView({ block: "nearest" });
    }
  }

  /**
   * ←/→ and j/k step through the tour and Esc leaves it for the overview, unless focus is somewhere
   * keys mean something else (Esc in a text field belongs to it; an open menu closes first).
   */
  function onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"))
      return;
    if (e.key === "Escape") {
      if (parseView(state.view, count).kind === "overview") return;
      e.preventDefault();
      go("overview");
      return;
    }
    const arrow = e.key === "ArrowLeft" || e.key === "ArrowRight";
    // Arrow keys scroll a diff sideways when it has focus.
    if (arrow && t?.closest(".dv-scroll")) return;
    const forward = e.key === "ArrowRight" || e.key === "j";
    const back = e.key === "ArrowLeft" || e.key === "k";
    if (!forward && !back) return;
    const v = parseView(state.view, count);
    const n = count;
    let to: TourView | null = null;
    if (v.kind === "overview") to = forward && n ? stopView(0) : forward ? "wrapup" : null;
    else if (v.kind === "wrapup") to = back ? (n ? stopView(n - 1) : "overview") : null;
    else if (forward) to = v.index + 1 < n ? stopView(v.index + 1) : "wrapup";
    else to = v.index > 0 ? stopView(v.index - 1) : "overview";
    if (to === null) return;
    e.preventDefault();
    go(to);
  }
  document.addEventListener("keydown", onKey);

  return {
    draw: render,
    setReview: (r) => {
      review = r;
      r.bind({
        finish: () => go("wrapup"),
        // A comment's stop (as for a finding on its line); every changed file is in one.
        jump: (c) => {
          const at = stopForComment(lookup, c);
          go(at !== null ? stopView(at) : "wrapup", "comment", {
            file: c.path,
            line: c.line,
            commentId: c.id,
          });
        },
      });
      render();
    },
    dispose: () => {
      document.removeEventListener("keydown", onKey);
      for (const c of cleanups) c();
      cleanups = [];
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
  const problems = checkGuide(value);
  if (problems.length) {
    current?.dispose();
    current = null;
    renderProblem(text, problems);
    return;
  }
  const older = (value as { schema: string }).schema === SCHEMA_V1;
  const guide = older ? upgradeV1(value as PrGuideV1) : upgradeGuide(value as PrGuide);
  const key = `${guide.pr.repo}#${guide.pr.number}`;
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
const doc = await documentApi.session<string>();
void show(doc.value);
doc.onReplace((value) => void show(value));
