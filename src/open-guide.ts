// Opening a guide in Orca: written to `.orca/pr-review/pr-<n>.prreview.json` in the repository's
// workspace, kept out of `git status`, and shown in the guide tab. Under `.orca/` because Orca's
// dev watcher skips it: opening a guide of Review Desk's own repo must not reload the dev plugin.
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OrcaWorkerApi } from "orca/worker";
import type { Clones } from "./clones";
import { fail, message } from "./errors";
import { hideOwnFolders } from "./git";
import { GUIDES, ORCA, realFolder } from "./run-files";
import type { StoredGuide } from "./store";

const guideFile = (pr: number): string => `${GUIDES}/pr-${pr}.prreview.json`;

export type Opener = {
  /** The Orca workspace of `repo` to open things in: the one on `branch`, else the clone's own. */
  workspaceFor: (repo: string, branch: string | null) => Promise<{ id: string; path: string }>;
  /** Writes the guide into `workspace` (else its repository's) and opens it there. */
  open: (guide: StoredGuide, workspace?: { id: string; path: string }) => Promise<void>;
  /** Rewrites the copies of the guide already in its repository's workspaces, as a run replaced it. */
  syncCopies: (guide: StoredGuide) => Promise<void>;
  /** Opens a file of `repo` in Orca's own editor. */
  openFile: (repo: string, branch: string | null, path: string) => Promise<void>;
};

type OpenerDeps = {
  host: OrcaWorkerApi["host"];
  clones: Clones;
  log: (text: string) => void;
};

/** Writes the guide into the workspace at `path`; answers the file's path in it. */
async function writeGuide(
  path: string,
  guide: StoredGuide,
  log: (text: string) => void,
): Promise<string> {
  // Orca names the tab after the file, so the name says what it is: "pr-3", not "3".
  const rel = guideFile(guide.pr.number);
  // Refuses a linked `.orca` or `.orca/pr-review`, which would write outside the workspace.
  await realFolder(join(path, ORCA));
  await realFolder(join(path, GUIDES));
  await hideOwnFolders(path).catch((e: unknown) =>
    log(`could not add Review Desk's folders to git's exclude list: ${message(e)}`),
  );
  await writeFile(join(path, rel), `${JSON.stringify(guide, null, 2)}\n`);
  return rel;
}

/** Rewrites the guide in each of its repository's workspaces that already holds a copy. */
async function syncCopies(deps: OpenerDeps, guide: StoredGuide): Promise<void> {
  const clone = await deps.clones.find(guide.pr.repo);
  if (!clone) return;
  const { workspaces } = await deps.host.call("workspace.list");
  for (const w of workspaces) {
    if (w.projectId !== clone.projectId || (w.hostId && w.hostId !== "local")) continue;
    const had = await access(join(w.path, guideFile(guide.pr.number))).then(
      () => true,
      () => false,
    );
    if (had) await writeGuide(w.path, guide, deps.log);
  }
}

export function createOpener(deps: OpenerDeps): Opener {
  const { host } = deps;

  const workspaceFor: Opener["workspaceFor"] = async (repo, branch) => {
    const clone = await deps.clones.find(repo);
    if (!clone) throw fail("unavailable", `No local clone of ${repo} in Orca`);
    const { workspaces } = await host.call("workspace.list");
    const mine = workspaces.filter(
      (w) => w.projectId === clone.projectId && (!w.hostId || w.hostId === "local"),
    );
    const pick =
      mine.find((w) => branch && w.branch === branch) ??
      mine.find((w) => w.path === clone.path) ??
      mine[0];
    if (!pick) throw fail("unavailable", `No Orca workspace for ${repo}`);
    return { id: pick.id, path: pick.path };
  };

  return {
    workspaceFor,
    async open(guide, workspace) {
      const ws = workspace ?? (await workspaceFor(guide.pr.repo, guide.pr.headRef));
      const rel = await writeGuide(ws.path, guide, deps.log);
      await host.call("workspace.open", { workspaceId: ws.id });
      await host.call("editor.open", { workspaceId: ws.id, path: rel });
    },
    syncCopies: (guide) => syncCopies(deps, guide),
    async openFile(repo, branch, path) {
      const ws = await workspaceFor(repo, branch);
      await host.call("editor.open", { workspaceId: ws.id, path });
    },
  };
}
