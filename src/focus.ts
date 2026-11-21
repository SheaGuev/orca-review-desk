// The workspace the person has focused in Orca: which GitHub repository and branch it is, the
// queue item for that branch, and the status bar item that speaks for it.
import type { OrcaWorkerApi } from "orca/worker";
import { message } from "./errors";
import { originSlug } from "./git";
import { canonicalRepo } from "./github";
import type { Tracked } from "./queue-items";
import { statusBar } from "./status-bar";
import type { WorkerState } from "./worker-state";

export type Focus = {
  /** Told when the focused workspace changes; null when none is focused. */
  set: (context: { workspaceId?: string; branch: string } | null) => void;
  /** The GitHub repository and branch of the focused workspace, or null when it has neither. */
  pr: () => Promise<{ repo: string; branch: string } | null>;
  /** The tracked PR whose head is `branch` of `repo`. */
  trackedFor: (repo: string, branch: string) => Tracked | undefined;
  /** Forgets which repository each workspace is, so it is asked again. */
  forget: () => void;
  /** Brings the status bar item up to date; the host hears only changes. */
  showStatusBar: () => Promise<void>;
};

type Deps = {
  host: OrcaWorkerApi["host"];
  state: WorkerState;
  log: (text: string) => void;
};

type Focused = {
  deps: Deps;
  context: { workspaceId?: string; branch: string } | null;
  /** The `origin` slug of a focused workspace, by workspace id. */
  origins: Map<string, string>;
  /** What the status bar was last told. */
  shown: string;
  /** Counts status bar updates, so a slow one never overwrites a newer one. */
  updates: number;
};

async function originOf(f: Focused, workspaceId: string): Promise<string | null> {
  const known = f.origins.get(workspaceId);
  if (known) return known;
  const { workspaces } = await f.deps.host.call("workspace.list");
  const ws = workspaces.find((w) => w.id === workspaceId);
  const origin = ws ? await originSlug(ws.path) : null;
  // Only a found origin is remembered: a workspace that gains one is seen on the next ask.
  if (origin) f.origins.set(workspaceId, origin);
  return origin;
}

async function focusedPr(f: Focused): Promise<{ repo: string; branch: string } | null> {
  const { workspaceId, branch } = f.context ?? {};
  if (!workspaceId || !branch) return null;
  const origin = await originOf(f, workspaceId);
  return origin ? { repo: await canonicalRepo(origin), branch } : null;
}

const trackedFor = (state: WorkerState, repo: string, branch: string): Tracked | undefined =>
  [...state.tracked.values()].find((t) => t.item.repo === repo && t.details.headRefName === branch);

async function showStatusBar(f: Focused): Promise<void> {
  const { host, state } = f.deps;
  const update = ++f.updates;
  try {
    const pr = await focusedPr(f).catch(() => null);
    // Focus moved on while this was looking the workspace up.
    if (update !== f.updates) return;
    const bar = statusBar({
      focused: pr ? trackedFor(state, pr.repo, pr.branch)?.item : undefined,
      onRepo: pr !== null,
      waiting: [...state.tracked.values()].filter((t) => t.item.lane !== "authored").length,
    });
    const next = JSON.stringify(bar);
    if (next === f.shown) return;
    f.shown = next;
    await host.call("statusBar.update", { id: "guide", icon: "gauge", ...bar });
  } catch (e) {
    f.shown = "";
    f.deps.log(`status bar: ${message(e)}`);
  }
}

export function createFocus(deps: Deps): Focus {
  const f: Focused = { deps, context: null, origins: new Map(), shown: "", updates: 0 };
  return {
    pr: () => focusedPr(f),
    trackedFor: (repo, branch) => trackedFor(deps.state, repo, branch),
    set: (context) => {
      f.context = context;
    },
    forget: () => f.origins.clear(),
    showStatusBar: () => showStatusBar(f),
  };
}
