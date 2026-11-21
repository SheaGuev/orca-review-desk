// The comment composer: one text field with Add and Cancel, used under a line, a range of lines or
// a file header, and to edit a pending comment in place. It knows nothing about drafts; the
// caller says what Add and Cancel do.
import { h } from "./dom";

/** What a composer keeps while it is redrawn (a range extended, the diff redrawn): the text. */
export type ComposerState = { typed: string };

export const newId = (): string =>
  `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Grows a textarea with its text, from its `rows` up to `max` rows, then scrolls inside. */
function autosize(text: HTMLTextAreaElement, max = 12): void {
  const fit = () => {
    const style = getComputedStyle(text);
    const line = parseFloat(style.lineHeight) || 20;
    const chrome =
      parseFloat(style.paddingTop) +
      parseFloat(style.paddingBottom) +
      parseFloat(style.borderTopWidth) +
      parseFloat(style.borderBottomWidth);
    text.style.height = "auto";
    const limit = line * max + chrome;
    text.style.height = `${Math.min(text.scrollHeight + parseFloat(style.borderTopWidth) * 2, limit)}px`;
    text.style.overflowY = text.scrollHeight + chrome > limit ? "auto" : "hidden";
  };
  text.addEventListener("input", fit);
  // Measured once it is on the page.
  requestAnimationFrame(fit);
}

/** The keyboard hint and the two buttons under the text. */
const foot = (hintId: string, action: string, cancel: HTMLElement, add: HTMLElement): HTMLElement =>
  h(
    "div",
    { class: "composer-foot" },
    h(
      "span",
      { id: hintId, class: "muted small" },
      `⌘↩ ${action === "Save" ? "save" : "add"} · Esc cancel`,
    ),
    h("div", { class: "row" }, cancel, add),
  );

/** ⌘↩ submits; Esc cancels an empty composer, and with text only leaves the field for Cancel. */
function wireKeys(
  box: HTMLElement,
  o: {
    text: HTMLTextAreaElement;
    cancel: HTMLElement;
    submit: () => void;
    abandon: () => void;
  },
): void {
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      o.submit();
    } else if (e.key === "Escape") {
      // Never the tour's Esc (exit tour) while a composer has focus.
      e.preventDefault();
      e.stopPropagation();
      // Esc never throws typed text away: with text, it leaves the field for Cancel.
      if (!o.text.value.trim()) o.abandon();
      else if (e.target === o.text) o.cancel.focus();
    }
  });
}

/**
 * One composer for a line, a range of lines, the whole file, or editing a pending comment in
 * place. No line field: where it sits says where the comment goes.
 */
export function composerBox(o: {
  title: string;
  state: ComposerState;
  action: string;
  error?: string | null;
  submit: (body: string) => void;
  cancel: () => void;
}): HTMLElement {
  const id = newId();
  const text = h("textarea", {
    id: `${id}-body`,
    rows: "3",
    class: "input autosize",
    "aria-describedby": `${id}-hint ${id}-err`,
  });
  text.value = o.state.typed;
  const add = h("button", { type: "button", class: "btn sm primary" }, o.action);
  const cancel = h("button", { type: "button", class: "btn sm ghost" }, "Cancel");
  const sync = () => {
    o.state.typed = text.value;
    add.toggleAttribute("disabled", !text.value.trim());
  };
  text.addEventListener("input", sync);
  sync();
  autosize(text);
  const submit = () => {
    if (!text.value.trim()) return;
    o.submit(text.value.trim());
  };
  add.addEventListener("click", submit);
  cancel.addEventListener("click", () => o.cancel());
  const box = h(
    "div",
    { class: "composer", tabindex: "-1" },
    h("label", { for: text.id, class: "composer-title" }, o.title),
    text,
    h("p", { id: `${id}-err`, class: "field-error small", role: "alert" }, o.error ?? ""),
    foot(`${id}-hint`, o.action, cancel, add),
  );
  wireKeys(box, { text, cancel, submit, abandon: o.cancel });
  return box;
}
