// How the reviewer left a guide tab: the scroll position, and per view and file what they opened
// (the file itself, the whole file, lines between hunks). Orca reloads a tab that was away, so
// this lives in the worker's memory (`tab.get` / `tab.save`) and is read back on load.
import type { Expansion } from "../src/diff-model";
import { isObj } from "../src/json";
import type { TourView } from "../src/tour";
import type { FileMemory, FileUi } from "./diff-draw";

type Saved = {
  scroll: { view: string; y: number } | null;
  /** By `<view>|<path>`. */
  files: Record<string, FileUi>;
};

/** Writes wait this long after the last change, so scrolling sends one request, not hundreds. */
const SAVE_DELAY_MS = 300;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function parseExpansion(v: unknown): [number, Expansion] | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [at, e]: unknown[] = v;
  if (!isNum(at) || !isObj(e) || !isNum(e.top) || !isNum(e.bottom)) return null;
  return [at, { top: e.top, bottom: e.bottom }];
}

function parseFile(v: unknown): FileUi | null {
  if (!isObj(v)) return null;
  const out: FileUi = {};
  if (typeof v.open === "boolean") out.open = v.open;
  if (typeof v.full === "boolean") out.full = v.full;
  if (Array.isArray(v.revealed)) out.revealed = v.revealed.filter(isNum);
  if (Array.isArray(v.expansions))
    out.expansions = v.expansions.flatMap((e) => {
      const parsed = parseExpansion(e);
      return parsed ? [parsed] : [];
    });
  return out;
}

/** What the worker kept, checked: it came back through a request, so nothing is taken on trust. */
function parseSaved(v: unknown): Saved {
  const saved: Saved = { scroll: null, files: {} };
  if (!isObj(v)) return saved;
  const s = v.scroll;
  if (isObj(s) && typeof s.view === "string" && isNum(s.y)) saved.scroll = { view: s.view, y: s.y };
  if (isObj(v.files))
    for (const [k, f] of Object.entries(v.files)) {
      const file = parseFile(f);
      if (file) saved.files[k] = file;
    }
  return saved;
}

export type TabMemory = {
  /** One file's memory in `view`. */
  file: (view: TourView, path: string) => FileMemory;
  /** The scroll position the tab was left at, when it was left on `view`. */
  scrollFor: (view: TourView) => number | null;
  setScroll: (view: TourView, y: number) => void;
  /** Sends what is waiting now, for when the tab is going away. */
  flush: () => void;
};

/** The tab's memory for PR `key`, as the worker kept it (empty when it has none or can't answer). */
export async function loadTabMemory(key: string): Promise<TabMemory> {
  const got = await orca.plugin.request("tab.get", { key }).catch(() => ({ memory: null }));
  const saved = parseSaved(got.memory);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const send = () => {
    timer = null;
    orca.plugin.request("tab.save", { key, memory: saved }).catch(() => {});
  };
  const later = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(send, SAVE_DELAY_MS);
  };
  return {
    file: (view, path) => {
      const id = `${view}|${path}`;
      return {
        get: () => saved.files[id],
        set: (patch) => {
          saved.files[id] = { ...saved.files[id], ...patch };
          later();
        },
      };
    },
    scrollFor: (view) => (saved.scroll?.view === view ? saved.scroll.y : null),
    setScroll: (view, y) => {
      saved.scroll = { view, y };
      later();
    },
    flush: () => {
      if (!timer) return;
      clearTimeout(timer);
      send();
    },
  };
}

/** How long a restore keeps chasing a page still growing (diffs loading) before giving up. */
const RESTORE_FOR_MS = 5_000;

/**
 * Scrolls the page to `y`, and again each time `root` changes size for a few seconds: the diffs load
 * after the first draw, and the review's arrival draws the view once more, which can shrink the page
 * back. The reviewer scrolling, clicking or typing stops it. Returns a function
 * that says whether it is still going, so the scroll it causes isn't saved as the reviewer's.
 */
export function restoreScroll(root: HTMLElement, y: number): () => boolean {
  let active = true;
  const stop = () => {
    active = false;
    grow.disconnect();
    clearTimeout(timeout);
    for (const e of STOP_EVENTS) window.removeEventListener(e, stop, true);
  };
  const attempt = () => {
    if (!active) return;
    window.scrollTo(0, y);
  };
  const grow = new ResizeObserver(() => requestAnimationFrame(attempt));
  grow.observe(root);
  const timeout = setTimeout(stop, RESTORE_FOR_MS);
  for (const e of STOP_EVENTS) window.addEventListener(e, stop, { capture: true, passive: true });
  attempt();
  return () => active;
}

const STOP_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
