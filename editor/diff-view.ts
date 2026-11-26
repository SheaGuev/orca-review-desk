// One file's diff in the guide tab: the focused hunks of a tour stop (with Full file to see the
// rest), or a whole file opened from a file reference. Lines are numbered on both sides and marked
// + / − (never by colour alone). Added and unchanged lines take a comment through the same draft
// the rest of the guide uses: "+" opens the composer under the line, Shift+"+" on a second line
// makes it a range. Findings and pending comments sit under their line, and a line with a pending
// comment carries a marker in its gutter. Diff text goes in as text nodes only.
import { diffRows, focusPieces, gutterDigits, rowOfLine, type DiffFile } from "../src/diff-model";
import { message } from "../src/errors";
import type { LineRange, PrGuide } from "../src/schema";
import { openFileComposer, wireRows } from "./diff-composers";
import {
  arriveAt,
  drawBody,
  drawHeader,
  drawNotes,
  RENDER_FIRST,
  setFull,
  type View,
} from "./diff-draw";
import { buildFrame } from "./diff-frame";
import { notice } from "./diff-rows";
import { h } from "./dom";
import { tokensFor, type RowTokens } from "./highlight";
import type { Review } from "./review";
import type { Viewed } from "./viewed";

export type DiffViewOptions = {
  guide: PrGuide;
  load: (path: string) => Promise<DiffFile>;
  review: Review | null;
  openInOrca: (path: string) => void;
  /** Opens what an import in the file shown points to; without it, imports are plain text. */
  openImport?: (from: string, specifier: string) => void;
  /** A tour stop's ranges: the view opens on those hunks only and offers Full file. */
  focus?: readonly LineRange[] | null;
  /** Lines to mark in the gutter (a group's focus) without hiding the other hunks. */
  marks?: readonly LineRange[] | null;
  /**
   * Whether the diff starts open. The path in the header is a toggle either way; a view that starts
   * closed loads its diff only when it is first opened.
   */
  expanded?: boolean;
  /** Told when the reviewer opens or closes the file (a stop remembers it). */
  onToggle?: (expanded: boolean) => void;
  /** "listed": one of a list of files (no card header, actions only while open). */
  variant?: "card" | "listed";
  /** Shown under the path in the header: a file's note, tags, what changed since a review. */
  lead?: (Node | null)[];
  /** Shown beside the path, after +/−: short tags such as why a file was skipped. */
  tags?: Node[];
  /** A pending comment to scroll to and focus once the diff is drawn (the review bar's ‹ ›). */
  focusComment?: string | null;
  /** GitHub's Viewed state; leave out for no Viewed checkbox. */
  viewed?: Viewed | null;
};

export type DiffView = {
  el: HTMLElement;
  /** Shows `path`, and with `line` opens the file, scrolls to and highlights that PR-head line. */
  show: (path: string, line?: number | null) => Promise<void>;
  /** The open/close toggle in the header, to put focus on. */
  toggle: HTMLButtonElement;
  dispose: () => void;
};

/** The view with nothing shown yet. */
function emptyView(opts: DiffViewOptions): View {
  const focus = opts.focus?.length ? opts.focus : null;
  return {
    guide: opts.guide,
    review: opts.review,
    focus,
    marks: opts.marks?.length ? opts.marks : null,
    frame: buildFrame({
      variant: opts.variant ?? "card",
      expanded: opts.expanded ?? true,
      focused: focus !== null,
      reviewing: opts.review !== null,
      viewed: Boolean(opts.viewed),
      lead: opts.lead ?? [],
      tags: opts.tags ?? [],
    }),
    current: null,
    data: null,
    rows: [],
    tokens: new Map(),
    full: focus === null,
    pieces: [],
    revealed: new Set(),
    limit: RENDER_FIRST,
    rowEl: new Map(),
    lineComposer: null,
    fileComposer: null,
    focusComment: opts.focusComment ?? null,
    linkImports: opts.openImport !== undefined,
    findingOpen: new Map(),
  };
}

/** Forgets the file shown, ready for `path`. */
function reset(v: View, path: string): void {
  v.current = path;
  v.data = null;
  v.rows = [];
  v.tokens = new Map();
  v.pieces = [];
  v.revealed.clear();
  v.limit = RENDER_FIRST;
  v.rowEl = new Map();
  v.lineComposer = null;
  v.fileComposer = null;
  v.frame.lines.replaceChildren();
  v.frame.moreBox.replaceChildren();
}

/** How long a loaded diff waits for its colours before it is drawn plain and coloured after. */
const HIGHLIGHT_WAIT_MS = 250;

/** Colours `loaded` once they arrive late, unless the view moved on or a composer is open. */
async function colourLate(v: View, loaded: DiffFile, tokens: Promise<RowTokens>): Promise<void> {
  const t = await tokens;
  if (v.data !== loaded || !t.size || v.tokens.size) return;
  if (v.lineComposer || v.fileComposer) return;
  v.tokens = t;
  drawBody(v);
  drawNotes(v);
}

/** Takes the loaded diff into the view and draws it, opened far enough to include `line`. */
function drawLoaded(
  v: View,
  path: string,
  loaded: DiffFile,
  line: number | null,
  tokens: RowTokens | null,
): void {
  v.data = loaded;
  v.rows = diffRows(loaded.lines);
  v.tokens = tokens ?? new Map();
  const focused = focusPieces(v.rows, v.focus);
  v.pieces = focused.pieces;
  // Ranges that land on no row (the file changed under the guide) show the whole file.
  if (!focused.focused) {
    v.full = true;
    v.frame.fullToggle.remove();
  }
  // Line numbers share one width so the code column lines up down the file.
  v.frame.el.style.setProperty("--ln", `${gutterDigits(v.rows) + 1}ch`);
  drawHeader(v, path);
  if (line !== null && v.full) v.limit = Math.max(v.limit, rowOfLine(v.rows, line) + 1);
  drawBody(v);
  drawNotes(v);
  arriveAt(v, line);
}

/** A view with how it is shown: open or closed, and which load is the current one. */
type Shown = {
  v: View;
  opts: DiffViewOptions;
  expanded: boolean;
  /** A show() made while closed: drawn when the file is opened. */
  deferred: { line: number | null } | null;
  /** Each show() supersedes the last, so a slow load never draws over a newer file. */
  seq: number;
};

function drawExpanded(c: Shown): void {
  const { el, toggle, scroller } = c.v.frame;
  toggle.setAttribute("aria-expanded", String(c.expanded));
  // The name stays the path; aria-expanded says open or closed. The tooltip says what a press does.
  toggle.title = c.expanded ? "Collapse this file" : "Expand this file";
  scroller.hidden = !c.expanded;
  el.classList.toggle("collapsed", !c.expanded);
}

function setExpanded(c: Shown, on: boolean): void {
  if (on === c.expanded) return;
  c.expanded = on;
  drawExpanded(c);
  c.opts.onToggle?.(on);
  if (!on || !c.deferred || c.v.current === null) return;
  const { line } = c.deferred;
  const path = c.v.current;
  c.deferred = null;
  c.v.current = null;
  void show(c, path, line);
}

function showFailure(c: Shown, path: string, line: number | null, e: unknown): void {
  const retry = h("button", { type: "button", class: "btn sm" }, "Try again");
  retry.addEventListener("click", () => {
    c.v.current = null;
    void show(c, path, line);
  });
  c.v.frame.fileBox.replaceChildren(
    h("p", { class: "field-error small", role: "alert" }, `Couldn’t load the diff: ${message(e)}`),
    retry,
  );
}

/** Shows `path`, and with `line` opens the file, scrolls to and highlights that PR-head line. */
async function show(c: Shown, path: string, line: number | null): Promise<void> {
  const { v } = c;
  const { fileBox } = v.frame;
  // Going to a line means seeing it: open the file first (this call does the loading).
  if (line !== null && !c.expanded) {
    c.deferred = null;
    setExpanded(c, true);
  }
  if (path === v.current && v.data) {
    arriveAt(v, line);
    return;
  }
  const run = ++c.seq;
  reset(v, path);
  drawHeader(v, path);
  drawViewed(c);
  drawExpanded(c);
  if (!c.expanded) {
    // Closed: nothing to draw yet, so nothing to load.
    c.deferred = { line };
    fileBox.replaceChildren();
    return;
  }
  fileBox.replaceChildren(notice("Loading the diff…"));
  const loaded = await c.opts.load(path).catch((e: unknown) => ({ failed: e }));
  if (run !== c.seq) return;
  if ("failed" in loaded) {
    showFailure(c, path, line, loaded.failed);
    return;
  }
  const colours = tokensFor(loaded);
  const timeout = new Promise<null>((done) => setTimeout(() => done(null), HIGHLIGHT_WAIT_MS));
  const tokens = await Promise.race([colours, timeout]);
  if (run !== c.seq) return;
  drawLoaded(v, path, loaded, line, tokens);
  if (tokens === null) void colourLate(v, loaded, colours);
}

/** The Viewed checkbox as GitHub has it for the file shown; disabled until that is known. */
function drawViewed(c: Shown): void {
  const box = c.v.frame.viewedBox;
  const state = c.v.current === null ? null : (c.opts.viewed?.has(c.v.current) ?? null);
  if (!box) return;
  box.checked = state === true;
  box.disabled = state === null;
}

/** Ticking Viewed closes the file, as on GitHub; unticking leaves it as it is. */
function wireViewed(c: Shown): (() => void) | undefined {
  const { viewedBox } = c.v.frame;
  const viewed = c.opts.viewed;
  if (!viewedBox || !viewed) return undefined;
  viewedBox.addEventListener("change", () => {
    if (c.v.current === null) return;
    viewed.set(c.v.current, viewedBox.checked);
    if (viewedBox.checked) setExpanded(c, false);
  });
  return viewed.onChange(() => drawViewed(c));
}

/** The header's toggle and actions, and the rows' comment buttons. */
function wire(c: Shown): void {
  const { v } = c;
  const { toggle, fullToggle, commentFile, openIn } = v.frame;
  toggle.addEventListener("click", () => setExpanded(c, !c.expanded));
  openIn.addEventListener("click", () => v.current && c.opts.openInOrca(v.current));
  fullToggle.addEventListener("click", () => {
    // On a closed file, Full file opens it showing everything.
    const wasOpen = c.expanded;
    setExpanded(c, true);
    setFull(v, wasOpen ? !v.full : true);
    fullToggle.focus();
  });
  commentFile.addEventListener("click", () => {
    if (!v.review || v.current === null) return;
    setExpanded(c, true);
    openFileComposer(v);
  });
  wireRows(v);
  wireImports(c);
}

/** A press on an import specifier opens it; a drag that selected text is left as a selection. */
function wireImports(c: Shown): void {
  const { openImport } = c.opts;
  if (!openImport) return;
  c.v.frame.lines.addEventListener("click", (e) => {
    const link = e.target instanceof Element ? e.target.closest<HTMLElement>(".imp") : null;
    const specifier = link?.dataset.import;
    if (!specifier || c.v.current === null) return;
    if (window.getSelection()?.toString()) return;
    openImport(c.v.current, specifier);
  });
}

export function createDiffView(opts: DiffViewOptions): DiffView {
  const v = emptyView(opts);
  const c: Shown = { v, opts, expanded: opts.expanded ?? true, deferred: null, seq: 0 };
  drawExpanded(c);
  wire(c);
  const unsubscribe = v.review?.onChange(() => drawNotes(v));
  const unsubscribeViewed = wireViewed(c);
  return {
    el: v.frame.el,
    show: (path, line) => show(c, path, line ?? null),
    toggle: v.frame.toggle,
    dispose: () => {
      c.seq++;
      unsubscribe?.();
      unsubscribeViewed?.();
    },
  };
}
