// Syntax colours for a file's diff rows. Each side is tokenized as one text (the PR head: unchanged
// and added lines; the base: unchanged and removed lines), so a construct spanning lines inside a
// hunk is coloured as in the file. One that crosses a hunk edge can be coloured wrongly, as on
// GitHub. Every code theme is tokenized at once, so switching themes only changes CSS.
import { diffRows, type DiffFile, type DiffRow, type FileLines } from "../src/diff-model";
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

/**
 * Each hunk's two sides, in order: the PR head (unchanged and added rows) and the base (unchanged
 * and removed rows). Why per hunk: the lines between hunks aren't in the diff, so a comment or
 * string a hunk leaves open would otherwise colour every hunk after it.
 */
export function hunkSides(rows: readonly DiffRow[]): { head: Side; base: Side }[] {
  const hunks: { head: Side; base: Side }[] = [];
  rows.forEach((r, i) => {
    if (r.kind === "eof") return;
    if (r.kind === "hunk" || !hunks.length)
      hunks.push({ head: { rows: [], text: [] }, base: { rows: [], text: [] } });
    if (r.kind === "hunk") return;
    const hunk = hunks[hunks.length - 1];
    if (!hunk) return;
    for (const side of r.kind === "ctx"
      ? [hunk.head, hunk.base]
      : [r.kind === "add" ? hunk.head : hunk.base]) {
      side.rows.push(i);
      side.text.push(r.text);
    }
  });
  return hunks;
}

/** Colours for every code row of `rows`, or an empty map for a language the guide doesn't colour. */
export async function highlightRows(path: string, rows: readonly DiffRow[]): Promise<RowTokens> {
  const lang = grammarFor(path);
  const out = new Map<number, readonly Tok[]>();
  if (lang === null) return out;
  const hl = await core();
  if (!hl.getLoadedLanguages().includes(lang)) await hl.loadLanguage(GRAMMARS[lang]);
  // Base before head, so an unchanged row keeps the colours its head side gives it.
  for (const side of hunkSides(rows).flatMap((h) => [h.base, h.head])) {
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

/** Past this many lines a file's own text is left plain: colouring it all would stall the tab. */
const TEXT_HIGHLIGHT_LIMIT = 10_000;

const textCache = new WeakMap<FileLines, Promise<readonly (readonly Tok[])[]>>();

/**
 * Colours for each line of a file's PR-head text (index = line - 1), for the unchanged lines
 * drawn between hunks. Tokenized as one text, so they are coloured as in the file.
 */
export function tokensForText(path: string, text: FileLines): Promise<readonly (readonly Tok[])[]> {
  let tokens = textCache.get(text);
  if (!tokens) {
    const lang = grammarFor(path);
    tokens =
      lang === null || !text.lines.length || text.lines.length > TEXT_HIGHLIGHT_LIMIT
        ? Promise.resolve([])
        : core()
            .then(async (hl) => {
              if (!hl.getLoadedLanguages().includes(lang)) await hl.loadLanguage(GRAMMARS[lang]);
              return tokenizeLines(hl, lang, text.lines);
            })
            .catch(() => []);
    textCache.set(text, tokens);
  }
  return tokens;
}
