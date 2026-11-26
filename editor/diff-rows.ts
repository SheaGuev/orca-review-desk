// The pieces a diff view is drawn from: one row per diff line, the "⋯ 12 unchanged lines" gap, a
// finding's card, the notes above a file, and the gutter marks for pending comments. Each takes
// what it draws and returns nodes; editor/diff-view.ts keeps the state. Diff text goes in as text
// nodes only.
import {
  wordChanges,
  type DiffFile,
  type DiffRow,
  type FocusPiece,
  type Span,
} from "../src/diff-model";
import type { DraftComment } from "../src/review";
import type { Finding } from "../src/schema";
import { h, prose } from "./dom";
import type { RowTokens, Tok } from "./highlight";
import { importSpans, type ImportSpan } from "./imports";
import { paragraphs, plural, SEVERITY_LABEL } from "./parts";
import type { Review } from "./review";

const SVG = "http://www.w3.org/2000/svg";
const SIGN = { add: "+", del: "−", ctx: " " } as const;

/** A row with line numbers: an added, removed or unchanged line. */
type LineRow = Extract<DiffRow, { kind: "add" | "del" | "ctx" }>;

const isLineRow = (r: DiffRow): r is LineRow => r.kind !== "hunk" && r.kind !== "eof";

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

/** The "+" that opens a composer under PR-head line `line`. */
const plusButton = (line: number): HTMLElement =>
  h(
    "span",
    { class: "slot" },
    h(
      "button",
      {
        type: "button",
        class: "plus",
        "aria-label": `Comment on line ${line}`,
        "aria-keyshortcuts": "Shift+Enter",
        title: "Comment on this line · Shift+click another line for a range",
      },
      "+",
    ),
  );

/** A run of code text, coloured per code theme through CSS variables the stylesheet picks from. */
function tokNode(text: string, tok: Tok | undefined): string | HTMLElement {
  if (!tok) return text;
  const el = h("span", { class: "tok" }, text);
  for (const [id, s] of Object.entries(tok.styles)) {
    if (s.color) el.style.setProperty(`--tc-${id}`, s.color);
    if (s.italic) el.style.setProperty(`--ti-${id}`, "italic");
    if (s.bold) el.style.setProperty(`--tb-${id}`, "600");
  }
  return el;
}

/** A piece of an import's specifier: a quiet link the diff view's click handler opens. */
const importLink = (piece: string | HTMLElement, link: ImportSpan): HTMLElement =>
  h(
    "span",
    { class: "imp", "data-import": link.specifier, title: `Open ${link.specifier}` },
    piece,
  );

/** What a row's text is drawn with: colour runs, changed words and import specifiers. */
type Overlays = {
  marks?: readonly Span[];
  toks?: readonly Tok[];
  links?: readonly ImportSpan[];
};

/**
 * A line's text in its syntax colours, with its changed words wrapped so they stand out and its
 * import specifiers as links (still text nodes only). The text is cut wherever any of them starts
 * or ends.
 */
function codeText(text: string, { marks, toks, links }: Overlays): (string | HTMLElement)[] {
  if (!marks?.length && !toks?.length && !links?.length) return [text];
  const cuts = new Set([0, text.length]);
  for (const [start, end] of marks ?? []) cuts.add(start).add(end);
  for (const t of toks ?? []) cuts.add(t.start).add(t.end);
  for (const l of links ?? []) cuts.add(l.start).add(l.end);
  const at = [...cuts].filter((c) => c <= text.length).sort((a, b) => a - b);
  const parts: (string | HTMLElement)[] = [];
  for (let k = 0; k + 1 < at.length; k++) {
    const [from = 0, to = 0] = [at[k], at[k + 1]];
    const piece = tokNode(
      text.slice(from, to),
      toks?.find((t) => t.start <= from && to <= t.end),
    );
    const marked = marks?.some(([start, end]) => start <= from && to <= end);
    const inWord = marked ? h("span", { class: "word" }, piece) : piece;
    const link = links?.find((l) => l.start <= from && to <= l.end);
    parts.push(link ? importLink(inWord, link) : inWord);
  }
  return parts;
}

/**
 * One row of the diff. `canComment` says whether GitHub takes a comment on a PR-head line; such
 * a row gets a "+", in a slot that also holds the pending-comment marker `drawMarks` adds.
 */
export function rowNode(
  r: DiffRow,
  canComment: (line: number) => boolean,
  overlays: Overlays = {},
): HTMLElement {
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
  return h(
    "div",
    { class: `dl k-${r.kind}`, ...(r.new === null ? {} : { "data-line": String(r.new) }) },
    h(
      "span",
      { class: "gut" },
      h("span", { class: "ln" }, r.old === null ? "" : String(r.old)),
      h("span", { class: "ln" }, r.new === null ? "" : String(r.new)),
      r.new !== null && canComment(r.new) ? plusButton(r.new) : h("span", { class: "plus-space" }),
      h("span", { class: "sign" }, SIGN[r.kind]),
    ),
    h("span", { class: "code" }, ...codeText(r.text, overlays)),
  );
}

/** The button standing in for the rows a stop's focus hides; `hidden` are those rows. */
export function gapNode(
  p: Extract<FocusPiece, { kind: "gap" }>,
  hidden: readonly DiffRow[],
): HTMLElement {
  const unchanged = hidden.every((r) => r.kind === "ctx" || r.kind === "hunk" || r.kind === "eof");
  const numbered = hidden.filter(isLineRow).flatMap((r) => (r.new === null ? [] : [r.new]));
  const first = numbered.at(0);
  const last = numbered.at(-1);
  const label = plural(p.lines, unchanged ? "unchanged line" : "other line");
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

export const notice = (text: string): HTMLElement => h("p", { class: "dv-notice small" }, text);

/** A finding's severity and headline on one line, as its card and its "Also in this file" entry show it. */
export const findingHead = (f: Finding): HTMLElement[] => [
  h("span", { class: `tag sev ${f.severity}` }, `⚑ ${SEVERITY_LABEL[f.severity]}`),
  h("span", { class: "finding-headline" }, prose(f.headline)),
];

/** What the folded line says became of the suggested comment; one in the review has no card. */
const FINDING_NOTE = { open: "", added: "", dismissed: "Dismissed" } as const;

/**
 * A finding under its line, as a card that folds to its first line: severity, headline and what
 * became of its suggested comment. Open, it adds the detail and the suggested comment.
 */
export function findingCard(
  f: Finding,
  review: Review | null,
  o: { state: keyof typeof FINDING_NOTE; open: boolean; onToggle: (open: boolean) => void },
): HTMLElement {
  const note = FINDING_NOTE[o.state];
  const summary = h(
    "summary",
    {},
    ...findingHead(f),
    note ? h("span", { class: `small finding-state ${o.state}` }, note) : null,
  );
  const card = h(
    "details",
    { class: `finding-card ${f.severity}`, ...(o.open ? { open: "" } : {}) },
    summary,
    f.detail.trim() ? h("div", { class: "detail" }, ...paragraphs(f.detail)) : null,
    review?.finding(f) ?? null,
  );
  // A click, not the toggle event: only the reviewer's own choice is remembered.
  summary.addEventListener("click", () => o.onToggle(!card.open));
  return card;
}

/** Why a file with no lines has none, in words. */
function emptyReason(data: DiffFile): string {
  if (data.status === "renamed" && data.oldPath)
    return `Renamed from ${data.oldPath}, with no line changes.`;
  if (data.status === "added") return "New empty file.";
  return "No line changes in this file at the guide’s commit.";
}

/** What a reviewer should know before reading the rows: binary, renamed, empty, cut short. */
export function fileNotes(data: DiffFile): HTMLElement[] {
  const notes: HTMLElement[] = [];
  if (data.binary) notes.push(notice("Binary file: there is no text diff to show."));
  else if (!data.lines.length) notes.push(notice(emptyReason(data)));
  else if (data.status === "renamed" && data.oldPath)
    notes.push(notice(`Renamed from ${data.oldPath}.`));
  if (data.truncated)
    notes.push(
      notice(
        `Showing the first ${plural(data.lines.length, "line")} of ${data.totalLines}: the rest is too long for the guide tab. Open in Orca to see the whole file.`,
      ),
    );
  return notes;
}

/**
 * Gutter markers for lines with a pending comment (the marker is decorative; the "+" and a hidden
 * note say it in words), and a tint over every line a range comment or the open composer
 * (`composing`) covers. `rowEl` maps a PR-head line to its row among those drawn in `lines`.
 */
export function drawMarks(
  lines: HTMLElement,
  rowEl: ReadonlyMap<number, HTMLElement>,
  comments: readonly DraftComment[],
  composing: { start: number; end: number } | null,
): void {
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
  if (composing) tint(composing.start, composing.end);
}

/**
 * The rows of `pieces` as nodes, gaps as their buttons, and each drawn PR-head line's row, for
 * putting notes under lines and marking them.
 */
/** Word marks per rows array: a view redraws its rows often (comments, gaps), the marks don't change. */
const wordCache = new WeakMap<readonly DiffRow[], Map<number, Span[]>>();
function wordsOf(rows: readonly DiffRow[]): Map<number, Span[]> {
  let words = wordCache.get(rows);
  if (!words) wordCache.set(rows, (words = wordChanges(rows)));
  return words;
}

/** Import specifiers per row, for a file whose imports the guide links; worked out once per rows array. */
const importCache = new WeakMap<readonly DiffRow[], Map<number, ImportSpan[]>>();
function importsOf(rows: readonly DiffRow[]): Map<number, ImportSpan[]> {
  let found = importCache.get(rows);
  if (!found) {
    found = new Map();
    for (const [i, r] of rows.entries()) {
      const spans = isLineRow(r) ? importSpans(r.text) : [];
      if (spans.length) found.set(i, spans);
    }
    importCache.set(rows, found);
  }
  return found;
}

export function renderPieces(
  pieces: readonly FocusPiece[],
  rows: readonly DiffRow[],
  tokens: RowTokens,
  canComment: (line: number) => boolean,
  linkImports = false,
): { nodes: DocumentFragment; rowEl: Map<number, HTMLElement> } {
  const rowEl = new Map<number, HTMLElement>();
  const nodes = document.createDocumentFragment();
  const words = wordsOf(rows);
  const imports = linkImports ? importsOf(rows) : null;
  for (const p of pieces) {
    const part = rows.slice(p.from, p.to);
    if (p.kind === "gap") {
      nodes.append(gapNode(p, part));
      continue;
    }
    part.forEach((r, k) => {
      const i = p.from + k;
      const row = rowNode(r, canComment, {
        marks: words.get(i),
        toks: tokens.get(i),
        links: imports?.get(i),
      });
      if (isLineRow(r) && r.new !== null) rowEl.set(r.new, row);
      nodes.append(row);
    });
  }
  return { nodes, rowEl };
}

/** Something drawn under a line (or above the rows, for the whole file): a finding, a comment, a composer. */
export type Note = {
  line: number | null;
  node: Node;
  /** One line standing in for it when its line is in the diff but not drawn now. */
  summary: () => Node;
};

/** Where each note goes, given which lines are drawn (`isDrawn`) and which exist at all (`inDiff`). */
export function layoutNotes(
  notes: readonly Note[],
  isDrawn: (line: number) => boolean,
  inDiff: (line: number) => boolean,
): {
  /** Above the rows: whole-file notes, and notes on a line the diff does not have. */
  top: Node[];
  byLine: Map<number, Node[]>;
  /** Notes whose line is in the diff but hidden, each with the line to show. */
  elsewhere: { line: number; summary: Node }[];
} {
  const top: Node[] = [];
  const byLine = new Map<number, Node[]>();
  const elsewhere: { line: number; summary: Node }[] = [];
  for (const { line, node, summary } of notes) {
    if (line === null) top.push(node);
    else if (isDrawn(line)) byLine.set(line, [...(byLine.get(line) ?? []), node]);
    else if (inDiff(line)) elsewhere.push({ line, summary: summary() });
    else top.push(h("p", { class: "muted small" }, `Line ${line} is not in this diff.`), node);
  }
  return { top, byLine, elsewhere };
}
