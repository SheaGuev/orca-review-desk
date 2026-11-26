// Where an import in a PR's diff points at the PR's head commit: a relative path, or a file in one
// of the repository's own workspace packages, found in that commit's file list (no checkout
// needed). tsconfig `paths` and node_modules are not followed.

/** A resolved file, or why there is none: a package from outside the repo, or nothing matching. */
export type ImportTarget = { path: string } | { reason: "external" | "not-found" };

/** A package.json at the commit: its folder ("" for the root), name, and entry points. */
export type WorkspacePackage = { dir: string; name: string; entries: string[] };

export type RepoIndex = { files: ReadonlySet<string>; packages: readonly WorkspacePackage[] };

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".d.ts"];
/** TypeScript's ESM style imports `./a.js` for `a.ts`; each JS extension and its TS sources. */
const TS_FOR_JS: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

/** `a/./b/../c` as `a/c`; null when it climbs above the repository root. */
export function normalize(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** The file `base` names: as written, with an extension added, as a folder's index, or a JS import of a TS file. */
function fileAt(files: ReadonlySet<string>, base: string): string | null {
  if (files.has(base)) return base;
  for (const ext of EXTENSIONS) if (files.has(`${base}${ext}`)) return `${base}${ext}`;
  const prefix = base ? `${base}/index` : "index";
  for (const ext of EXTENSIONS) if (files.has(`${prefix}${ext}`)) return `${prefix}${ext}`;
  const js = /\.[cm]?jsx?$/.exec(base)?.[0];
  if (!js) return null;
  for (const ext of TS_FOR_JS[js] ?? []) {
    const ts = `${base.slice(0, -js.length)}${ext}`;
    if (files.has(ts)) return ts;
  }
  return null;
}

/** A bare specifier's package name and the path inside it: `@a/b/c/d` is `@a/b` and `c/d`. */
export function packagePart(specifier: string): { name: string; sub: string } {
  const parts = specifier.split("/");
  const take = specifier.startsWith("@") ? 2 : 1;
  return { name: parts.slice(0, take).join("/"), sub: parts.slice(take).join("/") };
}

function inPackage(index: RepoIndex, pkg: WorkspacePackage, sub: string): string | null {
  const root = (rel: string) => normalize(pkg.dir ? `${pkg.dir}/${rel}` : rel);
  if (sub) {
    const base = root(sub);
    return base === null ? null : fileAt(index.files, base);
  }
  for (const entry of pkg.entries) {
    const base = root(entry);
    const found = base === null ? null : fileAt(index.files, base);
    if (found) return found;
  }
  return fileAt(index.files, pkg.dir);
}

/** Where `specifier`, imported from the file at `from`, points in `index`. */
export function resolveImport(index: RepoIndex, from: string, specifier: string): ImportTarget {
  const relative = specifier === "." || specifier === ".." || /^\.\.?\//.test(specifier);
  if (relative) {
    const base = normalize(`${dirOf(from)}/${specifier}`);
    const found = base === null ? null : fileAt(index.files, base);
    return found ? { path: found } : { reason: "not-found" };
  }
  if (specifier.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(specifier))
    return { reason: "external" };
  const { name, sub } = packagePart(specifier);
  const pkg = index.packages.find((p) => p.name === name);
  if (!pkg) return { reason: "external" };
  const found = inPackage(index, pkg, sub);
  return found ? { path: found } : { reason: "not-found" };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The `exports` entry for the package root, when it is a plain path or a condition map of paths. */
function rootExport(exports: unknown): string[] {
  if (typeof exports === "string") return [exports];
  if (!isObj(exports)) return [];
  const dot = "." in exports ? exports["."] : exports;
  if (typeof dot === "string") return [dot];
  if (!isObj(dot)) return [];
  return ["types", "import", "require", "default"]
    .map((k) => dot[k])
    .filter((v): v is string => typeof v === "string");
}

/** A package.json's name and entry points, or null when it isn't a named package. */
export function workspacePackage(path: string, json: unknown): WorkspacePackage | null {
  if (!isObj(json) || typeof json.name !== "string" || !json.name) return null;
  const entries = [json.types, json.typings, json.main]
    .filter((v): v is string => typeof v === "string")
    .concat(rootExport(json.exports));
  return { dir: dirOf(path), name: json.name, entries };
}

/** The commit's package.json files that can be workspace packages (none inside node_modules). */
export const packageFiles = (files: readonly string[]): string[] =>
  files.filter(
    (f) =>
      (f === "package.json" || f.endsWith("/package.json")) &&
      !f.split("/").includes("node_modules"),
  );
