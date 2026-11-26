// Bundled by scripts/vendor-shiki.ts into editor/vendor/shiki/: guide frames have no network and
// no bare imports, so Shiki ships as files beside the editor. Each grammar is its own chunk,
// loaded the first time a file of that language is drawn.
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

export const GRAMMARS = {
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  graphql: () => import("@shikijs/langs/graphql"),
  markdown: () => import("@shikijs/langs/markdown"),
  yaml: () => import("@shikijs/langs/yaml"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  html: () => import("@shikijs/langs/html"),
  python: () => import("@shikijs/langs/python"),
  swift: () => import("@shikijs/langs/swift"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  java: () => import("@shikijs/langs/java"),
  go: () => import("@shikijs/langs/go"),
  rust: () => import("@shikijs/langs/rust"),
  ruby: () => import("@shikijs/langs/ruby"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  sql: () => import("@shikijs/langs/sql"),
  toml: () => import("@shikijs/langs/toml"),
  xml: () => import("@shikijs/langs/xml"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
};

export { createHighlighterCore, createJavaScriptRegexEngine };
