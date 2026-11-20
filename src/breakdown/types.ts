// Vendored from orca-diff-breakdown v0.3.0 (MIT); keep in step with it.
// Only the two types its pure modules share, from its src/protocol.ts; its panel requests are not
// part of this plugin.

export type CategoryId =
  | "runtime"
  | "tests"
  | "contracts"
  | "migrations"
  | "cicd"
  | "config"
  | "dependencies"
  | "docs"
  | "generated";

/** `U` is untracked; the rest are git's name-status letters. */
export type FileStatus = "A" | "M" | "D" | "R" | "C" | "T" | "U";
