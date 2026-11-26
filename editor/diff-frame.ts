// The elements of a diff view before any file is shown: the header (the path as an open/close
// toggle, +/− counts, the actions), and the scrolling body the rows go in. editor/diff-view.ts
// fills them and wires them up.
import { h } from "./dom";

export type DiffFrame = {
  /** The whole view. */
  el: HTMLElement;
  /** The path in the header: pressing it opens or closes the file. */
  toggle: HTMLButtonElement;
  pathText: HTMLElement;
  /** +/− counts, then `pendingMeta`. */
  meta: HTMLElement;
  /** "2 pending", in the header beside +/−. */
  pendingMeta: HTMLElement;
  /** Spoken, not seen: what a press just did. */
  announce: HTMLElement;
  fullToggle: HTMLButtonElement;
  commentFile: HTMLButtonElement;
  openIn: HTMLButtonElement;
  /** GitHub's Viewed checkbox, or null when the view has no viewed state to show. */
  viewedBox: HTMLInputElement | null;
  /** Above the rows: notes about the file, whole-file findings and comments. */
  fileBox: HTMLElement;
  /** The rows. */
  lines: HTMLElement;
  /** Below the rows: what is further down, and "Show remaining". */
  moreBox: HTMLElement;
  scroller: HTMLElement;
};

type FrameOptions = {
  variant: "card" | "listed";
  expanded: boolean;
  /** Whether the view opens on a stop's ranges, so Full file is offered. */
  focused: boolean;
  /** Whether a review is under way, so Comment on file is offered. */
  reviewing: boolean;
  /** Whether the file gets GitHub's Viewed checkbox. */
  viewed: boolean;
  lead: readonly (Node | null)[];
  tags: readonly Node[];
};

const SVG = "http://www.w3.org/2000/svg";
/** Arrows pointing apart (show the rest of the file) or together (back to the stop's lines). */
const FOLD_PATHS = {
  unfold: "M5 4.5 8 1.5l3 3M8 1.5V6M5 11.5l3 3 3-3M8 14.5V10M2.5 8h11",
  fold: "M5 2l3 3 3-3M8 5V1M5 14l3-3 3 3M8 11v4M2.5 8h11",
} as const;

function foldIcon(kind: keyof typeof FOLD_PATHS): SVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "fold-icon");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", FOLD_PATHS[kind]);
  svg.append(path);
  return svg;
}

/** The whole-file toggle as it stands: its icon, pressed state, and what a press will do. */
export function drawFullToggle(button: HTMLElement, full: boolean): void {
  const label = full ? "Show only this stop’s lines" : "Show the whole file";
  button.replaceChildren(foldIcon(full ? "fold" : "unfold"));
  button.setAttribute("aria-pressed", String(full));
  button.setAttribute("aria-label", label);
  button.title = label;
}

/** The header's three actions; which of them show depends on the view. */
function actionButtons() {
  return {
    fullToggle: h("button", { type: "button", class: "btn sm icon dv-full" }),
    commentFile: h(
      "button",
      { type: "button", class: "btn sm", "aria-expanded": "false" },
      "Comment on file",
    ),
    openIn: h(
      "button",
      { type: "button", class: "btn sm ghost", "aria-label": "Open this file in Orca" },
      "Open in Orca",
    ),
  };
}

/** The scrolling body: notes above the rows, the rows, and what is further down. */
function body(bodyId: string, titleId: string) {
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
  return { fileBox, lines, moreBox, scroller };
}

/** The path as an open/close toggle, with the chevron, so the whole name is a large target. */
function pathToggle(expanded: boolean, bodyId: string) {
  const pathText = h("span", { class: "dv-path-text" });
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
  );
  return { pathText, toggle };
}

export function buildFrame(o: FrameOptions): DiffFrame {
  const uid = Math.random().toString(36).slice(2, 8);
  const titleId = `dv-${uid}`;
  const bodyId = `dv-body-${uid}`;
  const { pathText, toggle } = pathToggle(o.expanded, bodyId);
  const meta = h("p", { class: "dv-meta small" });
  const pendingMeta = h("span", { class: "pending-meta" });
  const announce = h("p", { class: "sr-only", role: "status" });
  const buttons = actionButtons();
  drawFullToggle(buttons.fullToggle, false);
  const parts = body(bodyId, titleId);
  const viewedBox = o.viewed ? h("input", { type: "checkbox", class: "cbox", disabled: "" }) : null;
  const head = h(
    "header",
    { class: "dv-head" },
    h(
      "div",
      { class: "stack-xs dv-title" },
      h(
        "div",
        { class: "row wrap dv-name" },
        h("h3", { class: "dv-path", id: titleId }, toggle),
        meta,
        ...o.tags,
      ),
      ...o.lead,
    ),
    h(
      "div",
      { class: "row wrap dv-actions" },
      viewedBox && h("label", { class: "btn sm dv-viewed" }, viewedBox, "Viewed"),
      o.focused ? buttons.fullToggle : null,
      o.reviewing ? buttons.commentFile : null,
      buttons.openIn,
    ),
    announce,
  );
  const el = h(
    "section",
    { class: `diff-view ${o.variant}`, "aria-labelledby": titleId },
    head,
    parts.scroller,
  );
  return { el, toggle, pathText, meta, pendingMeta, announce, viewedBox, ...buttons, ...parts };
}
