// One file's diff in the guide tab: the focused hunks of a tour stop (with Full file to see the
// rest), or a whole file opened from a file reference. Lines are numbered on both sides and marked
// + / − (never by colour alone). Added and unchanged lines take a comment through the same draft
// the rest of the guide uses: "+" opens the composer under the line, Shift+"+" on a second line
// makes it a range. Findings and pending comments sit under their line, and a line with a pending
// comment carries a marker in its gutter. Diff text goes in as text nodes only.
import {
  diffRows,
  focusPieces,
  gutterDigits,
  rowOfLine,
  type DiffFile,
  type DiffRow,
  type FocusPiece,
} from "../src/diff-model";
import { commentPlace, type DraftComment } from "../src/review";
import type { Finding, LineRange, PrGuide } from "../src/schema";
import { h, prose } from "./dom";
import { more, SEVERITY_LABEL } from "./parts";
import { cardOf, type ComposerState, type Review } from "./review";

/** Rows drawn at first in a whole file; the rest wait for "Show remaining". */
export const RENDER_FIRST = 2_000;

export type DiffViewOptions = {
  guide: PrGuide;
  load: (path: string) => Promise<DiffFile>;
  review: Review | null;
  openInOrca: (path: string) => void;
  /** A tour stop's ranges: the view opens on those hunks only and offers Full file. */
  focus?: readonly LineRange[] | null;
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
};

export type DiffView = {
  el: HTMLElement;
  /** Shows `path`, and with `line` opens the file, scrolls to and highlights that PR-head line. */
  show: (path: string, line?: number | null) => Promise<void>;
  /** The open/close toggle in the header, to put focus on. */
  toggle: HTMLButtonElement;
  dispose: () => void;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const SVG = "http://www.w3.org/2000/svg";
/** The gutter's pending-comment marker: a small speech bubble, decorative (the row says it in words). */
function commentMark(): SVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "c-mark");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute(
    "d",
    "M3 2.5h10A1.5 1.5 0 0 1 14.5 4v6a1.5 1.5 0 0 1-1.5 1.5H8l-3.2 2.4a.5.5 0 0 1-.8-.4v-2H3A1.5 1.5 0 0 1 1.5 10V4A1.5 1.5 0 0 1 3 2.5Z",
  );
  svg.append(path);
  return svg;
}

/** An open composer on a line or a range: the first line pressed is the range's anchor. */
type LineComposer = {
  anchor: number;
  start: number;
  end: number;
  state: ComposerState;
  error: string | null;
  el: HTMLElement;
};

export function createDiffView(opts: DiffViewOptions): DiffView {
  const { guide, review } = opts;
  const focus = opts.focus?.length ? opts.focus : null;

  let current: string | null = null;
  let data: DiffFile | null = null;
  let rows: DiffRow[] = [];
  /** Focused hunks, or the whole file once Full file is on (or when there is no focus). */
  let full = focus === null;
  let pieces: FocusPiece[] = [];
  /** Gaps the reviewer opened, by their first row. */
  const revealed = new Set<number>();
  /** Whole file: rows drawn so far (the rest behind "Show remaining"). */
  let limit = RENDER_FIRST;
  let seq = 0;
  /** PR-head line → its row element, for the rows drawn now. */
  let rowEl = new Map<number, HTMLElement>();
  let lineComposer: LineComposer | null = null;
  let fileComposer: HTMLElement | null = null;
  let focusComment = opts.focusComment ?? null;
  let expanded = opts.expanded ?? true;
  /** A show() made while closed: drawn when the file is opened. */
  let deferred: { line: number | null } | null = null;

  const uid = Math.random().toString(36).slice(2, 8);
  const titleId = `dv-${uid}`;
  const bodyId = `dv-body-${uid}`;
  const pathText = h("span", { class: "dv-path-text" });
  // The path itself is the toggle, with the chevron, so the whole name is a large target.
  const toggle = h(
    "button",
    {
      type: "button",
      class: "dv-toggle",
      "aria-expanded": String(expanded),
      "aria-controls": bodyId,
    },
    h("span", { class: "chev", "aria-hidden": "true" }),
    pathText,
  ) as HTMLButtonElement;
  const title = h("h3", { class: "dv-path", id: titleId }, toggle);
  const meta = h("p", { class: "dv-meta small" });
  /** "2 pending", in the header beside +/−. */
  const pendingMeta = h("span", { class: "pending-meta" });
  const announce = h("p", { class: "sr-only", role: "status" });
  const fullToggle = h(
    "button",
    { type: "button", class: "btn sm", "aria-pressed": "false" },
    "Full file",
  );
  const commentFile = h("button", { type: "button", class: "btn sm" }, "Comment on file");
  const openIn = h("button", { type: "button", class: "btn sm ghost" }, "Open in Orca");
  const fileBox = h("div", { class: "dv-file" });
  const lines = h("div", { class: "dv-rows" });
  const moreBox = h("div", { class: "dv-file" });
  const scroller = h(
    "div",
    { class: "dv-scroll", id: bodyId, tabindex: "0", role: "region", "aria-labelledby": titleId },
    fileBox,
    lines,
    moreBox,
  );

  const actions = h(
    "div",
    { class: "row wrap dv-actions" },
    focus ? fullToggle : null,
    review ? commentFile : null,
    openIn,
  );
  const head = h(
    "header",
    { class: "dv-head" },
    h(
      "div",
      { class: "stack-xs dv-title" },
      h("div", { class: "row wrap dv-name" }, title, meta, ...(opts.tags ?? [])),
      ...(opts.lead ?? []),
    ),
    actions,
    announce,
  );
  const el = h(
    "section",
    { class: `diff-view ${opts.variant ?? "card"}`, "aria-labelledby": titleId },
    head,
    scroller,
  );

  function setExpanded(on: boolean, tell = true): void {
    if (on === expanded) return;
    expanded = on;
    drawExpanded();
    if (tell) opts.onToggle?.(on);
    if (on && deferred && current !== null) {
      const { line } = deferred;
      const path = current;
      deferred = null;
      current = null;
      void show(path, line);
    }
  }

  function drawExpanded(): void {
    toggle.setAttribute("aria-expanded", String(expanded));
    // The name stays the path; aria-expanded says open or closed. The tooltip says what a press does.
    toggle.title = expanded ? "Collapse this file" : "Expand this file";
    scroller.hidden = !expanded;
    el.classList.toggle("collapsed", !expanded);
  }
  drawExpanded();

  toggle.addEventListener("click", () => setExpanded(!expanded));
  openIn.addEventListener("click", () => current && opts.openInOrca(current));
  openIn.setAttribute("aria-label", "Open this file in Orca");
  fullToggle.addEventListener("click", () => {
    // On a closed file, Full file opens it showing everything.
    const wasOpen = expanded;
    setExpanded(true);
    setFull(wasOpen ? !full : true);
    fullToggle.focus();
  });
  commentFile.setAttribute("aria-expanded", "false");
  commentFile.addEventListener("click", () => {
    if (!review || current === null) return;
    setExpanded(true);
    if (!fileComposer) {
      fileComposer = review.composer({
        path: current,
        span: null,
        state: { typed: "" },
        onClose: (added) => {
          fileComposer = null;
          commentFile.setAttribute("aria-expanded", "false");
          drawNotes();
          (added ? cardOf(added.id) : commentFile)?.focus();
        },
      });
    }
    commentFile.setAttribute("aria-expanded", "true");
    drawNotes();
    fileComposer.querySelector("textarea")?.focus();
  });

  const plusOf = (line: number) =>
    rowEl.get(line)?.querySelector<HTMLButtonElement>("button.plus") ?? null;

  /**
   * "+" on a line opens the composer under it. With Shift, and a composer already open, it makes
   * the composer a range from the first line pressed to this one (in either direction), if GitHub
   * would take it: both lines in the same hunk. Typed text carries over.
   */
  function openLine(line: number, extend: boolean): void {
    if (!review || current === null) return;
    const path = current;
    const prior = lineComposer;
    let next: Omit<LineComposer, "el">;
    if (extend && prior && prior.anchor !== line) {
      const start = Math.min(prior.anchor, line);
      const end = Math.max(prior.anchor, line);
      const problem = review.rangeProblem(path, start, end);
      next = problem
        ? { ...prior, error: problem }
        : { anchor: prior.anchor, start, end, state: prior.state, error: null };
      announce.textContent = problem ?? `Lines ${start} to ${end} selected`;
    } else {
      next = {
        anchor: line,
        start: line,
        end: line,
        state: prior?.state ?? { typed: "" },
        error: null,
      };
    }
    const made: LineComposer = {
      ...next,
      el: review.composer({
        path,
        span: { start: next.start, end: next.end },
        state: next.state,
        error: next.error,
        onClose: (added) => {
          lineComposer = null;
          drawNotes();
          (added ? cardOf(added.id) : plusOf(next.end))?.focus();
        },
      }),
    };
    lineComposer = made;
    drawNotes();
    made.el.querySelector("textarea")?.focus();
  }

  // One listener for every line's comment button and gap, rather than one per row.
  lines.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const gap = target.closest("button.gap");
    if (gap) {
      revealed.add(Number(gap.getAttribute("data-from")));
      drawBody();
      drawNotes();
      scroller.focus();
      announce.textContent = "Lines shown";
      return;
    }
    const button = target.closest("button.plus");
    const line = Number(button?.closest(".dl")?.getAttribute("data-line"));
    if (!button || !line) return;
    openLine(line, e.shiftKey);
  });
  // Shift+Enter on a focused "+" is the keyboard's Shift+click.
  lines.addEventListener("keydown", (e) => {
    const button = (e.target as HTMLElement).closest("button.plus");
    if (!button || e.key !== "Enter" || !e.shiftKey) return;
    e.preventDefault();
    const line = Number(button.closest(".dl")?.getAttribute("data-line"));
    if (line) openLine(line, true);
  });

  const unsubscribe = review?.onChange(() => drawNotes()) ?? (() => {});

  // ------------------------------------------------------------ drawing rows

  function rowNode(r: DiffRow): HTMLElement {
    if (r.kind === "hunk")
      return h(
        "div",
        { class: "dl hunk" },
        h("span", { class: "gut" }),
        h("span", { class: "code" }, r.text),
      );
    if (r.kind === "eof")
      return h(
        "div",
        { class: "dl eof" },
        h("span", { class: "gut" }),
        h("span", { class: "code" }, `↳ ${r.text}`),
      );
    const commentable =
      review !== null && r.new !== null && current !== null && review.canComment(current, r.new);
    // The slot holds the "+" and, under it, the pending-comment marker drawNotes adds.
    const row = h(
      "div",
      { class: `dl k-${r.kind}`, ...(r.new !== null ? { "data-line": String(r.new) } : {}) },
      h(
        "span",
        { class: "gut" },
        h("span", { class: "ln" }, r.old === null ? "" : String(r.old)),
        h("span", { class: "ln" }, r.new === null ? "" : String(r.new)),
        commentable
          ? h(
              "span",
              { class: "slot" },
              h(
                "button",
                {
                  type: "button",
                  class: "plus",
                  "aria-label": `Comment on line ${r.new}`,
                  "aria-keyshortcuts": "Shift+Enter",
                  title: "Comment on this line · Shift+click another line for a range",
                },
                "+",
              ),
            )
          : h("span", { class: "plus-space" }),
        h("span", { class: "sign" }, r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "),
      ),
      h("span", { class: "code" }, r.text),
    );
    if (r.new !== null) rowEl.set(r.new, row);
    return row;
  }

  function gapNode(p: Extract<FocusPiece, { kind: "gap" }>): HTMLElement {
    const hidden = rows.slice(p.from, p.to);
    const unchanged = hidden.every(
      (r) => r.kind === "ctx" || r.kind === "hunk" || r.kind === "eof",
    );
    const numbered = hidden.filter((r) => r.kind !== "hunk" && r.kind !== "eof") as Extract<
      DiffRow,
      { kind: "add" | "del" | "ctx" }
    >[];
    const first = numbered.find((r) => r.new !== null)?.new;
    const last = [...numbered].reverse().find((r) => r.new !== null)?.new;
    const label = `${plural(p.lines, unchanged ? "unchanged line" : "other line")}`;
    return h(
      "div",
      { class: "dl gap-row" },
      h(
        "button",
        {
          type: "button",
          class: "gap",
          "data-from": String(p.from),
          "aria-expanded": "false",
          "aria-label": `Show ${label}${first && last ? `, lines ${first} to ${last}` : ""}`,
        },
        h("span", { "aria-hidden": "true" }, "⋯"),
        ` ${label}`,
      ),
    );
  }

  /** What is on screen now, as row runs; gaps the reviewer opened count as shown. */
  function visiblePieces(): FocusPiece[] {
    if (full)
      return rows.length ? [{ kind: "show", from: 0, to: Math.min(rows.length, limit) }] : [];
    return pieces.map((p) =>
      p.kind === "gap" && revealed.has(p.from) ? { kind: "show", from: p.from, to: p.to } : p,
    );
  }

  function drawBody(): void {
    rowEl = new Map();
    const frag = document.createDocumentFragment();
    for (const p of visiblePieces()) {
      if (p.kind === "gap") frag.append(gapNode(p));
      else for (let i = p.from; i < p.to; i++) frag.append(rowNode(rows[i]));
    }
    lines.replaceChildren(frag);
    moreBox.replaceChildren();
    if (full && limit < rows.length) {
      const rest = rows.length - limit;
      const button = h(
        "button",
        { type: "button", class: "btn sm" },
        `Show remaining ${plural(rest, "line")}`,
      );
      button.addEventListener("click", () => {
        limit = rows.length;
        drawBody();
        drawNotes();
        scroller.focus();
      });
      moreBox.append(button);
    }
  }

  function setFull(on: boolean, line: number | null = null): void {
    full = on || focus === null;
    fullToggle.setAttribute("aria-pressed", String(full));
    if (full && line !== null) limit = Math.max(limit, rowOfLine(rows, line) + 1);
    drawBody();
    drawNotes();
    announce.textContent = full ? "Showing the whole file" : "Showing the stop’s lines only";
  }

  // ------------------------------------------------------------ findings and comments

  function findingCard(f: Finding): HTMLElement {
    return h(
      "div",
      { class: `finding-card ${f.severity}` },
      h(
        "div",
        { class: "row wrap" },
        h("span", { class: `tag sev ${f.severity}` }, `⚑ ${SEVERITY_LABEL[f.severity]}`),
        h("p", { class: "headline" }, prose(f.headline)),
      ),
      more(f.detail),
      review?.finding(f) ?? null,
    );
  }

  function notice(text: string): HTMLElement {
    return h("p", { class: "dv-notice small" }, text);
  }

  /** A link that opens the whole file at `line`, for an item the stop's hunks do not show. */
  function showLine(line: number): HTMLElement {
    const b = h("button", { type: "button", class: "btn sm ghost" }, `Show line ${line}`);
    b.addEventListener("click", () => {
      setFull(true, line);
      highlight(line);
    });
    return b;
  }

  /** Findings, pending comments and open composers, each under its line (or the file). */
  function drawNotes(): void {
    if (current === null || !data) return;
    const path = current;
    lines.querySelectorAll(":scope > .annot").forEach((old) => old.remove());
    const findings = guide.findings.filter((f) => f.file === path);
    const comments: DraftComment[] = review ? review.comments(path) : [];
    const byLine = new Map<number, Node[]>();
    const top: Node[] = [];
    /** Items whose line exists in the file's diff but is not drawn now. */
    const elsewhere: Node[] = [];
    const inDiff = (line: number) => rowOfLine(rows, line) !== -1;
    const place = (line: number | null, node: Node, summary: () => Node) => {
      if (line === null) top.push(node);
      else if (rowEl.has(line)) byLine.set(line, [...(byLine.get(line) ?? []), node]);
      else if (inDiff(line)) elsewhere.push(h("li", {}, summary(), showLine(line)));
      else top.push(h("p", { class: "muted small" }, `Line ${line} is not in this diff.`), node);
    };
    for (const f of findings)
      place(f.line, findingCard(f), () =>
        h(
          "span",
          { class: "row wrap" },
          h("span", { class: `tag sev ${f.severity}` }, `⚑ ${SEVERITY_LABEL[f.severity]}`),
          h("span", {}, prose(f.headline)),
        ),
      );
    for (const c of comments)
      if (review)
        place(
          c.line,
          review.commentCard(c, () => (c.line !== null ? plusOf(c.line) : toggle)?.focus()),
          () => h("span", { class: "muted" }, `Your pending comment on ${commentPlace(c)}`),
        );
    if (lineComposer) place(lineComposer.end, lineComposer.el, () => h("span", {}, "Your comment"));
    drawMarks(comments);

    for (const [line, nodes] of byLine) {
      const row = rowEl.get(line) as HTMLElement;
      row.after(h("div", { class: "annot" }, ...nodes));
    }

    const notes: Node[] = [];
    if (data.binary) notes.push(notice("Binary file: there is no text diff to show."));
    else if (!data.lines.length)
      notes.push(
        notice(
          data.status === "renamed" && data.oldPath
            ? `Renamed from ${data.oldPath}, with no line changes.`
            : data.status === "added"
              ? "New empty file."
              : "No line changes in this file at the guide’s commit.",
        ),
      );
    else if (data.status === "renamed" && data.oldPath)
      notes.push(notice(`Renamed from ${data.oldPath}.`));
    if (data.truncated)
      notes.push(
        notice(
          `Showing the first ${plural(data.lines.length, "line")} of ${data.totalLines}: the rest is too long for the guide tab. Open in Orca to see the whole file.`,
        ),
      );
    if (fileComposer) top.push(fileComposer);
    fileBox.replaceChildren(...notes, ...top);
    const also: Node[] = [];
    if (elsewhere.length)
      also.push(
        h(
          "div",
          { class: "also" },
          h("p", { class: "eyebrow" }, full ? "Further down" : "Also in this file"),
          h("ul", { class: "also-list" }, ...elsewhere),
        ),
      );
    // "Show remaining" stays last.
    moreBox.querySelectorAll(":scope > .also").forEach((old) => old.remove());
    moreBox.prepend(...also);
  }

  /**
   * Gutter markers for lines with a pending comment (the marker is decorative; the "+" and a hidden
   * note say it in words), a tint over every line a range comment or the open composer covers,
   * and the header's pending count.
   */
  function drawMarks(comments: readonly DraftComment[]): void {
    lines.querySelectorAll(".dl.in-range").forEach((r) => r.classList.remove("in-range"));
    lines.querySelectorAll(".dl.has-comment").forEach((r) => {
      r.classList.remove("has-comment");
      r.querySelectorAll(".c-mark, .c-note").forEach((m) => m.remove());
      const plus = r.querySelector("button.plus");
      plus?.setAttribute("aria-label", `Comment on line ${r.getAttribute("data-line")}`);
    });
    const tint = (from: number, to: number) => {
      for (let n = from; n <= to; n++) rowEl.get(n)?.classList.add("in-range");
    };
    for (const c of comments) {
      if (c.line === null) continue;
      if (c.startLine !== undefined) tint(c.startLine, c.line);
      const row = rowEl.get(c.line);
      if (!row || row.classList.contains("has-comment")) continue;
      row.classList.add("has-comment");
      row.querySelector(".slot")?.prepend(commentMark());
      row
        .querySelector(".gut")
        ?.append(h("span", { class: "sr-only c-note" }, "Has a pending comment"));
      row
        .querySelector("button.plus")
        ?.setAttribute("aria-label", `Comment on line ${c.line} (has a pending comment)`);
    }
    if (lineComposer) tint(lineComposer.start, lineComposer.end);
    pendingMeta.textContent = comments.length ? `${comments.length} pending` : "";
  }

  // ------------------------------------------------------------ showing a file

  function header(path: string): void {
    pathText.textContent = path;
    drawExpanded();
    meta.replaceChildren(
      ...(data
        ? [
            h("span", { class: "add mono" }, `+${data.additions}`),
            " ",
            h("span", { class: "del mono" }, `−${data.deletions}`),
          ]
        : []),
      pendingMeta,
    );
  }

  /**
   * Draws a line the stop hides: the gap holding it opens (keeping the stop's focus), or on a file
   * without gaps there, the whole file.
   */
  function reveal(line: number): void {
    const at = rowOfLine(rows, line);
    if (at === -1 || rowEl.has(line)) return;
    const gap = full
      ? undefined
      : pieces.find((p) => p.kind === "gap" && at >= p.from && at < p.to);
    if (gap) {
      revealed.add(gap.from);
      drawBody();
      drawNotes();
    } else setFull(true, line);
  }

  /** Puts focus on the pending comment the review bar asked for, once it is drawn. */
  function landOnComment(): void {
    if (!focusComment) return;
    const card = cardOf(focusComment);
    focusComment = null;
    if (!card) return;
    card.focus({ preventScroll: true });
    card.scrollIntoView({ block: "center" });
  }

  function highlight(line: number | null): void {
    lines.querySelectorAll(".dl.target").forEach((old) => old.classList.remove("target"));
    if (line === null) return;
    const row = rowEl.get(line);
    if (!row) {
      announce.textContent = `Line ${line} is not in this diff`;
      return;
    }
    row.classList.add("target");
    row.scrollIntoView({ block: "center" });
    announce.textContent = `Line ${line}`;
  }

  async function show(path: string, line: number | null = null): Promise<void> {
    // Going to a line means seeing it: open the file first (this call does the loading).
    if (line !== null && !expanded) {
      deferred = null;
      setExpanded(true);
    }
    if (path === current && data) {
      if (line !== null) reveal(line);
      highlight(line);
      landOnComment();
      return;
    }
    const run = ++seq;
    current = path;
    data = null;
    rows = [];
    pieces = [];
    revealed.clear();
    limit = RENDER_FIRST;
    rowEl = new Map();
    lineComposer = null;
    fileComposer = null;
    lines.replaceChildren();
    moreBox.replaceChildren();
    header(path);
    if (!expanded) {
      // Closed: nothing to draw yet, so nothing to load.
      deferred = { line };
      fileBox.replaceChildren();
      return;
    }
    fileBox.replaceChildren(notice("Loading the diff…"));
    let loaded: DiffFile;
    try {
      loaded = await opts.load(path);
    } catch (e) {
      if (run !== seq) return;
      const retry = h("button", { type: "button", class: "btn sm" }, "Try again");
      retry.addEventListener("click", () => {
        current = null;
        void show(path, line);
      });
      fileBox.replaceChildren(
        h(
          "p",
          { class: "field-error small", role: "alert" },
          `Couldn’t load the diff: ${message(e)}`,
        ),
        retry,
      );
      return;
    }
    if (run !== seq) return;
    data = loaded;
    rows = diffRows(loaded.lines);
    const focused = focusPieces(rows, focus);
    pieces = focused.pieces;
    // Ranges that land on no row (the file changed under the guide) show the whole file.
    if (!focused.focused) {
      full = true;
      fullToggle.remove();
    }
    // Line numbers share one width so the code column lines up down the file.
    el.style.setProperty("--ln", `${gutterDigits(rows) + 1}ch`);
    header(path);
    if (line !== null && full) limit = Math.max(limit, rowOfLine(rows, line) + 1);
    drawBody();
    drawNotes();
    if (line !== null) reveal(line);
    highlight(line);
    landOnComment();
  }

  return {
    el,
    show: (path, line) => show(path, line ?? null),
    toggle,
    dispose: () => {
      seq++;
      unsubscribe();
    },
  };
}
