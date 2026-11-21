// Vendored from orca-diff-breakdown v0.3.0 (MIT); keep in step with it.
// Which Catppuccin icon a file gets, from its name alone.
import { FILE_EXTENSIONS, FILE_NAMES } from "./associations";
import type { IconName } from "./svgs";

/** Ours, before upstream's lists: config variants such as vite.config.screenshot.ts. */
const OUR_NAMES: [RegExp, IconName][] = [
  [/^vite\.config\.(?:[^.]+\.)*[cm]?[jt]s$/, "vite"],
  [/^vitest\.config\.(?:[^.]+\.)*[cm]?[jt]s$/, "vitest"],
];

/**
 * A file name's icon: our additions, then the exact name, then the longest matching extension
 * ("test.tsx" before "tsx", "d.ts" before "ts"), then the plain file icon. Case doesn't matter.
 */
export function fileIcon(fileName: string): IconName {
  const name = fileName.toLowerCase();
  for (const [pattern, icon] of OUR_NAMES) if (pattern.test(name)) return icon;
  // hasOwn, so a file named "constructor" doesn't find Object.prototype's.
  const byName = Object.hasOwn(FILE_NAMES, name) ? FILE_NAMES[name] : undefined;
  if (byName) return byName;
  const parts = name.split(".");
  for (let i = 1; i < parts.length; i++) {
    const extension = parts.slice(i).join(".");
    const byExtension = Object.hasOwn(FILE_EXTENSIONS, extension)
      ? FILE_EXTENSIONS[extension]
      : undefined;
    if (byExtension) return byExtension;
  }
  return "_file";
}
