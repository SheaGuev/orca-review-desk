// One check of GitHub: which PRs wait for the person, each one's details and when its review
// was asked for, then the queue rebuilt from them.
import { mapLimit } from "./cache";
import type { Clones } from "./clones";
import { message } from "./errors";
import { prDetails, requestTimes, type PrDetails } from "./github";
import { searchLanes, type PrFound, type Tracked } from "./queue-items";
import type { Settings } from "./settings";
import type { Store } from "./store";
import type { WorkerState } from "./worker-state";

const MAX_PRS = 40;
/** `gh` calls made at once while checking the queue. */
const GH_AT_ONCE = 6;

type Fetched = { key: string; repo: string; details: PrDetails };

type Deps = {
  state: WorkerState;
  store: Store;
  clones: Clones;
  readSettings: () => Promise<Settings>;
  /** The PR as the queue shows it, read from storage and the local clone. */
  itemFor: (pr: PrFound) => Promise<Tracked>;
  log: (text: string) => void;
};

/** Review-request times per PR head, so GitHub is asked again only after a push. */
type RequestTimes = Map<string, { head: string; at: number }>;

/**
 * Asks GitHub when each PR's review was requested, one GraphQL query per repository, for the
 * PRs whose head moved since it was last asked. A failed query leaves those PRs without a time.
 */
async function askRequestTimes(
  deps: Deps,
  requested: RequestTimes,
  list: readonly Fetched[],
): Promise<void> {
  const byRepo = new Map<string, number[]>();
  for (const { key, repo, details: d } of list) {
    if (requested.get(key)?.head === d.headRefOid) continue;
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), d.number]);
  }
  await Promise.all(
    [...byRepo].map(async ([repo, numbers]) => {
      const times = await requestTimes(repo, numbers, deps.state.settings.teams).catch(
        (e: unknown) => {
          deps.log(`request times for ${repo}: ${message(e)}`);
          return new Map<number, number>();
        },
      );
      for (const { key, repo: r, details: d } of list) {
        const at = r === repo ? times.get(d.number) : undefined;
        if (at !== undefined) requested.set(key, { head: d.headRefOid, at });
      }
    }),
  );
}

/** The repositories of the PRs found, each with whether guides are made in it automatically. */
async function readRepos(deps: Deps, built: readonly Tracked[]): Promise<void> {
  const { state, store } = deps;
  const names = [...new Set(built.map((t) => t.item.repo))];
  const optIns = await Promise.all(names.map((repo) => store.optIn(repo)));
  state.repos.clear();
  names.forEach((repo, i) => {
    const mine = built.filter((t) => t.item.repo === repo);
    state.repos.set(repo, {
      repo,
      optIn: optIns[i] ?? null,
      hasClone: mine.some((t) => t.clone !== null),
      pending: mine.length,
    });
  });
}

async function check(deps: Deps, requested: RequestTimes): Promise<void> {
  const { state, store } = deps;
  state.settings = await deps.readSettings();
  state.runsToday = await store.runsToday();
  const [cloneMap, found] = await Promise.all([deps.clones.refresh(), searchLanes(state.settings)]);
  const fetched = await mapLimit([...found].slice(0, MAX_PRS), GH_AT_ONCE, async ([key, f]) => ({
    key,
    repo: f.hit.repo,
    details: await prDetails(f.hit.repo, f.hit.number),
    found: f,
  }));
  await askRequestTimes(deps, requested, fetched);
  // One at a time: a guide stored without its skipped files asks git, which may fetch.
  const built = await mapLimit(fetched, 1, ({ key, repo, details: d, found: f }) =>
    deps.itemFor({
      key,
      repo,
      lane: f.lane,
      details: d,
      clone: cloneMap.get(repo) ?? null,
      team: f.team,
      // When the review was asked for, else when the PR was opened, so the queue still orders.
      requestedAt:
        requested.get(key)?.at ??
        (Date.parse(d.createdAt) || Date.parse(f.hit.updatedAt) || Date.now()),
    }),
  );
  state.tracked.clear();
  for (const t of built) state.tracked.set(t.item.key, t);
  await readRepos(deps, built);
  state.checkedAt = Date.now();
  state.lastError = null;
}

export function createQueueCheck(deps: Deps): () => Promise<void> {
  const requested: RequestTimes = new Map();
  return () => check(deps, requested);
}
