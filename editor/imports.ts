// Module specifiers in a diff row, so the guide can make them clickable: `import … from '…'`,
// `export … from '…'`, a multi-line import's closing `} from '…'`, `import '…'`, `import('…')`
// and `require('…')`. One row at a time, like the diff itself.

/** The specifier's text inside its quotes, and where that text sits in the row. */
export type ImportSpan = { start: number; end: number; specifier: string };

const SCRIPT = /\.(?:[cm]?[jt]sx?)$/i;

/** Whether `path` is a file whose imports the guide links. */
export const linksImports = (path: string): boolean => SCRIPT.test(path);

const QUOTED = String.raw`(['"])([^'"\n]+)\1`;
const FORMS: readonly RegExp[] = [
  new RegExp(String.raw`^\s*(?:import|export)\b[^'"]*?\bfrom\s*${QUOTED}`, "g"),
  new RegExp(String.raw`^\s*\}\s*from\s*${QUOTED}`, "g"),
  new RegExp(String.raw`^\s*import\s*${QUOTED}`, "g"),
  new RegExp(String.raw`\bimport\s*\(\s*${QUOTED}\s*\)`, "g"),
  new RegExp(String.raw`\brequire\s*\(\s*${QUOTED}\s*\)`, "g"),
];

/** Every specifier on `text`, in order, once each. */
export function importSpans(text: string): ImportSpan[] {
  const found = new Map<number, ImportSpan>();
  for (const form of FORMS) {
    form.lastIndex = 0;
    for (const m of text.matchAll(form)) {
      const specifier = m[2];
      if (specifier === undefined || m.index === undefined) continue;
      // The specifier ends right before the closing quote that ends the match's quoted part.
      const close = m[0].lastIndexOf(m[1] ?? "'");
      const end = m.index + close;
      const start = end - specifier.length;
      if (!found.has(start)) found.set(start, { start, end, specifier });
    }
  }
  return [...found.values()].sort((a, b) => a.start - b.start);
}
