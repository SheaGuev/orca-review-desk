// The parts of the bundled Shiki (scripts/shiki/entry.ts) the guide tab uses.

export type GrammarId =
  | "typescript" | "tsx" | "javascript" | "jsx" | "json" | "graphql" | "markdown" | "yaml"
  | "css" | "scss" | "html" | "python" | "swift" | "kotlin" | "java" | "go" | "rust" | "ruby"
  | "shellscript" | "sql" | "toml" | "xml" | "dockerfile";

export type Grammar = () => Promise<unknown>;
export declare const GRAMMARS: Readonly<Record<GrammarId, Grammar>>;

type ThemeRule = {
  readonly scope?: string | readonly string[];
  readonly settings: { readonly foreground?: string; readonly background?: string; readonly fontStyle?: string };
};
export type ShikiTheme = {
  readonly name: string;
  readonly type: "dark" | "light";
  readonly colors?: Readonly<Record<string, string>>;
  readonly fg?: string;
  readonly bg?: string;
  readonly settings: readonly ThemeRule[];
};

/** Bit flags: 1 italic, 2 bold, 4 underline, 8 strikethrough; -1 when unset. */
export type TokenStyles = { color?: string; fontStyle?: number };
export type ThemedTokenWithVariants = {
  content: string;
  offset: number;
  variants: Record<string, TokenStyles>;
};

export type HighlighterCore = {
  loadLanguage: (...langs: Grammar[]) => Promise<void>;
  getLoadedLanguages: () => string[];
  codeToTokensWithThemes: (
    code: string,
    options: { lang: string; themes: Record<string, string> },
  ) => ThemedTokenWithVariants[][];
};

export declare function createHighlighterCore(options: {
  themes: readonly ShikiTheme[];
  langs: readonly Grammar[];
  engine: unknown;
}): Promise<HighlighterCore>;

export declare function createJavaScriptRegexEngine(options?: { forgiving?: boolean }): unknown;
