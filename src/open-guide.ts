// Opening a guide in Orca: written to `.pr-tour/pr-<n>.prtour.json` in the repository's
// workspace, kept out of `git status`, and shown in the guide tab.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OrcaWorkerApi } from "orca/worker";
import type { Clones } from "./clones";
import { fail, message } from "./errors";
import { hidePrTourFolders } from "./git";
import type { StoredGuide } from "./store";

export type Opener = {
  /** The Orca workspace of `repo` to open things in: the one on `branch`, else the clone's own. */
  workspaceFor: (repo: string, branch: string | null) => Promise<{ id: string; path: string }>;
  /** Writes the guide into its workspace and opens it there. */
  open: (guide: StoredGuide) => Promise<void>;
  /** Opens a file of `repo` in Orca's own editor. */
  openFile: (repo: string, branch: string | null, path: string) => Promise<void>;
};

export function createOpener(deps: {
  host: OrcaWorkerApi["host"];
  clones: Clones;
  log: (text: string) => void;
}): Opener {
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
    async open(guide) {
      const ws = await workspaceFor(guide.pr.repo, guide.pr.headRef);
      // Orca names the tab after the file, so the name says what it is: "pr-3", not "3".
      const rel = `.pr-tour/pr-${guide.pr.number}.prtour.json`;
      await mkdir(join(ws.path, ".pr-tour"), { recursive: true });
      // Guides used to be written as "<n>.prtour.json"; drop that copy so only one stays.
      await rm(join(ws.path, `.pr-tour/${guide.pr.number}.prtour.json`), { force: true });
      await hidePrTourFolders(ws.path).catch((e: unknown) =>
        deps.log(`could not add PR Tour's folders to git's exclude list: ${message(e)}`),
      );
      await writeFile(join(ws.path, rel), `${JSON.stringify(guide, null, 2)}\n`);
      await host.call("workspace.open", { workspaceId: ws.id });
      await host.call("editor.open", { workspaceId: ws.id, path: rel });
    },
    async openFile(repo, branch, path) {
      const ws = await workspaceFor(repo, branch);
      await host.call("editor.open", { workspaceId: ws.id, path });
    },
  };
}
