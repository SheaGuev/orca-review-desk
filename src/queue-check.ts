// One check of GitHub: which PRs wait for the person, each one's details and when its review
// was asked for, then the queue rebuilt from them and saved, so a restarted worker lists them
// before its first check.
import { mapLimit } from "./cache";
import type { Clones } from "./clones";
import { message } from "./errors";
import type { Clone } from "./git";
import {
  authorAssociation,
  GH_AT_ONCE,
  myLatestReview,
  prDetails,
  requestTimes,
  type PrDetails,
} from "./github";
import type { RepoState } from "./protocol";
import { savedPr, searchLanes, type Found, type PrFound, type Tracked } from "./queue-items";
import type { Settings } from "./settings";
import type { SavedPr, Store } from "./store";
import type { WorkerState } from "./worker-state";

const MAX_PRS = 40;

type Fetched = { key: string; repo: string; details: PrDetails };

type Review = { at: number; commit: string };

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
  /** Recently reviewed PRs: your latest review, read again once the search hit's `updatedAt` moves. */
  reviews: Map<string, { updatedAt: string; review: Review | null }>;
};

/** The PR's details, read again only when the search says it changed since they were read. */
async function detailsOf(asked: Asked, key: string, f: Found): Promise<PrDetails> {
  const known = asked.details.get(key);
  if (known && f.hit.updatedAt !== "" && known.updatedAt === f.hit.updatedAt) return known.details;
  const details = await prDetails(f.hit.repo, f.hit.number);
  asked.details.set(key, { updatedAt: f.hit.updatedAt, details });
  return details;
}

/** Your latest review of a Recently reviewed PR; null for other lanes, or when it can't be read. */
async function reviewOf(asked: Asked, key: string, f: Found): Promise<Review | null> {
  if (f.lane !== "recent") return null;
  const known = asked.reviews.get(key);
  if (known && f.hit.updatedAt !== "" && known.updatedAt === f.hit.updatedAt) return known.review;
  const review = await myLatestReview(f.hit.repo, f.hit.number).catch(() => undefined);
  // A failed read is asked again next check rather than remembered as "never reviewed".
  if (review === undefined) return null;
  asked.reviews.set(key, { updatedAt: f.hit.updatedAt, review });
  return review;
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

/**
 * The repositories of the PRs found, each with whether guides are made in it automatically. PRs
 * you reviewed already never get automatic guides, so they ask nobody to turn a repository on.
 */
async function reposOf(store: Store, all: readonly Tracked[]): Promise<RepoState[]> {
  const built = all.filter((t) => t.item.lane !== "recent");
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

type FetchedPr = Fetched & { found: Found; association: string | null; review: Review | null };

/** A found PR as the queue builds its row from. */
function prFound(
  p: FetchedPr,
  clone: Clone | null,
  requested: RequestTimes,
): Parameters<Deps["itemFor"]>[0] {
  const { key, repo, details: d, found: f, review } = p;
  return {
    key,
    repo,
    lane: f.lane,
    details: d,
    clone,
    team: f.team,
    // When your review was last given or asked for, else when the PR was opened, so it still orders.
    requestedAt:
      review?.at ??
      requested.get(key)?.at ??
      (Date.parse(d.createdAt) || Date.parse(f.hit.updatedAt) || Date.now()),
    association: p.association,
    lastReview: review
      ? { at: review.at, newCommits: review.commit !== "" && review.commit !== d.headRefOid }
      : null,
  };
}

/** Forgets what was asked about PRs no longer found, so they are read afresh if they come back. */
function forgetGone(asked: Asked, listed: ReadonlySet<string>): void {
  for (const map of [asked.details, asked.associations, asked.reviews])
    for (const key of map.keys()) if (!listed.has(key)) map.delete(key);
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
    review: await reviewOf(asked, key, f),
  }));
  forgetGone(asked, new Set(fetched.map((f) => f.key)));
  const { requested } = asked;
  await askRequestTimes(
    deps,
    requested,
    fetched.filter((f) => f.found.lane !== "recent"),
  );
  // One at a time: a guide stored without its skipped files asks git, which may fetch.
  const built = await mapLimit(fetched, 1, (p) =>
    deps.itemFor(prFound(p, cloneMap.get(p.repo) ?? null, requested)),
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
  const asked: Asked = {
    requested: new Map(),
    associations: new Map(),
    details: new Map(),
    reviews: new Map(),
  };
  return { check: () => check(deps, asked), restore: () => restore(deps, asked) };
}
