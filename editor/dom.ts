// Building the guide tab's DOM from text. Nothing from a guide is ever parsed as HTML.

export type Child = Node | string | null | undefined | false;

/** An element of `tag`, typed as that tag's element (`h("textarea")` is an HTMLTextAreaElement). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** Agent prose with `backticks` as inline code; still text nodes only. */
export function prose(text: string): DocumentFragment {
  const out = document.createDocumentFragment();
  text.split(/(`[^`\n]+`)/g).forEach((part) => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`"))
      out.append(h("code", {}, part.slice(1, -1)));
    else if (part) out.append(part);
  });
  return out;
}
