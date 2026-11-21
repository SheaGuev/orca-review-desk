// Which local clone holds which GitHub repository: the git projects added to Orca on this
// machine, by the repository their `origin` names today.
import { mapLimit } from "./cache";
import { originSlug, type Clone } from "./git";
import { canonicalRepo } from "./github";

export type Project = { id: string; kind: "git" | "folder"; hostId: string | null; path: string };

/** Projects asked about at once: each costs a `git remote` and, the first time, a `gh repo view`. */
const LOOKUPS_AT_ONCE = 8;
/** A repository with no clone is looked for again at most this often. */
const MISS_RETRY_MS = 10_000;

export type Clones = {
  /** Reads Orca's projects again; the queue check does this, so a new project shows within one. */
  refresh(): Promise<ReadonlyMap<string, Clone>>;
  /** The clone of `repo` as last read, reading again once when it is not among them. */
  find(repo: string): Promise<Clone | null>;
};

export function createClones(listProjects: () => Promise<readonly Project[]>): Clones {
  let known: Promise<ReadonlyMap<string, Clone>> | null = null;
  let readAt = 0;

  async function read(): Promise<ReadonlyMap<string, Clone>> {
    const local = (await listProjects()).filter(
      (p) => p.kind === "git" && (!p.hostId || p.hostId === "local"),
    );
    const slugs = await mapLimit(local, LOOKUPS_AT_ONCE, async (p) => {
      const raw = await originSlug(p.path);
      return raw ? canonicalRepo(raw) : null;
    });
    const clones = new Map<string, Clone>();
    // The first project listed for a repository wins, as Orca orders them.
    local.forEach((p, i) => {
      const slug = slugs[i];
      if (slug && !clones.has(slug)) clones.set(slug, { path: p.path, projectId: p.id });
    });
    return clones;
  }

  function refresh(): Promise<ReadonlyMap<string, Clone>> {
    const reading = read();
    known = reading;
    readAt = Date.now();
    reading.catch(() => {
      if (known === reading) known = null;
    });
    return reading;
  }

  return {
    refresh,
    async find(repo) {
      const cached = known ? (await known).get(repo) : undefined;
      if (cached || (known && Date.now() - readAt < MISS_RETRY_MS)) return cached ?? null;
      return (await refresh()).get(repo) ?? null;
    },
  };
}
