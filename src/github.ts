// What the worker asks GitHub, all through the person's own `gh` sign-in.
import { runOk } from "./exec";
import { repoSlugFromApiUrl } from "./repo";

export type SearchHit = {
  repo: string;
  number: number;
  title: string;
  author: string;
  url: string;
  draft: boolean;
  updatedAt: string;
};

export type PrFile = { path: string; additions: number; deletions: number };

export type PrDetails = {
  number: number;
  title: string;
  body: string;
  author: string;
  url: string;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  files: PrFile[];
};

export type ReviewComment = { id: number; path: string; line: number | null; body: string };

let login: string | null = null;
const canonical = new Map<string, string>();

/**
 * GitHub's current `owner/repo` for a slug read from a git remote. A transferred or renamed repo
 * keeps working through redirects, so a clone's remote can name the old owner while search
 * results name the new one.
 */
export async function canonicalRepo(slug: string): Promise<string> {
  const known = canonical.get(slug);
  if (known) return known;
  try {
    const out = await runOk(
      "gh",
      ["repo", "view", slug, "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      { timeoutMs: 30_000 },
    );
    const name = out.trim().toLowerCase() || slug;
    canonical.set(slug, name);
    return name;
  } catch {
    return slug;
  }
}

export async function currentLogin(): Promise<string> {
  if (!login)
    login = (await runOk("gh", ["api", "user", "--jq", ".login"], { timeoutMs: 30_000 })).trim();
  return login;
}

/** Open PRs matching a GitHub search qualifier such as `user-review-requested:@me`. */
export async function searchPrs(qualifier: string): Promise<SearchHit[]> {
  const q = `is:pr is:open archived:false ${qualifier}`;
  const out = await runOk(
    "gh",
    [
      "api",
      "-X",
      "GET",
      "search/issues",
      "-f",
      `q=${q}`,
      "-f",
      "per_page=50",
      "-f",
      "sort=updated",
    ],
    { timeoutMs: 30_000 },
  );
  const items = (JSON.parse(out).items ?? []) as {
    number: number;
    title: string;
    html_url: string;
    draft?: boolean;
    updated_at: string;
    user?: { login?: string };
    repository_url: string;
  }[];
  return items.map((i) => ({
    repo: repoSlugFromApiUrl(i.repository_url),
    number: i.number,
    title: i.title,
    author: i.user?.login ?? "",
    url: i.html_url,
    draft: Boolean(i.draft),
    updatedAt: i.updated_at,
  }));
}

const DETAIL_FIELDS =
  "number,title,body,author,url,headRefOid,headRefName,baseRefName,isDraft,additions,deletions,changedFiles,createdAt,files";

export async function prDetails(repo: string, ref: string | number): Promise<PrDetails> {
  const out = await runOk("gh", ["pr", "view", String(ref), "-R", repo, "--json", DETAIL_FIELDS], {
    timeoutMs: 30_000,
  });
  const raw = JSON.parse(out);
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    author: raw.author?.login ?? "",
    url: raw.url,
    headRefOid: raw.headRefOid,
    headRefName: raw.headRefName,
    baseRefName: raw.baseRefName,
    isDraft: Boolean(raw.isDraft),
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    changedFiles: raw.changedFiles ?? 0,
    createdAt: raw.createdAt ?? "",
    files: ((raw.files ?? []) as PrFile[]).map((f) => ({
      path: f.path,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
    })),
  };
}

/** Your own inline review comments on a PR, for "Since your last review". */
export async function myReviewComments(repo: string, number: number): Promise<ReviewComment[]> {
  const me = await currentLogin();
  const out = await runOk(
    "gh",
    [
      "api",
      "--paginate",
      `repos/${repo}/pulls/${number}/comments`,
      "--jq",
      `.[] | select(.user.login == "${me}") | {id, path, line, body}`,
    ],
    { timeoutMs: 30_000 },
  );
  return out
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ReviewComment);
}

type TimelineNode = {
  __typename?: string;
  createdAt?: string;
  requestedReviewer?: { __typename?: string; login?: string; slug?: string } | null;
};
type PrTimeline = { createdAt?: string; timelineItems?: { nodes?: (TimelineNode | null)[] } };

/**
 * When your review was asked for: the latest request naming you or one of your teams, else the
 * latest ready-for-review, else when the PR was opened. Milliseconds, or null when unknown.
 */
export function requestedAtFrom(
  pr: PrTimeline | null | undefined,
  me: string,
  teams: readonly string[],
): number | null {
  if (!pr) return null;
  const slugs = new Set(teams.map((t) => (t.split("/").pop() ?? t).toLowerCase()));
  const nodes = (pr.timelineItems?.nodes ?? []).filter((n): n is TimelineNode => Boolean(n));
  const latest = (list: TimelineNode[]) =>
    list.reduce<number | null>((best, n) => {
      const t = n.createdAt ? Date.parse(n.createdAt) : NaN;
      return Number.isFinite(t) && (best === null || t > best) ? t : best;
    }, null);
  const mine = nodes.filter((n) => {
    if (n.__typename !== "ReviewRequestedEvent") return false;
    const r = n.requestedReviewer;
    return (
      (r?.login && r.login.toLowerCase() === me.toLowerCase()) ||
      (r?.slug && slugs.has(r.slug.toLowerCase()))
    );
  });
  const ready = nodes.filter((n) => n.__typename === "ReadyForReviewEvent");
  const created = pr.createdAt ? Date.parse(pr.createdAt) : NaN;
  return latest(mine) ?? latest(ready) ?? (Number.isFinite(created) ? created : null);
}

/** One GraphQL query per repository, an alias per PR, for review-request times. */
export async function requestTimes(
  repo: string,
  numbers: readonly number[],
  teams: readonly string[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!numbers.length) return out;
  const [owner, name] = repo.split("/");
  const fields = numbers
    .map(
      (n) => `pr${n}: pullRequest(number: ${n}) {
      createdAt
      timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT, READY_FOR_REVIEW_EVENT], last: 20) {
        nodes {
          __typename
          ... on ReviewRequestedEvent { createdAt requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
          ... on ReadyForReviewEvent { createdAt }
        }
      }
    }`,
    )
    .join("\n");
  const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;
  const raw = await runOk(
    "gh",
    ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`],
    { timeoutMs: 30_000 },
  );
  const repository = (JSON.parse(raw)?.data?.repository ?? {}) as Record<string, PrTimeline>;
  const me = await currentLogin();
  for (const n of numbers) {
    const at = requestedAtFrom(repository[`pr${n}`], me, teams);
    if (at !== null) out.set(n, at);
  }
  return out;
}
