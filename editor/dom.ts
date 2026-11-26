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

/** A path's folders (with the trailing slash) and its file name, so a row can shorten the folders. */
export function splitPath(path: string): [string, string] {
  const at = path.lastIndexOf("/") + 1;
  return [path.slice(0, at), path.slice(at)];
}

/**
 * A file name's stem and the suffix that tells it apart: `.test.ts` for a test beside its source,
 * else the last extension. A row shortens the stem and always shows the suffix.
 */
export function splitName(name: string): [string, string] {
  const first = name.indexOf(".", 1);
  if (first < 0) return [name, ""];
  const last = name.lastIndexOf(".");
  const at = name.length - first <= 14 ? first : last;
  return [name.slice(0, at), name.slice(at)];
}
