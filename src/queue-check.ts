// One check of GitHub: which PRs wait for the person, each one's details and when its review
// was asked for, then the queue rebuilt from them and saved, so a restarted worker lists them
// before its first check.
import { mapLimit } from "./cache";
import type { Clones } from "./clones";
import { message } from "./errors";
import { authorAssociation, GH_AT_ONCE, prDetails, requestTimes, type PrDetails } from "./github";
import type { RepoState } from "./protocol";
import { savedPr, searchLanes, type Found, type PrFound, type Tracked } from "./queue-items";
import type { Settings } from "./settings";
import type { SavedPr, Store } from "./store";
import type { WorkerState } from "./worker-state";

const MAX_PRS = 40;

type Fetched = { key: string; repo: string; details: PrDetails };

type Deps = {
  state: WorkerState;
  store: Store;
  clones: Clones;
  readSettings: () => Promise<Settings>;
  /** The PR as the queue shows it, read from storage and the local clone. */
  itemFor: (pr: PrFound) => Promise<Tracked>;
  /** A PR the last check saved, read again from storage. */
  restoreItem: (saved: SavedPr) => Promise<Tracked>;
  log: (text: string) => void;
};

/**
 * Review-request times per PR head, so GitHub is asked again only after a push; `at` is null when
 * GitHub's answer had none.
 */
type RequestTimes = Map<string, { head: string; at: number | null }>;

/** What the checks remember between them, so GitHub is not asked the same thing each time. */
type Asked = {
  requested: RequestTimes;
  /** Each PR's author_association once read; one that could not be read is asked again. */
  associations: Map<string, string>;
  /** Each PR's details with the search hit's `updatedAt` they were read at; asked again once it moves. */
  details: Map<string, { updatedAt: string; details: PrDetails }>;
};

/** The PR's details, read again only when the search says it changed since they were read. */
async function detailsOf(asked: Asked, key: string, f: Found): Promise<PrDetails> {
  const known = asked.details.get(key);
  if (known && f.hit.updatedAt !== "" && known.updatedAt === f.hit.updatedAt) return known.details;
  const details = await prDetails(f.hit.repo, f.hit.number);
  asked.details.set(key, { updatedAt: f.hit.updatedAt, details });
  return details;
}

/**
 * The PR author's association with the repo, from the search hit when it carries one; not asked
 * for your own PRs, which are trusted.
 */
async function associationOf(asked: Asked, key: string, f: Found): Promise<string | null> {
  if (f.lane === "authored") return null;
  if (f.hit.association) {
    asked.associations.set(key, f.hit.association);
    return f.hit.association;
  }
  const known = asked.associations.get(key);
  if (known) return known;
  const read = await authorAssociation(f.hit.repo, f.hit.number);
  if (read) asked.associations.set(key, read);
  return read;
}

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
  await mapLimit([...byRepo], GH_AT_ONCE, async ([repo, numbers]) => {
    let times: Map<number, number>;
    try {
      times = await requestTimes(repo, numbers, deps.state.settings.teams);
    } catch (e) {
      deps.log(`request times for ${repo}: ${message(e)}`);
      return;
    }
    for (const { key, repo: r, details: d } of list)
      if (r === repo && numbers.includes(d.number))
        requested.set(key, { head: d.headRefOid, at: times.get(d.number) ?? null });
  });
}

/** The repositories of the PRs found, each with whether guides are made in it automatically. */
async function reposOf(store: Store, built: readonly Tracked[]): Promise<RepoState[]> {
  const names = [...new Set(built.map((t) => t.item.repo))];
  const optIns = await Promise.all(names.map((repo) => store.optIn(repo)));
  return names.map((repo, i) => {
    const mine = built.filter((t) => t.item.repo === repo);
    return {
      repo,
      optIn: optIns[i] ?? null,
      hasClone: mine.some((t) => t.item.hasClone),
      pending: mine.length,
    };
  });
}

async function check(deps: Deps, asked: Asked): Promise<void> {
  const { state, store } = deps;
  state.settings = await deps.readSettings();
  state.runsToday = await store.runsToday();
  const [cloneMap, found] = await Promise.all([deps.clones.refresh(), searchLanes(state.settings)]);
  const fetched = await mapLimit([...found].slice(0, MAX_PRS), GH_AT_ONCE, async ([key, f]) => ({
    key,
    repo: f.hit.repo,
    details: await detailsOf(asked, key, f),
    found: f,
    association: await associationOf(asked, key, f),
  }));
  // PRs no longer found are read afresh if they come back.
  const listed = new Set(fetched.map((f) => f.key));
  for (const key of asked.details.keys()) if (!listed.has(key)) asked.details.delete(key);
  const { requested } = asked;
  await askRequestTimes(deps, requested, fetched);
  // One at a time: a guide stored without its skipped files asks git, which may fetch.
  const built = await mapLimit(fetched, 1, ({ key, repo, details: d, found: f, association }) =>
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
      association,
    }),
  );
  const repos = await reposOf(store, built);
  state.tracked.clear();
  for (const t of built) state.tracked.set(t.item.key, t);
  state.repos.clear();
  for (const r of repos) state.repos.set(r.repo, r);
  state.checkedAt = Date.now();
  state.lastError = null;
  state.rateLimit = null;
  await store
    .setLastCheck({
      checkedAt: state.checkedAt,
      prs: built.map((t) => savedPr(t, asked.associations.get(t.item.key))),
    })
    .catch((e: unknown) => deps.log(`could not save the list: ${message(e)}`));
}

/**
 * Lists the PRs the last check saved, with when it ran, until a check works. Nothing is run for
 * them: automatic runs follow a check that worked.
 */
async function restore(deps: Deps, asked: Asked): Promise<void> {
  const { state, store } = deps;
  const saved = await store.lastCheck();
  if (!saved) return;
  for (const p of saved.prs)
    if (p.association && !asked.associations.has(p.key))
      asked.associations.set(p.key, p.association);
  const built = await mapLimit(saved.prs, 1, deps.restoreItem);
  const repos = await reposOf(store, built);
  // A check that worked meanwhile knows better.
  if (state.checkedAt !== null) return;
  for (const t of built) if (!state.tracked.has(t.item.key)) state.tracked.set(t.item.key, t);
  for (const r of repos) if (!state.repos.has(r.repo)) state.repos.set(r.repo, r);
  state.checkedAt = saved.checkedAt;
}

export function createQueueCheck(deps: Deps): {
  check: () => Promise<void>;
  restore: () => Promise<void>;
} {
  const asked: Asked = { requested: new Map(), associations: new Map(), details: new Map() };
  return { check: () => check(deps, asked), restore: () => restore(deps, asked) };
}
