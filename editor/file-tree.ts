// The PR's changed files as a folder tree for the rail's Files view. A folder holding only one
// folder is folded into it ("src/models/cci"), as editors show compact folders.

export type TreeNode =
  | { kind: "dir"; name: string; path: string; children: TreeNode[] }
  | { kind: "file"; name: string; path: string };

type Dir = { dirs: Map<string, Dir>; files: string[] };

const emptyDir = (): Dir => ({ dirs: new Map(), files: [] });

function insert(root: Dir, path: string): void {
  const parts = path.split("/");
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    let next = dir.dirs.get(part);
    if (!next) dir.dirs.set(part, (next = emptyDir()));
    dir = next;
  }
  dir.files.push(path);
}

function nodes(dir: Dir, prefix: string): TreeNode[] {
  const dirs = [...dir.dirs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, child]): TreeNode => {
      let label = name;
      let at = child;
      // Fold a chain of single folders into one row.
      while (at.files.length === 0 && at.dirs.size === 1) {
        const only = at.dirs.entries().next().value;
        if (!only) break;
        label = `${label}/${only[0]}`;
        at = only[1];
      }
      const path = `${prefix}${label}`;
      return { kind: "dir", name: label, path, children: nodes(at, `${path}/`) };
    });
  const files = [...dir.files]
    .sort((a, b) => a.localeCompare(b))
    .map((path): TreeNode => ({ kind: "file", name: path.slice(path.lastIndexOf("/") + 1), path }));
  return [...dirs, ...files];
}

/** `paths` as folders first, then files, each level sorted by name. */
export function folderTree(paths: readonly string[]): TreeNode[] {
  const root = emptyDir();
  for (const path of new Set(paths)) insert(root, path);
  return nodes(root, "");
}
