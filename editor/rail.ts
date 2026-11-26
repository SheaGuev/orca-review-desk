// The tour's rail: the overview, every group with its files and a Reviewed box, and the wrap-up;
// or (Files) every changed file as a folder tree. A file press goes to its group and its card.
// Ticks and the Reviewed boxes follow GitHub's Viewed state as it changes.
import { h, splitName } from "./dom";
import { folderTree, type TreeNode } from "./file-tree";
import type { Viewed } from "./viewed";

export type RailGroup = { title: string; files: readonly string[]; flagged: boolean };
export type LineCounts = ReadonlyMap<string, { additions: number; deletions: number }>;

export type RailInput = {
  groups: readonly RailGroup[];
  /** The group shown, or null on the overview and the wrap-up. */
  current: number | null;
  seen: readonly number[];
  atWrapUp: boolean;
  finishLabel: string;
  /** Files skipped by design, with why, for the tree's tag. */
  skipped: ReadonlyMap<string, string>;
  viewed: Viewed;
  counts: Promise<LineCounts>;
  /** Pending comments per group, and when they change. */
  pending: () => readonly number[];
  onPendingChange: (listener: () => void) => () => void;
  goGroup: (index: number) => void;
  goFile: (index: number, path: string) => void;
  goOverview: () => void;
  goWrapUp: () => void;
  track: (dispose: () => void) => void;
};

type Mode = "groups" | "files";
// Kept across redraws: the view is drawn again on every move.
let mode: Mode = "groups";
const opened = new Map<number, boolean>();

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The name with its stem shortened first, so `x.test.ts` and `x.ts` stay apart in a narrow rail. */
function fileName(label: string): HTMLElement {
  const [stem, suffix] = splitName(label);
  return h(
    "span",
    { class: "rf-name" },
    h("span", { class: "rf-stem" }, stem),
    ...(suffix ? [h("span", { class: "rf-ext" }, suffix)] : []),
  );
}

// Which files each Viewed box in the rail stands for: one for a file row, every file beneath for
// a folder, the group's files for a Reviewed box.
const boxFiles = new WeakMap<HTMLInputElement, readonly string[]>();

/** A box over `files`: ticking it marks them all viewed on GitHub, unticking marks them not. */
function viewedBox(r: RailInput, files: readonly string[], label: string): HTMLInputElement {
  const box = h("input", { type: "checkbox", class: "cbox", "aria-label": label, disabled: "" });
  boxFiles.set(box, files);
  box.addEventListener("change", () => {
    // Read once: each file's change redraws the box before the next file is set.
    const on = box.checked;
    files.forEach((f) => r.viewed.set(f, on));
  });
  return box;
}

function fileRow(r: RailInput, group: number, path: string, label: string): HTMLElement {
  const go = h(
    "button",
    { type: "button", class: "rf-go", "aria-label": path },
    fileName(label),
    ...(r.skipped.has(path) ? [h("span", { class: "tag skip" }, r.skipped.get(path) ?? "")] : []),
    h("span", { class: "rf-count", "aria-hidden": "true" }),
  );
  go.addEventListener("click", () => r.goFile(group, path));
  return h(
    "div",
    { class: "rf", "data-path": path, title: path },
    viewedBox(r, [path], `Viewed: ${path}`),
    go,
  );
}

function stepLink(label: Node[], current: boolean, onPress: () => void): HTMLElement {
  const b = h("button", { type: "button", class: "step-link" }, ...label);
  if (current) b.setAttribute("aria-current", "step");
  b.addEventListener("click", onPress);
  return b;
}

function groupMark(r: RailInput, i: number): HTMLElement {
  const now = r.current === i;
  const text = now ? "●" : r.seen.includes(i) ? "✓" : String(i + 1);
  const cls = now ? "now" : r.seen.includes(i) ? "seen" : "";
  return h("span", { class: `mark ${cls}`, "aria-hidden": "true" }, text);
}

function groupHead(r: RailInput, g: RailGroup, i: number, files: HTMLElement): HTMLElement {
  const open = opened.get(i) ?? r.current === i;
  files.hidden = !open;
  const chev = h("button", {
    type: "button",
    class: "rg-chev",
    "aria-expanded": String(open),
    "aria-label": `${open ? "Hide" : "Show"} the files of group ${i + 1}`,
  });
  chev.addEventListener("click", () => {
    const now = files.hidden;
    files.hidden = !now;
    opened.set(i, now);
    chev.setAttribute("aria-expanded", String(now));
  });
  const link = stepLink(
    [
      groupMark(r, i),
      h("span", { class: "rg-title" }, g.title),
      h("span", {
        class: "step-pending",
        "data-group": String(i),
        "aria-hidden": "true",
        hidden: "",
      }),
      ...(g.flagged ? [h("span", { class: "mark flag", "aria-hidden": "true" }, "⚑")] : []),
    ],
    r.current === i,
    () => r.goGroup(i),
  );
  link.setAttribute("aria-label", `Group ${i + 1}: ${g.title}`);
  return h("div", { class: "rg-head" }, chev, link, reviewedBox(r, g, i));
}

/** A group's Reviewed box: ticking it marks every file in the group as viewed on GitHub. */
function reviewedBox(r: RailInput, g: RailGroup, i: number): HTMLElement {
  const box = viewedBox(r, g.files, `Reviewed, group ${i + 1}`);
  box.dataset.group = String(i);
  return h(
    "label",
    { class: "rg-reviewed", title: "Reviewed: mark every file in this group as viewed" },
    box,
  );
}

function groupsView(r: RailInput): HTMLElement {
  return h(
    "div",
    { class: "rail-groups" },
    ...r.groups.map((g, i) => {
      const files = h(
        "ul",
        { class: "rg-files" },
        ...g.files.map((f) => h("li", {}, fileRow(r, i, f, base(f)))),
      );
      return h(
        "section",
        { class: `rg${r.current === i ? " current" : ""}` },
        groupHead(r, g, i, files),
        files,
      );
    }),
  );
}

const filesUnder = (n: TreeNode): string[] =>
  n.kind === "file" ? [n.path] : n.children.flatMap(filesUnder);

/** A folder's row: its open/close chevron, a box over every file beneath, and its name. */
function folderRow(
  r: RailInput,
  n: Extract<TreeNode, { kind: "dir" }>,
  children: HTMLElement,
): HTMLElement {
  // The name is the toggle people tab to; the chevron is the same action, for the pointer.
  const chev = h("button", {
    type: "button",
    class: "ft-chev",
    "data-open": "true",
    tabindex: "-1",
    "aria-hidden": "true",
  });
  const name = h(
    "button",
    { type: "button", class: "ft-dir", "aria-expanded": "true", title: n.path },
    n.name,
  );
  const toggle = () => {
    children.hidden = !children.hidden;
    name.setAttribute("aria-expanded", String(!children.hidden));
    chev.dataset.open = String(!children.hidden);
  };
  chev.addEventListener("click", toggle);
  name.addEventListener("click", toggle);
  const files = filesUnder(n);
  // A folder of one file would only repeat that file's own box; the space keeps names aligned.
  const box =
    files.length > 1
      ? viewedBox(r, files, `Viewed: every file in ${n.path}`)
      : h("span", { class: "cbox-space", "aria-hidden": "true" });
  return h("div", { class: "ft-row" }, chev, box, name);
}

function treeNodes(
  r: RailInput,
  nodes: readonly TreeNode[],
  groupOf: Map<string, number>,
): HTMLElement {
  return h(
    "ul",
    { class: "ft" },
    ...nodes.map((n) => {
      if (n.kind === "file")
        return h("li", {}, fileRow(r, groupOf.get(n.path) ?? 0, n.path, n.name));
      const children = treeNodes(r, n.children, groupOf);
      return h("li", {}, folderRow(r, n, children), children);
    }),
  );
}

function filesView(r: RailInput): HTMLElement {
  const groupOf = new Map<string, number>();
  r.groups.forEach((g, i) => g.files.forEach((f) => groupOf.set(f, i)));
  return treeNodes(r, folderTree([...groupOf.keys()]), groupOf);
}

/** Brings ticks, Reviewed boxes and pending counts in `el` up to date. */
function sync(r: RailInput, el: HTMLElement): void {
  el.querySelectorAll<HTMLElement>(".rf").forEach((b) => {
    const on = r.viewed.has(b.dataset.path ?? "") === true;
    b.classList.toggle("viewed", on);
  });
  el.querySelectorAll<HTMLInputElement>("input.cbox").forEach((box) => {
    const files = boxFiles.get(box);
    if (!files) return;
    const states = files.map((f) => r.viewed.has(f));
    box.disabled = states.some((s) => s === null);
    box.checked = states.length > 0 && states.every((s) => s === true);
    box.indeterminate = !box.checked && states.some((s) => s === true);
  });
  const pending = r.pending();
  el.querySelectorAll<HTMLElement>(".step-pending[data-group]").forEach((pill) => {
    const n = pending[Number(pill.dataset.group)] ?? 0;
    pill.textContent = n ? String(n) : "";
    pill.hidden = !n;
  });
}

async function fillCounts(r: RailInput, el: HTMLElement): Promise<void> {
  const counts = await r.counts;
  el.querySelectorAll<HTMLElement>(".rf").forEach((b) => {
    const c = counts.get(b.dataset.path ?? "");
    const slot = b.querySelector(".rf-count");
    if (!c || !slot) return;
    slot.replaceChildren(
      ...(c.additions ? [h("span", { class: "add" }, `+${c.additions}`)] : []),
      ...(c.deletions ? [h("span", { class: "del" }, ` −${c.deletions}`)] : []),
    );
  });
}

function modeToggle(onPick: (m: Mode) => void): HTMLElement {
  const pick = (m: Mode, label: string) => {
    const b = h("button", { type: "button", "aria-pressed": String(mode === m) }, label);
    b.addEventListener("click", () => onPick(m));
    return b;
  };
  return h(
    "div",
    { class: "rail-mode", role: "group", "aria-label": "Sort files by" },
    h("span", { class: "rail-mode-label", "aria-hidden": "true" }, "Sort by"),
    h("span", { class: "seg" }, pick("groups", "Groups"), pick("files", "Files")),
  );
}

/** The rail's content; redraws itself when the reviewer switches between Groups and Files. */
export function rail(r: RailInput): HTMLElement {
  const el = h("div", { class: "rail-body" });
  const draw = () => {
    el.replaceChildren(
      stepLink(
        [h("span", { class: "mark", "aria-hidden": "true" }, "◇"), h("span", {}, "Overview")],
        false,
        r.goOverview,
      ),
      mode === "groups" ? groupsView(r) : filesView(r),
      stepLink(
        [
          h(
            "span",
            { class: `mark${r.atWrapUp ? " now" : ""}`, "aria-hidden": "true" },
            r.atWrapUp ? "●" : "◇",
          ),
          h("span", {}, r.finishLabel),
        ],
        r.atWrapUp,
        r.goWrapUp,
      ),
      modeToggle((m) => {
        mode = m;
        draw();
      }),
    );
    sync(r, el);
    void fillCounts(r, el);
  };
  draw();
  r.track(r.viewed.onChange(() => sync(r, el)));
  r.track(r.onPendingChange(() => sync(r, el)));
  return el;
}

/** Marks `path`'s row in the rail as the card on screen. */
export function markRailFile(path: string | null): void {
  document
    .querySelectorAll<HTMLElement>(".rail .rf")
    .forEach((b) => b.classList.toggle("now", path !== null && b.dataset.path === path));
}
