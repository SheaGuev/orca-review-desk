// Which code theme colours the guide's diffs: the "Code colors" setting, shown and changed from a
// corner button. Changing it only swaps an attribute on <html>; every theme's colours are already
// on the rows (editor/highlight.ts), so nothing is redrawn.
import { CODE_THEMES } from "./code-themes";
import { h } from "./dom";

const NONE = "none";
const DEFAULT = "cursor-dark";
const CHOICES = [
  ...CODE_THEMES.map((t) => ({ id: t.id, title: t.title })),
  { id: NONE, title: "No colors" },
];

/** The setting's value as a known choice; anything else (unset, a removed theme) is the default. */
export function codeThemeOf(value: unknown): string {
  return CHOICES.some((c) => c.id === value) ? String(value) : DEFAULT;
}

/** The choice after `id`, wrapping round. */
export function nextCodeTheme(id: string): string {
  const at = CHOICES.findIndex((c) => c.id === id);
  return CHOICES[(at + 1) % CHOICES.length]?.id ?? DEFAULT;
}

const titleOf = (id: string): string => CHOICES.find((c) => c.id === id)?.title ?? id;

/** Applies the setting to `html` and follows it; returns the corner button that cycles it. */
export function codeThemeButton(html: HTMLElement): HTMLButtonElement {
  const button = h("button", { type: "button", class: "btn sm code-theme-btn" });
  const apply = (value: unknown) => {
    const id = codeThemeOf(value);
    html.dataset.codeTheme = id;
    button.textContent = `Code colors: ${titleOf(id)}`;
    button.title = `Switch to ${titleOf(nextCodeTheme(id))}`;
  };
  const read = () =>
    orca.settings
      .get("codeTheme")
      .then(apply)
      .catch(() => apply(undefined));
  apply(undefined);
  void read();
  orca.settings.onDidChange(({ key }) => {
    if (key === "codeTheme") void read();
  });
  button.addEventListener("click", () => {
    const next = nextCodeTheme(codeThemeOf(html.dataset.codeTheme));
    apply(next);
    orca.settings.set("codeTheme", next).catch(() => {});
  });
  return button;
}
