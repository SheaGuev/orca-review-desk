// Syntax colours for a file's diff rows. Each side is tokenized as one text (the PR head: unchanged
// and added lines; the base: unchanged and removed lines), so a construct spanning lines inside a
// hunk is coloured as in the file. One that crosses a hunk edge can be coloured wrongly, as on
// GitHub. Every code theme is tokenized at once, so switching themes only changes CSS.
import { diffRows, type DiffFile, type DiffRow } from "../src/diff-model";
import { CODE_THEMES } from "./code-themes";
import {
  GRAMMARS,
  createHighlighterCore,
  createJavaScriptRegexEngine,
  type GrammarId,
  type HighlighterCore,
  type ThemedTokenWithVariants,
} from "./vendor/shiki/shiki.js";

/** One coloured run of a row's text, with its style in each code theme. */
export type Tok = {
  start: number;
  end: number;
  styles: Record<string, { color?: string; italic: boolean; bold: boolean }>;
};
/** Row index (as `diffRows` numbers them) to that row's runs. */
export type RowTokens = ReadonlyMap<number, readonly Tok[]>;

const BY_EXTENSION: Readonly<Record<string, GrammarId>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "json",
  graphql: "graphql",
  gql: "graphql",
  md: "markdown",
  mdx: "markdown",
  yml: "yaml",
  yaml: "yaml",
  css: "css",
  scss: "scss",
  html: "html",
  htm: "html",
  py: "python",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  java: "java",
  go: "go",
  rs: "rust",
  rb: "ruby",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  sql: "sql",
  toml: "toml",
  xml: "xml",
  svg: "xml",
};

/** The grammar for `path`, or null for a language the guide doesn't colour. */
export function grammarFor(path: string): GrammarId | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name === "Dockerfile" || name.endsWith(".Dockerfile")) return "dockerfile";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null) : null;
}

let highlighter: Promise<HighlighterCore> | null = null;
function core(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: CODE_THEMES.map((t) => t.theme),
    langs: [],
    // Why forgiving: a grammar regex the JS engine can't translate leaves that token plain
    // instead of failing the whole file.
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighter;
}

const THEME_KEYS = Object.fromEntries(CODE_THEMES.map((t) => [t.id, t.id]));

function toTok(t: ThemedTokenWithVariants): Tok {
  const styles: Tok["styles"] = {};
  for (const [id, s] of Object.entries(t.variants)) {
    const f = s.fontStyle ?? 0;
    styles[id] = { color: s.color, italic: f > 0 && (f & 1) !== 0, bold: f > 0 && (f & 2) !== 0 };
  }
  return { start: 0, end: t.content.length, styles };
}

/** Tokens per line of `lines` joined, each run's offsets relative to its own line. */
function tokenizeLines(hl: HighlighterCore, lang: GrammarId, lines: readonly string[]): Tok[][] {
  return hl.codeToTokensWithThemes(lines.join("\n"), { lang, themes: THEME_KEYS }).map((line) => {
    let at = 0;
    return line.map((t) => {
      const tok = toTok(t);
      tok.start = at;
      tok.end = at += t.content.length;
      return tok;
    });
  });
}

type Side = { rows: number[]; text: string[] };

/** Which rows make up each side of the diff, in order, and their text. */
export function sides(rows: readonly DiffRow[]): { head: Side; base: Side } {
  const head: Side = { rows: [], text: [] };
  const base: Side = { rows: [], text: [] };
  rows.forEach((r, i) => {
    const side = r.kind === "ctx" || r.kind === "add" ? head : r.kind === "del" ? base : null;
    if (!side) return;
    side.rows.push(i);
    side.text.push(r.text);
  });
  return { head, base };
}

/** Colours for every code row of `rows`, or an empty map for a language the guide doesn't colour. */
export async function highlightRows(path: string, rows: readonly DiffRow[]): Promise<RowTokens> {
  const lang = grammarFor(path);
  const out = new Map<number, readonly Tok[]>();
  if (lang === null) return out;
  const hl = await core();
  if (!hl.getLoadedLanguages().includes(lang)) await hl.loadLanguage(GRAMMARS[lang]);
  const { head, base } = sides(rows);
  for (const side of [head, base]) {
    if (!side.rows.length) continue;
    tokenizeLines(hl, lang, side.text).forEach((toks, k) => {
      const row = side.rows[k];
      if (row !== undefined) out.set(row, toks);
    });
  }
  return out;
}

/** Highlights per loaded diff, so a file shown again (or in another stop) is coloured at once. */
const cache = new WeakMap<DiffFile, Promise<RowTokens>>();

/** Colours for `file`'s rows; a failure leaves the file plain rather than failing the diff. */
export function tokensFor(file: DiffFile): Promise<RowTokens> {
  let tokens = cache.get(file);
  if (!tokens) {
    const empty: RowTokens = new Map();
    tokens = file.binary
      ? Promise.resolve(empty)
      : highlightRows(file.path, diffRows(file.lines)).catch(() => empty);
    cache.set(file, tokens);
  }
  return tokens;
}
