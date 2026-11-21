// The overview's Changes section, drawn the way Diff Breakdown draws a branch: a share bar, one row
// per kind of change that opens to its files, and where in the tour to review each file. The data
// comes from the worker (`breakdown.get`). Paths go in as text; only the bundled Catppuccin icons
// are parsed as markup.
import type { Breakdown, BreakdownCategory, BreakdownFile } from "../src/breakdown/assemble";
import { ICON_SVGS, ICON_VIEWBOXES, type IconName } from "../src/breakdown/icons/svgs";
import { fileIcon } from "../src/breakdown/icons/resolve";
import { formatShare } from "../src/breakdown/share";
import type { CategoryId, FileStatus } from "../src/breakdown/types";
import { stopForFile } from "../src/overview";
import { stopView } from "../src/tour";
import { message } from "../src/errors";
import { prKey } from "../src/repo";
import { h } from "./dom";
import { plural } from "./parts";
import type { TourContext } from "./tour";

const STATUS_NAMES: Record<FileStatus, string> = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  T: "Type changed",
  U: "Untracked",
};

const numbers = new Intl.NumberFormat(orca.locale || undefined);
const fmt = (n: number) => numbers.format(n);

const SVG_NS = "http://www.w3.org/2000/svg";

/** One hidden sprite, outside the redrawn view, holds a <symbol> per file icon shown so far. */
const sprite = document.createElementNS(SVG_NS, "svg");
sprite.setAttribute("class", "sprite");
sprite.setAttribute("aria-hidden", "true");
const spriteIcons = new Set<IconName>();
const svgParser = new DOMParser();

/** The file's Catppuccin icon. Only the bundled markup is parsed; the file name just picks which. */
function fileIconEl(fileName: string): SVGElement {
  if (!sprite.isConnected) document.body.append(sprite);
  const icon = fileIcon(fileName);
  const id = `ci-${icon}`;
  if (!spriteIcons.has(icon)) {
    const symbol = document.createElementNS(SVG_NS, "symbol");
    symbol.setAttribute("id", id);
    symbol.setAttribute("viewBox", ICON_VIEWBOXES[icon] ?? "0 0 16 16");
    const parsed = svgParser.parseFromString(
      `<svg xmlns="${SVG_NS}">${ICON_SVGS[icon]}</svg>`,
      "image/svg+xml",
    );
    symbol.append(...Array.from(parsed.documentElement.childNodes));
    sprite.append(symbol);
    spriteIcons.add(icon);
  }
  const el = document.createElementNS(SVG_NS, "svg");
  el.setAttribute("class", "file-icon");
  el.setAttribute("width", "16");
  el.setAttribute("height", "16");
  el.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#${id}`);
  el.append(use);
  return el;
}

/** The chevron that turns when a category opens. */
function chevron(): SVGElement {
  const el = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({
    class: "chev",
    width: "14",
    height: "14",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  }))
    el.setAttribute(k, v);
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M9 6l6 6-6 6");
  el.append(path);
  return el;
}

/** The +/− columns; a zero is left blank, as Diff Breakdown does, unless `always`. */
const counts = (additions: number, deletions: number, binary = false, always = false) =>
  binary
    ? [h("span", { class: "num muted" }, "binary"), h("span", {})]
    : [
        h("span", { class: "num add" }, additions || always ? `+${fmt(additions)}` : ""),
        h("span", { class: "num del" }, deletions || always ? `−${fmt(deletions)}` : ""),
      ];

/** Which categories the reviewer left open, per PR, in this frame's own storage. */
function openStore(ctx: TourContext) {
  const id = `changes-open:${prKey(ctx.guide.pr.repo, ctx.guide.pr.number)}`;
  let open = new Set<CategoryId>();
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(id) ?? "[]");
    if (Array.isArray(raw))
      open = new Set(raw.filter((x): x is CategoryId => typeof x === "string"));
  } catch {
    // storage unavailable or unreadable: everything starts closed
  }
  return {
    has: (c: CategoryId) => open.has(c),
    set: (c: CategoryId, on: boolean) => {
      if (on) open.add(c);
      else open.delete(c);
      try {
        localStorage.setItem(id, JSON.stringify([...open]));
      } catch {
        // the choice just isn't remembered
      }
    },
  };
}

/**
 * Where to review a file: the first stop holding it, the skipped files' stop included. Every
 * changed file is in one; null only if the guide and git disagree about the files.
 */
function placeOf(ctx: TourContext, path: string) {
  const at = stopForFile(ctx.lookup, path);
  if (at === null) return null;
  const skip = at === ctx.stops.length;
  return {
    label: skip ? "Skipped →" : `Stop ${at + 1} →`,
    aria: skip
      ? `${path} is skipped by design: go to the skipped files`
      : `Go to stop ${at + 1}: ${ctx.stops[at]?.headline ?? ""}`,
    go: () => ctx.go(stopView(at), skip ? "file" : "heading", { file: path, line: null }),
  };
}

/** A file's name and its "Stop 3 →", both pressed to go where the tour reviews it. */
function placeLinks(
  place: NonNullable<ReturnType<typeof placeOf>>,
  o: { nameClass: string; title: string; label: Node[] },
): { nameEl: HTMLElement; where: HTMLElement } {
  const nameEl = h(
    "button",
    {
      type: "button",
      class: o.nameClass,
      title: o.title,
      "aria-label": `${o.title}: ${place.aria}`,
    },
    ...o.label,
  );
  nameEl.addEventListener("click", place.go);
  const where = h(
    "button",
    {
      type: "button",
      class: `btn sm ghost bd-where${place.label === "Skipped →" ? " off" : ""}`,
      "aria-label": place.aria,
    },
    place.label,
  );
  where.addEventListener("click", place.go);
  return { nameEl, where };
}

function fileRow(ctx: TourContext, file: BreakdownFile): HTMLElement {
  const slash = file.path.lastIndexOf("/");
  const name = file.path.slice(slash + 1);
  const dir = slash === -1 ? "" : file.path.slice(0, slash);
  const place = placeOf(ctx, file.path);
  const title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  const label = [h("span", { class: "fname" }, name), h("span", { class: "fdir" }, dir)];
  const nameClass = `bd-name${file.status === "D" ? " gone" : ""}`;
  const { nameEl, where } = place
    ? placeLinks(place, { nameClass, title, label })
    : {
        nameEl: h("span", { class: nameClass, title }, ...label),
        where: h("span", { class: "bd-where off small" }, "not in guide"),
      };
  return h(
    "li",
    { class: "bd-file" },
    h("span", { class: "bd-icon" }, fileIconEl(name)),
    nameEl,
    h(
      "span",
      { class: `bd-status s-${file.status}`, title: STATUS_NAMES[file.status] },
      h("span", { "aria-hidden": "true" }, file.status),
      h("span", { class: "sr-only" }, STATUS_NAMES[file.status]),
    ),
    h("span", {}),
    ...counts(file.additions, file.deletions, file.binary),
    where,
  );
}

function categoryRow(
  ctx: TourContext,
  c: BreakdownCategory,
  total: number,
  open: ReturnType<typeof openStore>,
): HTMLElement {
  const generated = c.id === "generated";
  const n = c.files.length + c.omitted;
  const listId = `changes-${c.id}`;
  const expanded = open.has(c.id);
  const head = h("button", {
    type: "button",
    class: "bd-head",
    "aria-expanded": String(expanded),
    "aria-controls": listId,
  });
  head.append(
    chevron(),
    h("span", { class: `bd-dot c-${c.id}`, "aria-hidden": "true" }),
    h("span", { class: "bd-cat" }, c.name),
    h("span", { class: "muted small" }, plural(n, "file")),
    generated
      ? h("span", { class: "muted small bd-share" }, "not counted")
      : h("span", { class: "muted small bd-share" }, formatShare(c.additions + c.deletions, total)),
    ...counts(c.additions, c.deletions),
    h("span", {}),
  );
  const list = h(
    "ul",
    { class: "bd-files", id: listId },
    ...c.files.map((f) => fileRow(ctx, f)),
    c.omitted
      ? h("li", { class: "bd-more muted small" }, `${plural(c.omitted, "more file")} not listed`)
      : null,
  );
  list.hidden = !expanded;
  head.addEventListener("click", () => {
    const now = head.getAttribute("aria-expanded") !== "true";
    head.setAttribute("aria-expanded", String(now));
    list.hidden = !now;
    open.set(c.id, now);
  });
  return h("li", { class: `bd-group${generated ? " generated" : ""}` }, head, list);
}

function shareBar(b: Breakdown): HTMLElement | null {
  const counted = b.categories.filter((c) => c.id !== "generated");
  const total = b.additions + b.deletions;
  if (!counted.length) return null;
  const share = (c: BreakdownCategory) => formatShare(c.additions + c.deletions, total);
  return h(
    "div",
    {
      class: "bd-bar",
      role: "img",
      "aria-label": `Share of changed lines: ${counted.map((c) => `${c.name} ${share(c)}`).join(", ")}`,
    },
    ...counted.map((c) =>
      h("span", {
        class: `bd-seg c-${c.id}`,
        style: `flex-grow:${total === 0 ? 1 : c.additions + c.deletions}`,
        title: `${c.name} · ${share(c)} of changed lines · +${fmt(c.additions)} −${fmt(c.deletions)}`,
      }),
    ),
  );
}

function filled(ctx: TourContext, b: Breakdown): (Node | null)[] {
  if (!b.categories.length) return [h("p", { class: "muted small" }, "No changed files.")];
  const total = b.additions + b.deletions;
  const open = openStore(ctx);
  return [
    // One grid for the totals and every row, so all the line counts sit in the same columns.
    h(
      "div",
      { class: "bd-grid" },
      h(
        "div",
        { class: "bd-refs" },
        h(
          "span",
          { class: "mono small bd-branch", title: `${b.headRef} → ${b.baseRef}` },
          `${b.headRef} → ${b.baseRef}`,
        ),
        ...counts(b.additions, b.deletions, false, true),
      ),
      shareBar(b),
      h("ul", { class: "bd-list" }, ...b.categories.map((c) => categoryRow(ctx, c, total, open))),
    ),
  ];
}
/** The section, with a line while the worker reads the changes and Try again if that fails. */
export function changesSection(ctx: TourContext): HTMLElement {
  const aside = h("span", { class: "muted small" });
  const body = h("div", { class: "bd" }, h("p", { class: "muted small" }, "Reading the changes…"));
  const load = async (): Promise<void> => {
    try {
      const b = await ctx.breakdown();
      aside.textContent = plural(b.fileCount, "file");
      body.replaceChildren(...filled(ctx, b).filter((x): x is Node => x !== null));
    } catch (e) {
      const retry = h("button", { type: "button", class: "link small" }, "Try again");
      retry.addEventListener("click", () => {
        body.replaceChildren(h("p", { class: "muted small" }, "Reading the changes…"));
        void load();
      });
      body.replaceChildren(
        h("p", { class: "muted small" }, `Couldn’t read the changes: ${message(e)} `, retry),
      );
    }
  };
  void load();
  return h(
    "section",
    { class: "section", "aria-labelledby": "changes-h" },
    h("div", { class: "row baseline" }, h("h2", { id: "changes-h" }, "Changes"), aside),
    body,
  );
}
