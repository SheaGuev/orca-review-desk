// Every comment of this review on the wrap-up, as GitHub lists them: the file and line, then the
// comment's text. Pending ones (in tour order) can be edited, deleted or shown in their diff from
// their ⋯ menu; ones already posted on their own (Comment) follow, marked Posted, with a link. The
// file line opens a few rows of the diff around the comment, loaded the first time it is opened.
import { diffRows, gutterDigits, rowOfLine } from "../src/diff-model";
import { message } from "../src/errors";
import { pendingOrder } from "../src/pending";
import { commentPlace, type DraftComment, type PostedComment } from "../src/review";
import { composerBox, type ComposerState } from "./composer";
import { renderPieces } from "./diff-rows";
import { h, prose } from "./dom";
import { tokensFor } from "./highlight";
import type { ReviewSession } from "./review-session";

/** Unchanged or removed rows shown above the commented ones, so the line reads in its place. */
const ROWS_ABOVE = 3;

type Where = Pick<DraftComment, "path" | "line" | "startLine">;

/** The rows of the diff around `c`, as the diffs draw them, the commented rows marked. */
async function snippetRows(session: ReviewSession, c: Where & { line: number }): Promise<Node> {
  const file = await orca.plugin
    .request("diff.get", { key: session.key, path: c.path }, { timeoutMs: 120_000 })
    .catch((e: unknown) => message(e));
  if (typeof file === "string") return h("p", { class: "field-error small" }, file);
  const rows = diffRows(file.lines);
  const first = c.startLine ?? c.line;
  const [start, end] = [rowOfLine(rows, first), rowOfLine(rows, c.line)];
  if (start < 0 || end < 0)
    return h("p", { class: "muted small" }, "This line isn’t in the diff any more.");
  const from = Math.max(0, start - ROWS_ABOVE);
  const drawn = renderPieces(
    [{ kind: "show", from, to: end + 1 }],
    rows,
    await tokensFor(file),
    () => false,
  );
  for (const [line, row] of drawn.rowEl)
    if (line >= first && line <= c.line) row.classList.add("target");
  const scroll = h("div", { class: "dv-scroll" }, h("div", { class: "dv-rows" }, drawn.nodes));
  scroll.style.setProperty("--ln", `${gutterDigits(rows) + 1}ch`);
  return scroll;
}

/** The file and line, as a toggle that opens the snippet under it (whole-file comments have none). */
function whereToggle(session: ReviewSession, c: Where, snippet: HTMLElement): HTMLElement {
  const slash = c.path.lastIndexOf("/");
  const label = [
    h("span", { class: "rc-dir" }, slash < 0 ? "" : c.path.slice(0, slash + 1)),
    h("span", { class: "rc-file" }, c.path.slice(slash + 1)),
    h("span", { class: "rc-line" }, c.line === null ? "file" : commentPlace(c)),
  ];
  const { line } = c;
  if (line === null) return h("span", { class: "rc-where", title: c.path }, ...label);
  const toggle = h(
    "button",
    { type: "button", class: "rc-where", title: c.path, "aria-expanded": "false" },
    h("span", { class: "rc-chev", "aria-hidden": "true" }),
    ...label,
  );
  let loaded = false;
  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(open));
    snippet.hidden = !open;
    if (!open || loaded) return;
    loaded = true;
    snippet.replaceChildren(h("p", { class: "muted small" }, "Loading the diff…"));
    void snippetRows(session, { ...c, line }).then((rows) => snippet.replaceChildren(rows));
  });
  return toggle;
}

type MenuItem = { label: string; run: () => void };

/** The ⋯ button with an item per action; returns it wrapped with its menu. */
function menuParts(label: string, items: readonly MenuItem[]) {
  const button = h(
    "button",
    {
      type: "button",
      class: "rc-more",
      "aria-label": label,
      "aria-haspopup": "menu",
      "aria-expanded": "false",
    },
    "⋯",
  );
  const menu = h("div", { class: "rc-menu", role: "menu", "aria-label": label });
  menu.hidden = true;
  const entries = items.map((it) => ({
    it,
    el: h("button", { type: "button", role: "menuitem", class: "rc-menu-item" }, it.label),
  }));
  menu.append(...entries.map((e) => e.el));
  return { button, menu, entries, wrap: h("span", { class: "rc-more-wrap" }, button, menu) };
}

/**
 * The ⋯ button and its menu, the comment's actions in one place so the header row stays short.
 * Esc (focus back on ⋯) or a press outside closes it; picking an item closes it, then runs it.
 */
function moreMenu(label: string, items: readonly MenuItem[]): HTMLElement {
  const { button, menu, entries, wrap } = menuParts(label, items);
  const close = (focus: boolean) => {
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", outside, true);
    if (focus) button.focus();
  };
  const outside = (e: MouseEvent) => {
    if (!(e.target instanceof Node) || !wrap.contains(e.target)) close(false);
  };
  for (const { it, el } of entries)
    el.addEventListener("click", () => {
      close(false);
      it.run();
    });
  button.addEventListener("click", () => {
    if (!menu.hidden) return close(false);
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    menu.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    document.addEventListener("click", outside, true);
  });
  wrap.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || menu.hidden) return;
    e.preventDefault();
    e.stopPropagation();
    close(true);
  });
  return wrap;
}

/** One comment: the header row (where; the badge and ⋯), the snippet slot, then its text. */
function item(
  session: ReviewSession,
  c: Where & { body: string },
  o: { cls: string; tag: "Pending" | "Posted"; menu: HTMLElement; body: Node[]; id: string },
): HTMLElement {
  const snippet = h("div", { class: "rc-snippet" });
  snippet.hidden = true;
  return h(
    "li",
    { class: `rc ${o.cls}`, "data-comment": o.id },
    h(
      "div",
      { class: "rc-head" },
      whereToggle(session, c, snippet),
      h("span", { class: `tag ${o.tag.toLowerCase()}` }, o.tag),
      o.menu,
    ),
    snippet,
    ...o.body,
  );
}

export type ListOptions = {
  /** Pending comments open for editing, with what is typed so far, by id. */
  editing: Map<string, ComposerState>;
  save: (c: DraftComment, body: string) => void;
  remove: (c: DraftComment) => void;
  /** What a pending comment the PR moved away from offers instead. */
  stale: (c: DraftComment) => Node[];
  redraw: () => void;
};

/** The comment's text in its own panel, as GitHub draws a comment's body. */
const textPanel = (body: string): HTMLElement =>
  h("div", { class: "rc-text" }, h("div", { class: "rc-body" }, prose(body)));

/** Save and Cancel over the comment's text, in its place. */
function editor(c: DraftComment, typed: ComposerState, o: ListOptions): HTMLElement {
  const box = composerBox({
    title: `Edit your comment on ${commentPlace(c)}`,
    state: typed,
    action: "Save",
    submit: (body) => {
      o.editing.delete(c.id);
      o.save(c, body);
    },
    cancel: () => {
      o.editing.delete(c.id);
      o.redraw();
    },
  });
  return h("div", { class: "rc-text editing" }, box);
}

function pendingItem(session: ReviewSession, c: DraftComment, o: ListOptions): HTMLElement {
  const place = `${c.path} ${commentPlace(c)}`;
  const typed = o.editing.get(c.id);
  const items: MenuItem[] = [
    ...(session.nav ? [{ label: "Show in diff", run: () => session.nav?.jump(c) }] : []),
    {
      label: "Edit",
      run: () => {
        o.editing.set(c.id, { typed: c.body });
        o.redraw();
        document
          .querySelector<HTMLElement>(`[data-comment="${CSS.escape(c.id)}"] textarea`)
          ?.focus();
      },
    },
    { label: "Delete", run: () => o.remove(c) },
  ];
  const stale = session.stale.has(c.id);
  return item(session, c, {
    cls: stale ? "pending stale" : "pending",
    id: c.id,
    tag: "Pending",
    menu: moreMenu(`Actions for your comment on ${place}`, items),
    body: [typed ? editor(c, typed, o) : textPanel(c.body), ...(stale ? o.stale(c) : [])],
  });
}

function postedItem(session: ReviewSession, c: PostedComment): HTMLElement {
  const place = `${c.path} ${commentPlace(c)}`;
  const asDraft: DraftComment = { ...c, id: `posted-${c.id}`, source: "manual" };
  const items: MenuItem[] = [
    ...(session.nav ? [{ label: "Show in diff", run: () => session.nav?.jump(asDraft) }] : []),
    ...(c.url
      ? [{ label: "Open on GitHub ↗", run: () => void orca.shell?.openExternal(c.url) }]
      : []),
  ];
  return item(session, c, {
    cls: "posted",
    id: `posted-${c.id}`,
    tag: "Posted",
    menu: moreMenu(`Actions for your posted comment on ${place}`, items),
    body: [textPanel(c.body)],
  });
}

/** Every comment of this review: pending ones in tour order, then the ones already posted. */
export function commentList(session: ReviewSession, o: ListOptions): HTMLElement {
  const { comments } = session.draft;
  if (!comments.length && !session.posted.length)
    return h(
      "p",
      { class: "muted small" },
      "Add comments from the stops: a suggested comment’s Add to review, or + on a line.",
    );
  return h(
    "ul",
    { class: "review-comments" },
    ...pendingOrder(session.stops, comments).map((c) => pendingItem(session, c, o)),
    ...session.posted.map((c) => postedItem(session, c)),
  );
}
