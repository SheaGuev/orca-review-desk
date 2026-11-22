// What the worker asks GitHub, all through the person's own `gh` sign-in.
import { runOk } from "./exec";
import { asList, asNumber, asObj, asString, isObj, parseJson } from "./json";
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
  return asList(asObj(parseJson(out)).items).flatMap((item): SearchHit[] => {
    // A hit without a number or a repository is no PR the queue could show.
    if (!isObj(item) || typeof item.number !== "number") return [];
    const repo = repoSlugFromApiUrl(asString(item.repository_url));
    if (!repo) return [];
    return [
      {
        repo,
        number: item.number,
        title: asString(item.title),
        author: asString(asObj(item.user).login),
        url: asString(item.html_url),
        draft: item.draft === true,
        updatedAt: asString(item.updated_at),
      },
    ];
  });
}

const DETAIL_FIELDS =
  "number,title,body,author,url,headRefOid,headRefName,baseRefName,isDraft,additions,deletions,changedFiles,createdAt,files";

export async function prDetails(repo: string, ref: string | number): Promise<PrDetails> {
  const out = await runOk("gh", ["pr", "view", String(ref), "-R", repo, "--json", DETAIL_FIELDS], {
    timeoutMs: 30_000,
  });
  return prDetailsFrom(parseJson(out), `${repo} ${ref}`);
}

/** `gh pr view --json` output as PrDetails; throws when it lacks what every later step needs. */
export function prDetailsFrom(raw: unknown, what: string): PrDetails {
  if (
    !isObj(raw) ||
    typeof raw.number !== "number" ||
    typeof raw.headRefOid !== "string" ||
    typeof raw.headRefName !== "string" ||
    typeof raw.baseRefName !== "string"
  )
    throw new Error(`gh pr view ${what}: the reply has no number, head or base`);
  return {
    number: raw.number,
    title: asString(raw.title),
    body: asString(raw.body),
    author: asString(asObj(raw.author).login),
    url: asString(raw.url),
    headRefOid: raw.headRefOid,
    headRefName: raw.headRefName,
    baseRefName: raw.baseRefName,
    isDraft: raw.isDraft === true,
    additions: asNumber(raw.additions),
    deletions: asNumber(raw.deletions),
    changedFiles: asNumber(raw.changedFiles),
    createdAt: asString(raw.createdAt),
    files: asList(raw.files).flatMap((f): PrFile[] =>
      isObj(f) && typeof f.path === "string"
        ? [{ path: f.path, additions: asNumber(f.additions), deletions: asNumber(f.deletions) }]
        : [],
    ),
  };
}

/**
 * GitHub's `author_association` for a PR (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, ...),
 * which `gh pr view --json` does not offer; null when it could not be read.
 */
export async function authorAssociation(repo: string, number: number): Promise<string | null> {
  try {
    const out = await runOk(
      "gh",
      ["api", `repos/${repo}/pulls/${number}`, "--jq", ".author_association"],
      { timeoutMs: 30_000 },
    );
    return out.trim().toUpperCase() || null;
  } catch {
    return null;
  }
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
    .flatMap((l): ReviewComment[] => {
      const c = parseJson(l);
      if (!isObj(c) || typeof c.id !== "number" || typeof c.path !== "string") return [];
      return [
        {
          id: c.id,
          path: c.path,
          line: typeof c.line === "number" ? c.line : null,
          body: asString(c.body),
        },
      ];
    });
}

/** One timeline event as the queue reads it: its kind, when, and who was asked. */
type TimelineNode = { kind: string; at: number | null; login: string; slug: string };

const timeOf = (v: unknown): number | null => {
  const t = typeof v === "string" ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) ? t : null;
};

function timelineNodes(pr: Record<string, unknown>): TimelineNode[] {
  return asList(asObj(pr.timelineItems).nodes).flatMap((n): TimelineNode[] => {
    if (!isObj(n)) return [];
    const reviewer = asObj(n.requestedReviewer);
    return [
      {
        kind: asString(n.__typename),
        at: timeOf(n.createdAt),
        login: asString(reviewer.login).toLowerCase(),
        slug: asString(reviewer.slug).toLowerCase(),
      },
    ];
  });
}

const latest = (nodes: readonly TimelineNode[]): number | null =>
  nodes.reduce<number | null>(
    (best, n) => (n.at !== null && (best === null || n.at > best) ? n.at : best),
    null,
  );

/**
 * When your review was asked for: the latest request naming you or one of your teams, else the
 * latest ready-for-review, else when the PR was opened. Milliseconds, or null when unknown.
 */
export function requestedAtFrom(pr: unknown, me: string, teams: readonly string[]): number | null {
  if (!isObj(pr)) return null;
  const slugs = new Set(teams.map((t) => (t.split("/").pop() ?? t).toLowerCase()));
  const nodes = timelineNodes(pr);
  const mine = nodes.filter(
    (n) =>
      n.kind === "ReviewRequestedEvent" &&
      ((n.login !== "" && n.login === me.toLowerCase()) || (n.slug !== "" && slugs.has(n.slug))),
  );
  const ready = nodes.filter((n) => n.kind === "ReadyForReviewEvent");
  return latest(mine) ?? latest(ready) ?? timeOf(pr.createdAt);
}

/** One GraphQL query per repository, an alias per PR, for review-request times. */
export async function requestTimes(
  repo: string,
  numbers: readonly number[],
  teams: readonly string[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!numbers.length) return out;
  const [owner = "", name = ""] = repo.split("/");
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
  const repository = asObj(asObj(asObj(parseJson(raw)).data).repository);
  const me = await currentLogin();
  for (const n of numbers) {
    const at = requestedAtFrom(repository[`pr${n}`], me, teams);
    if (at !== null) out.set(n, at);
  }
  return out;
}
