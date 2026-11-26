// Review Desk in Orca's right sidebar: tabs for the reviews you owe (in the order to do them),
// PRs to re-review, and your own, each PR a card with its one next action. All state comes from the worker (src/worker.ts); order from src/queue.ts.
import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  Collapsible,
  EmptyState,
  Heading,
  IconButton,
  plugin,
  read,
  RelativeTime,
  Row,
  set,
  Skeleton,
  Spinner,
  Stack,
  Tab,
  Tabs,
  Text,
  type PanelContext,
  type Tone,
} from "orca";
import { failureReason } from "./failure";
import { message } from "./errors";
import type { OpenResult, QueueItem, QueueState, RepoState, WorktreeChoice } from "./protocol";
import { RISK_WORD, type RiskLevel } from "./schema";

const queue = atom<QueueState | null>(null);
const failure = atom<string | null>(null);
/** A guide waiting on the person's answer: no worktree is on its PR's branch. */
const asking = atom<{ item: QueueItem; branch: string } | null>(null);
/** What the last open said about where the guide opened, for that PR. */
const openNotes = atom<{ key: string; notes: string[] } | null>(null);

const RISK_TONE: Record<RiskLevel, Tone> = { high: "danger", medium: "warning", low: "success" };

/** Runs a request; a failure shows in the panel's "That didn't work" callout. */
async function act(run: () => Promise<unknown>): Promise<void> {
  set(failure, null);
  try {
    await run();
  } catch (error) {
    set(failure, message(error));
  }
}

/** Runs a request the worker answers with the queue, and shows that queue. */
const actOnQueue = (run: () => Promise<QueueState>): Promise<void> =>
  act(async () => set(queue, await run()));

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on("queue.changed", (state) => set(queue, state)));
  void actOnQueue(() => plugin.request("queue.get"));
}

const generate = (item: QueueItem) => () =>
  actOnQueue(() => plugin.request("guide.generate", { key: item.key }));
/** Opens a guide, or asks about a worktree first when the worker says none is on the branch. */
const openWith = (item: QueueItem, worktree?: WorktreeChoice) =>
  act(async () => {
    set(asking, null);
    // Checking a branch out fetches it first, which can take a while on a big repository.
    const timeoutMs = worktree === "create" ? 120_000 : 20_000;
    const input = worktree ? { key: item.key, worktree } : { key: item.key };
    const result: OpenResult = await plugin.request("guide.open", input, { timeoutMs });
    if (!result.opened) set(asking, { item, branch: result.ask.branch });
    else set(openNotes, result.notes.length ? { key: item.key, notes: result.notes } : null);
  });
const open = (item: QueueItem) => () => openWith(item);
const hasGuide = (item: QueueItem) => item.status === "ready" || item.status === "stale";
const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const turnOn = (repo: string) => () =>
  actOnQueue(() => plugin.request("repo.setOptIn", { repo, optIn: true }));

function OptIn({ repo, agent }: { repo: RepoState; agent: string }) {
  return (
    <Callout tone="accent" title={`Keep review guides up to date in ${repo.repo}?`}>
      <Stack gap="sm">
        <Text size="sm">
          Guides are made in the background for the PRs listed here, and updated after each push.
          Uses {agent}.
        </Text>
        <Row gap="xs">
          <Button onPress={turnOn(repo.repo)}>Turn on</Button>
          <Button
            variant="ghost"
            onPress={() =>
              actOnQueue(() => plugin.request("repo.setOptIn", { repo: repo.repo, optIn: false }))
            }
          >
            Not now
          </Button>
        </Row>
      </Stack>
    </Callout>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type TabId = "review" | "rereview" | "mine";
/** The tab shown; kept across reloads so the panel comes back where the person left it. */
const tab = atom<TabId>("tab", "review", { persist: "plugin" });
const isTab = (v: string): v is TabId => v === "review" || v === "rereview" || v === "mine";

function RiskBadge({ item }: { item: QueueItem }) {
  return item.risk ? (
    <Badge tone={RISK_TONE[item.risk]}>{`${RISK_WORD[item.risk]} risk`}</Badge>
  ) : null;
}

/** "api #7 · team · draft", with the risk (and Open, for the guide on screen) on the right. */
function CardHead({ item, current }: { item: QueueItem; current: boolean }) {
  return (
    <Row gap="xs" align="center" justify="between">
      <Text muted size="xs" truncate>
        {item.position !== null ? `${item.position}. ` : ""}
        {item.repoLabel} #{item.number}
        {item.team ? " · team" : ""}
        {item.draft ? " · draft" : ""}
      </Text>
      <Row gap="xs" align="center">
        {current ? <Badge tone="accent">Open</Badge> : null}
        <RiskBadge item={item} />
      </Row>
    </Row>
  );
}

/** "+120 −30 · 4 files", then how long the review waited, or when you reviewed it. */
function SizeLine({ item }: { item: QueueItem }) {
  return (
    <Text muted size="xs">
      +{item.additions} −{item.deletions} · {plural(item.changedFiles, "file")}
      {item.lane === "recent" && item.lastReview ? (
        <>
          {" · reviewed "}
          <RelativeTime at={item.lastReview.at} format="long" />
        </>
      ) : item.lane === "user" || item.lane === "team" ? (
        <>
          {" · waiting "}
          <RelativeTime at={item.requestedAt} format="duration" />
        </>
      ) : null}
    </Text>
  );
}

/** "Guide ready · 18 of 23 files · 1 pending comment". */
function readyLine(item: QueueItem): string {
  const parts = ["Guide ready"];
  if (item.tour) parts.push(item.tour === "Reviewed tour" ? "✓ reviewed" : item.tour);
  if (item.pendingComments) parts.push(plural(item.pendingComments, "pending comment"));
  return parts.join(" · ");
}

/** Where the PR's guide is, in words: a card never says it by colour alone. */
function GuideLine({ item }: { item: QueueItem }) {
  switch (item.status) {
    case "generating":
      return (
        <Spinner label={hasGuide(item) || item.risk ? "Updating the guide" : "Writing the guide"} />
      );
    case "queued":
      return (
        <Text muted size="xs">
          {item.risk ? "Waiting to update" : "Queued"}
        </Text>
      );
    case "failed":
      return (
        <Text tone="danger" size="xs">
          Couldn't write the guide ({failureReason(item.error)})
        </Text>
      );
    case "stale":
      return (
        <Text muted size="xs">
          Guide is for an older commit
        </Text>
      );
    case "ready":
      return (
        <Text muted size="xs">
          {readyLine(item)}
        </Text>
      );
    case "lockfile":
      return (
        <Text muted size="xs">
          Only lockfiles changed
        </Text>
      );
    default:
      return (
        <Text muted size="xs">
          {noGuideReason(item)}
        </Text>
      );
  }
}

function noGuideReason(item: QueueItem): string {
  if (!item.hasClone) return "Add this repo to Orca to get a guide";
  // A reviewed PR's reason ("Reviewed already") only repeats its tab.
  return item.manualReason && item.lane !== "recent" ? item.manualReason : "No guide yet";
}

/** The card's one main action, and Open older guide beside Try again after a failure. */
function CardActions({ item }: { item: QueueItem }) {
  if (item.status === "generating" || item.status === "queued") return null;
  if (item.status === "failed")
    return (
      <Row gap="xs">
        <Button
          size="sm"
          variant="outline"
          tooltip={item.error ? item.error.slice(0, 300) : undefined}
          onPress={generate(item)}
        >
          Try again
        </Button>
        {item.risk ? (
          <Button size="sm" variant="ghost" onPress={open(item)}>
            Open older guide
          </Button>
        ) : null}
      </Row>
    );
  if (hasGuide(item))
    return (
      <Row gap="xs">
        <Button size="sm" onPress={open(item)}>
          Review →
        </Button>
      </Row>
    );
  if (!item.hasClone || item.status === "lockfile") return null;
  return (
    <Row gap="xs">
      <Button size="sm" variant="outline" onPress={generate(item)}>
        Generate guide
      </Button>
    </Row>
  );
}

/** One PR: where it is, how big, where its guide is, and what to do next. */
function PrCard({ item, current }: { item: QueueItem; current: boolean }) {
  return (
    <Card>
      <Stack gap="xs">
        <CardHead item={item} current={current} />
        <Text size="sm" weight="medium" truncate>
          {item.title}
        </Text>
        <SizeLine item={item} />
        <NewCommits item={item} />
        <GuideLine item={item} />
        <CardActions item={item} />
        <WorktreeAsk only={item.key} />
      </Stack>
    </Card>
  );
}

/** The author pushed since you last opened the guide, or since your last review on GitHub. */
function NewCommits({ item }: { item: QueueItem }) {
  return item.newSinceYourReview || item.lastReview?.newCommits ? (
    <Row gap="xs">
      <Badge tone="accent">New commits since your review</Badge>
    </Row>
  ) : null;
}

function Cards({ items, s }: { items: readonly QueueItem[]; s: QueueState }) {
  return (
    <Stack gap="sm">
      {items.map((item) => (
        <PrCard key={item.key} item={item} current={item.key === s.openKey} />
      ))}
    </Stack>
  );
}

function ShowMine() {
  return (
    <Button
      variant="ghost"
      size="sm"
      onPress={() =>
        actOnQueue(() =>
          plugin.request("lane.showAuthored", { show: true }, { timeoutMs: 120_000 }),
        )
      }
    >
      Show my own PRs
    </Button>
  );
}

/** The heading with Check now, which gives way to a spinner while a check runs. */
function Top({ s }: { s: QueueState | null }) {
  return (
    <Row justify="between" align="center">
      <Heading>Review Desk</Heading>
      {s?.checking ? (
        <Spinner label="Checking GitHub" labelHidden />
      ) : (
        <IconButton
          icon="refresh"
          label="Check now"
          tooltip={
            s?.checkedAt != null ? `Check now · last checked ${clock(s.checkedAt)}` : "Check now"
          }
          onPress={() =>
            actOnQueue(() => plugin.request("queue.refresh", undefined, { timeoutMs: 120_000 }))
          }
        />
      )}
    </Row>
  );
}

/** Reviews requested on you and your teams; PRs with no automatic guide folded at the bottom. */
function ToReview({ s }: { s: QueueState }) {
  return (
    <Stack gap="sm">
      {s.queue.length ? (
        <Cards items={s.queue} s={s} />
      ) : (
        <EmptyState icon="check" title="Nothing waiting for your review" />
      )}
      {s.notQueued.length ? (
        <Collapsible title={`Not queued · ${s.notQueued.length}`}>
          <Cards items={s.notQueued} s={s} />
        </Collapsible>
      ) : null}
    </Stack>
  );
}

/** Open PRs you reviewed lately and aren't requested on: the way back without re-requesting. */
function ReReview({ s }: { s: QueueState }) {
  return s.recent.length ? (
    <Cards items={s.recent} s={s} />
  ) : (
    <EmptyState
      icon="refresh"
      title="Nothing to re-review"
      description={`No open PRs you reviewed in the last ${plural(s.recentDays, "day")}.`}
    />
  );
}

function Mine({ s }: { s: QueueState }) {
  if (s.authored.length) return <Cards items={s.authored} s={s} />;
  return (
    <Stack gap="xs" align="center">
      <EmptyState
        icon="branch"
        title={s.includeAuthored ? "No open PRs of yours" : "Your own PRs are hidden"}
      />
      {!s.includeAuthored ? <ShowMine /> : null}
    </Stack>
  );
}

function ReviewTabs({ s }: { s: QueueState }) {
  return (
    <Tabs
      label="Reviews"
      value={read(tab)}
      onChange={(v) => {
        if (isTab(v)) set(tab, v);
      }}
    >
      <Tab value="review" label={`To review (${s.queue.length})`}>
        <ToReview s={s} />
      </Tab>
      <Tab value="rereview" label={`Re-review (${s.recent.length})`}>
        <ReReview s={s} />
      </Tab>
      <Tab value="mine" label={`Mine (${s.authored.length})`}>
        <Mine s={s} />
      </Tab>
    </Tabs>
  );
}

/** Everything under the heading once the queue has loaded. */
function Loaded({ s }: { s: QueueState }) {
  return (
    <Stack gap="md">
      {s.notice ? (
        <Callout
          tone={s.notice.tone}
          icon={s.notice.tone === "danger" ? "error" : "warning"}
          title={s.notice.text}
        >
          {s.notice.turnOn ? (
            <Button onPress={turnOn(s.notice.turnOn)}>Turn guides back on</Button>
          ) : null}
        </Callout>
      ) : null}
      {s.repos
        .filter((r) => r.optIn === null && r.hasClone)
        .map((r) => (
          <OptIn key={r.repo} repo={r} agent={s.agentLabel} />
        ))}
      {s.checkedAt === null ? (
        <Skeleton lines={3} label="Checking GitHub for reviews" />
      ) : (
        <ReviewTabs s={s} />
      )}
    </Stack>
  );
}

/** Whether a PR's card is on screen to hold the worktree question; else the panel's top holds it. */
const listed = (s: QueueState | null, key: string): boolean =>
  !!s && [s.queue, s.notQueued, s.recent, s.authored].some((l) => l.some((i) => i.key === key));

/**
 * The question about a worktree for the guide being opened: in its PR's card (`only`), or at the
 * top of the panel when that card isn't listed.
 */
function WorktreeAsk({ only }: { only?: string }) {
  const ask = read(asking);
  if (!ask) return null;
  if (only !== undefined ? ask.item.key !== only : listed(read(queue), ask.item.key)) return null;
  return (
    <Callout tone="accent" icon="branch" title={`No worktree on ${ask.branch}`}>
      <Stack gap="sm">
        <Text size="sm">
          Check it out beside the clone to run and test {ask.item.repo}#{ask.item.number} while you
          review?
        </Text>
        <Row gap="xs">
          <Button size="sm" onPress={() => openWith(ask.item, "create")}>
            Create worktree
          </Button>
          <Button size="sm" variant="ghost" onPress={() => openWith(ask.item, "skip")}>
            Open without
          </Button>
        </Row>
      </Stack>
    </Callout>
  );
}

/** Where the last guide opened, when there was something to say about it. */
function OpenNotes() {
  const notes = read(openNotes);
  if (!notes) return null;
  return (
    <Callout tone="neutral" icon="info" title={`Opened ${notes.key}`}>
      <Stack gap="xs">
        {notes.notes.map((n) => (
          <Text key={n} size="sm">
            {n}
          </Text>
        ))}
        <Row gap="xs">
          <Button size="sm" variant="ghost" onPress={() => set(openNotes, null)}>
            Dismiss
          </Button>
        </Row>
      </Stack>
    </Callout>
  );
}

export default function Panel() {
  const s = read(queue);
  const problem = read(failure);
  return (
    <Stack gap="md">
      <Top s={s} />
      {problem ? (
        <Callout tone="warning" title="That didn't work">
          <Text size="sm">{problem}</Text>
        </Callout>
      ) : null}
      <WorktreeAsk />
      <OpenNotes />
      {s ? <Loaded s={s} /> : <Skeleton lines={4} label="Loading your review queue" />}
    </Stack>
  );
}
