// Whether the rail is shown and how wide it is: a toggle at the start of the top bar, a handle on
// the rail's right edge, both remembered in this frame's localStorage. Only <html> classes and a
// CSS variable change, so nothing is redrawn and nothing typed is lost.
import { h } from "./dom";

export type RailState = { open: boolean; width: number };

const KEY = "review-desk:rail";
export const RAIL_MIN_PX = 200;
const RAIL_DEFAULT_PX = 290;
const KEY_STEP_PX = 16;
/** Below this the open rail lies over the page instead of narrowing it. */
export const OVERLAY_MAX = 700;

/** `width` kept between the minimum and half the tab (never under the minimum). */
export function clampWidth(width: number, tabWidth: number): number {
  const max = Math.max(RAIL_MIN_PX, Math.floor(tabWidth / 2));
  return Math.round(Math.min(Math.max(width, RAIL_MIN_PX), max));
}

/** The stored state, or the default: open unless the tab is too narrow to keep it beside the page. */
export function readRailState(tabWidth: number): RailState {
  const fallback = { open: tabWidth >= OVERLAY_MAX, width: RAIL_DEFAULT_PX };
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (typeof raw !== "object" || raw === null) return fallback;
    const open = "open" in raw && typeof raw.open === "boolean" ? raw.open : fallback.open;
    const width = "width" in raw && typeof raw.width === "number" ? raw.width : fallback.width;
    return { open, width };
  } catch {
    return fallback;
  }
}

let state: RailState | null = null;
const html = (): HTMLElement => document.documentElement;
const current = (): RailState => (state ??= readRailState(html().clientWidth));

function save(next: RailState): void {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage can be full or blocked; the rail still works for this session.
  }
  fitRail();
}

/** Applies the rail's state to <html>; call again when the tab resizes. */
export function fitRail(): void {
  const { open, width } = current();
  const el = html();
  el.classList.toggle("w-rail", open);
  el.classList.toggle("w-rail-over", open && el.clientWidth < OVERLAY_MAX);
  el.style.setProperty("--rail-w", `${clampWidth(width, el.clientWidth)}px`);
  document.querySelectorAll(".rail-toggle").forEach((b) => drawToggle(b, open));
  document.querySelectorAll(".rail-resize").forEach((r) => {
    r.setAttribute("aria-valuenow", String(clampWidth(width, el.clientWidth)));
    r.setAttribute("aria-valuemax", String(clampWidth(Infinity, el.clientWidth)));
  });
}

function drawToggle(button: Element, open: boolean): void {
  const label = open ? "Hide the sidebar" : "Show the sidebar";
  button.setAttribute("aria-expanded", String(open));
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
}

const SVG = "http://www.w3.org/2000/svg";
function sidebarIcon(): SVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "rail-toggle-icon");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", "M2.5 3h11v10h-11zM6 3v10");
  svg.append(path);
  return svg;
}

/** The top bar's button that shows or hides the rail. */
export function railToggle(): HTMLButtonElement {
  const button = h(
    "button",
    { type: "button", class: "btn sm icon rail-toggle", "aria-controls": "tour-rail" },
    sidebarIcon(),
  );
  drawToggle(button, current().open);
  button.addEventListener("click", () => save({ ...current(), open: !current().open }));
  return button;
}

function onKey(e: KeyboardEvent): void {
  const step = e.key === "ArrowLeft" ? -KEY_STEP_PX : e.key === "ArrowRight" ? KEY_STEP_PX : 0;
  if (!step) return;
  e.preventDefault();
  const tab = html().clientWidth;
  save({ ...current(), width: clampWidth(clampWidth(current().width, tab) + step, tab) });
}

/** The rail's right-edge handle: drag it, or focus it and use ← →, to resize the rail. */
export function railResizer(rail: HTMLElement): HTMLElement {
  const handle = h("div", {
    class: "rail-resize",
    role: "separator",
    tabindex: "0",
    "aria-orientation": "vertical",
    "aria-controls": "tour-rail",
    "aria-label": "Resize the sidebar",
    "aria-valuemin": String(RAIL_MIN_PX),
  });
  handle.addEventListener("pointerdown", (down) => {
    down.preventDefault();
    handle.setPointerCapture(down.pointerId);
    html().classList.add("rail-dragging");
    const left = rail.getBoundingClientRect().left;
    const move = (e: PointerEvent) => {
      state = { ...current(), width: clampWidth(e.clientX - left, html().clientWidth) };
      fitRail();
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      html().classList.remove("rail-dragging");
      save(current());
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
    handle.addEventListener("pointercancel", up, { once: true });
  });
  handle.addEventListener("keydown", onKey);
  return handle;
}

/** Forgets the state read so far, for tests that change localStorage between runs. */
export function resetRailState(): void {
  state = null;
}
