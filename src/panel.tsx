// The review queue in Orca's right sidebar: the reviews you owe in the order to do them, with the
// rest folded away. All state comes from the worker (src/worker.ts); order from src/queue.ts.
import {
  atom,
  Box,
  Button,
  Callout,
  Collapsible,
  EmptyState,
  Heading,
  IconButton,
  List,
  ListItem,
  plugin,
  read,
  RelativeTime,
  Row,
  set,
  Skeleton,
  Spinner,
  Stack,
  Text,
  type PanelContext,
  type Tone,
} from "orca";
import { failureReason } from "./failure";
import type { QueueItem, QueueState, RepoState } from "./protocol";

const queue = atom<QueueState | null>(null);
const failure = atom<string | null>(null);

const RISK: Record<string, { label: string; tone: Tone }> = {
  high: { label: "High", tone: "danger" },
  medium: { label: "Medium", tone: "warning" },
  low: { label: "Low", tone: "success" },
};

async function act(run: () => Promise<unknown>): Promise<void> {
  set(failure, null);
  try {
    const answer = await run();
    if (answer && typeof answer === "object" && "queue" in answer) set(queue, answer as QueueState);
  } catch (error) {
    set(failure, error instanceof Error ? error.message : String(error));
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on("queue.changed", (state) => set(queue, state)));
  void act(() => plugin.request("queue.get"));
}

const generate = (item: QueueItem) => () =>
  act(() => plugin.request("guide.generate", { key: item.key }));
const open = (item: QueueItem) => () =>
  act(() => plugin.request("guide.open", { key: item.key }, { timeoutMs: 20_000 }));
const hasGuide = (item: QueueItem) => item.status === "ready" || item.status === "stale";
const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function OptIn({ repo, agent }: { repo: RepoState; agent: string }) {
  return (
    <Callout tone="accent" title={`Keep review guides up to date in ${repo.repo}?`}>
      <Stack gap="sm">
        <Text size="sm">
          Guides are made in the background for the PRs listed here, and updated after each push.
          Uses {agent}.
        </Text>
        <Row gap="xs">
          <Button
            onPress={() =>
              act(() => plugin.request("repo.setOptIn", { repo: repo.repo, optIn: true }))
            }
          >
            Turn on
          </Button>
          <Button
            variant="ghost"
            onPress={() =>
              act(() => plugin.request("repo.setOptIn", { repo: repo.repo, optIn: false }))
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

/** What the guide is doing, in words: a row never says it by colour alone. */
function StatusLine({ item }: { item: QueueItem }) {
  // With no guide yet, the risk slot already says "Writing…" or "Queued".
  const updating = hasGuide(item) || item.risk !== null;
  switch (item.status) {
    case "generating":
      return updating ? <Spinner label="Updating guide" /> : null;
    case "queued":
      return updating ? (
        <Text muted size="xs">
          Waiting to update
        </Text>
      ) : null;
    case "stale":
      return (
        <Text muted size="xs">
          Guide is for an older commit
        </Text>
      );
    default:
      return null;
  }
}

/** The word in the risk slot of a row with no risk yet, so it still says where the guide is. */
function slotWord(item: QueueItem): string {
  switch (item.status) {
    case "generating":
      return "Writing…";
    case "queued":
      return "Queued";
    default:
      return "No guide";
  }
}

/**
 * The risk (or, with no guide yet, what the guide is doing) in a slot of one width and one outlined
 * style for every level, so repo names line up down the list. The word carries the meaning; the
 * colour only repeats it.
 */
function RiskSlot({ item }: { item: QueueItem }) {
  const risk = item.risk ? RISK[item.risk] : null;
  return (
    <Box width={76} shrink={false} border={risk ? risk.tone : true} radius="full" align="center">
      <Text size="xs" weight="medium" tone={risk?.tone} muted={!risk}>
        {risk ? risk.label : slotWord(item)}
      </Text>
    </Box>
  );
}

function Heads({ item }: { item: QueueItem }) {
  return (
    <Row gap="xs" align="start" justify="between">
      <Row gap="xs" align="center" wrap>
        {item.position !== null ? (
          <Text weight="semibold" size="sm">
            {item.position}
          </Text>
        ) : null}
        <RiskSlot item={item} />
        <Text muted size="xs">
          {item.repoLabel} #{item.number}
          {item.team ? " · team" : ""}
          {item.draft ? " · draft" : ""}
        </Text>
      </Row>
      {/* How long the review has waited, kept current by Orca. Your own PRs wait for nobody, and
          there it would only be the PR's age. */}
      {item.lane !== "authored" ? (
        <Box shrink={false}>
          <Text muted size="xs">
            <RelativeTime at={item.requestedAt} format="duration" />
          </Text>
        </Box>
      ) : null}
    </Row>
  );
}

/** "Tour · 18 of 23 files · 2 pending comments": how far the review got, or null before it starts. */
function progressLine(item: QueueItem): string | null {
  const parts: string[] = [];
  if (item.tour && item.status === "ready")
    parts.push(item.tour === "Reviewed tour" ? "✓ Reviewed tour" : `Tour · ${item.tour}`);
  if (item.pendingComments) parts.push(plural(item.pendingComments, "pending comment"));
  return parts.length ? parts.join(" · ") : null;
}

/** A queued review: the whole row opens the guide. */
function QueueRow({ item, current }: { item: QueueItem; current: boolean }) {
  if (item.status === "failed") return <FailedRow item={item} />;
  const progress = progressLine(item);
  return (
    <ListItem onPress={hasGuide(item) ? open(item) : undefined} current={current}>
      <Stack gap="xs">
        <Heads item={item} />
        <Text size="sm" weight="medium">
          {item.title}
        </Text>
        {item.newSinceYourReview ? (
          <Text tone="accent" size="xs">
            ↻ New commits since your review
          </Text>
        ) : null}
        {progress ? (
          <Text muted size="xs">
            {progress}
          </Text>
        ) : null}
        <StatusLine item={item} />
      </Stack>
    </ListItem>
  );
}

/**
 * A run that failed: a short reason and Try again (the full error is the button's tooltip and in
 * the plugin's logs). Not pressable as a row, so it can hold its buttons.
 */
function FailedRow({ item }: { item: QueueItem }) {
  return (
    <ListItem>
      <Stack gap="xs">
        <Heads item={item} />
        <Text size="sm" weight="medium">
          {item.title}
        </Text>
        <Text tone="danger" size="xs">
          Couldn't write the guide ({failureReason(item.error)})
        </Text>
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
      </Stack>
    </ListItem>
  );
}

/** A PR with no automatic guide: not pressable, so it can hold its Generate button. */
function ManualRow({ item }: { item: QueueItem }) {
  const busy = item.status === "generating" || item.status === "queued";
  return (
    <ListItem>
      <Stack gap="xs">
        <Heads item={item} />
        <Text size="sm" weight="medium">
          {item.title}
        </Text>
        {!item.hasClone || item.manualReason ? (
          <Text muted size="xs">
            {item.hasClone ? item.manualReason : "Add this repo to Orca to get a guide"}
          </Text>
        ) : null}
        {busy ? (
          <StatusLine item={item} />
        ) : item.hasClone && item.status !== "lockfile" ? (
          <Row gap="xs">
            <Button size="sm" variant="outline" onPress={generate(item)}>
              Generate
            </Button>
          </Row>
        ) : null}
      </Stack>
    </ListItem>
  );
}

function ShowMine() {
  return (
    <Button
      variant="ghost"
      size="sm"
      onPress={() =>
        act(() => plugin.request("lane.showAuthored", { show: true }, { timeoutMs: 120_000 }))
      }
    >
      Show my own PRs
    </Button>
  );
}

export default function Panel() {
  const s = read(queue);
  const problem = read(failure);
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading>Reviews</Heading>
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
              act(() => plugin.request("queue.refresh", undefined, { timeoutMs: 120_000 }))
            }
          />
        )}
      </Row>
      {problem ? (
        <Callout tone="warning" title="That didn't work">
          <Text size="sm">{problem}</Text>
        </Callout>
      ) : null}
      {!s ? (
        <Skeleton lines={4} label="Loading your review queue" />
      ) : (
        <Stack gap="md">
          {s.notice ? (
            <Callout
              tone={s.notice.tone}
              icon={s.notice.tone === "danger" ? "error" : "warning"}
              title={s.notice.text}
            />
          ) : null}
          {s.repos
            .filter((r) => r.optIn === null && r.hasClone)
            .map((r) => (
              <OptIn key={r.repo} repo={r} agent={s.agentLabel} />
            ))}
          {s.queue.length ? (
            <Stack gap="xs">
              <Text muted size="xs" weight="semibold">
                Queue · {s.queue.length}
              </Text>
              <List label="Review queue">
                {s.queue.map((item) => (
                  <QueueRow key={item.key} item={item} current={item.key === s.openKey} />
                ))}
              </List>
            </Stack>
          ) : s.checkedAt !== null && (s.notQueued.length || s.authored.length) ? (
            // The sections below have rows: one quiet line, so they stay in view.
            <Row gap="xs" justify="between" align="center" wrap>
              <Text muted size="sm">
                Nothing waiting for your review
              </Text>
              {!s.includeAuthored ? <ShowMine /> : null}
            </Row>
          ) : s.checkedAt !== null ? (
            <Stack gap="xs" align="center">
              <EmptyState icon="check" title="Nothing waiting for your review" />
              {!s.includeAuthored ? <ShowMine /> : null}
            </Stack>
          ) : null}
          {s.notQueued.length ? (
            <Collapsible title={`Not queued · ${s.notQueued.length}`}>
              <List label="Not queued">
                {s.notQueued.map((item) => (
                  <ManualRow key={item.key} item={item} />
                ))}
              </List>
            </Collapsible>
          ) : null}
          {s.authored.length ? (
            <Collapsible title={`Your PRs · ${s.authored.length}`}>
              <List label="Your PRs">
                {s.authored.map((item) =>
                  hasGuide(item) || item.status === "failed" ? (
                    <QueueRow key={item.key} item={item} current={item.key === s.openKey} />
                  ) : (
                    <ManualRow key={item.key} item={item} />
                  ),
                )}
              </List>
            </Collapsible>
          ) : null}
        </Stack>
      )}
    </Stack>
  );
}
