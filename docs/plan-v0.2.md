# PR Tour v0.2: technical plan

Status: agreed scope, not started. Builds on v0.1 (`src/`, `editor/`), which is loaded in Orca as
`local.pr-tour` and was validated end to end on `adamthewilliam/daedux#3`.

## Goals

1. **The panel is a queue**: one ordered list of the reviews you owe, with what to do next on top.
2. **The guide is fast to scan without losing detail**: short headlines, full detail one click away,
   and proof that every changed file was covered.
3. **You can review from the guide**: comments, suggested comments, Approve / Request changes /
   Comment, posted as one GitHub review after a confirmation step.

Non-goals for v0.2: commenting from Orca's own diff viewer (plugins cannot extend it), inline diff
rendering in the guide, syncing GitHub's per-file "Viewed" state, sharing guides between people.

## Decisions already made

| Topic | Decision |
| --- | --- |
| Queue order | 1. new commits since your review, 2. risk high → low (unknown counts as medium), 3. waited longest first |
| Queue contents | Direct and team requests in one queue; team items tagged. "Not queued" and "Your PRs" are collapsed sections |
| Detail | No caps on content. Word limits apply to **headlines only**; every point can carry an unlimited `detail` |
| Coverage | Every changed (non-lockfile) file gets a note; the guide says which files the agent did not read |
| Review actions | Nothing is posted without a click and a confirmation. Approve hidden on your own PRs |
| Footer | Removed. Last-checked time moves to the refresh tooltip; run count and model appear only when they matter |

## Overview of changes

| Area | Files | Change |
| --- | --- | --- |
| Data contract | `src/schema.ts` | `prguide/v2`: headline/detail fields, findings, per-file notes, coverage, word-limit checks |
| Prompt | `src/prompt.ts` | v2 shape, file-by-file diff budget, findings and suggested comments, headline limits |
| Diff handling | new `src/diff.ts` | Per-file diffs, budgeted prompt, valid comment lines per file, coverage from tool calls |
| Agent | `src/agent.ts` | Return the run's tool calls (Claude) alongside the reply |
| GitHub | `src/github.ts` | Review-request times (GraphQL), review submission, file-level comments |
| Queue | new `src/queue.ts` | Pure ordering and grouping, unit-tested |
| Reviews | new `src/review.ts` | Draft model, validation against the diff, GitHub payload builder |
| Worker | `src/worker.ts` | Queue state v2, review handlers, local-day counter, status lines |
| Protocol | `src/protocol.ts` | New state shape and requests |
| Panel | `src/panel.tsx`, `src/panel.check.ts` | Queue UI, collapsed sections, no footer |
| Guide tab | `editor/main.ts`, `editor/style.ts`, new `editor/review.ts` | One column, headline/More, findings, all-files list, review bar |

## 1. Data contract: `prguide/v2`

```ts
type Point = { headline: string; detail?: string }          // headline: one sentence, word-limited

type Severity = 'blocker' | 'major' | 'minor' | 'nit'

type AgentGuideV2 = {
  title: string                                              // ≤ 12 words
  risk: { level: RiskLevel; headline: string; detail?: string; beforeMerge: Point[] }
  summary: { what: Point; why: Point; impact: Point }        // headlines ≤ 25 words
  findings: {                                                // no cap
    id: string                                               // stable within the guide: "f1", "f2"
    severity: Severity
    file: string
    line: number | null                                      // PR-head line number, RIGHT side
    headline: string                                         // ≤ 20 words
    detail: string
    suggestedComment: string | null                          // ready-to-post review comment text
  }[]
  areas: { id: string; label: string; question: string; files: string[] }[]
  readingOrder: { file: string; areaId: string; headline: string; detail?: string }[]  // no cap
  files: { path: string; note: string }[]                    // EVERY changed non-lockfile file
  flows: { title: string; before: FlowStep[]; after: FlowStep[] }[]
  claimsCheck: { claim: string; verdict: ClaimVerdict; evidence: string }[]
  sinceLastReview: null | { changes: { file: string; headline: string; answersComment: boolean }[]; riskChanged: boolean; openComments: number | null }
}
```

Worker-filled, never trusted from the agent: `schema`, `pr` (adds `requestedAt`), `generatedBy`,
`reviewRequest`, area counts, `sinceLastReview.fromCommit/toCommit`, and:

```ts
coverage: {
  inPrompt: string[]        // files whose full diff was in the prompt
  readByAgent: string[]     // files the agent opened with its tools (from the run's tool calls)
  notRead: string[]         // changed files in neither list
}
```

`checkAgentGuide` (v2) adds, each as a `path: reason` problem the repair round can fix:

- **Word limits on headlines only**: title 12, risk 20, summary 25 each, finding 20, reading order 25.
  `detail` and `files[].note` are unlimited.
- **References exist**: every `file` in findings, reading order, areas and `files` is a changed
  file; every finding `line` is a valid RIGHT-side line in that file's diff (see §3), or null.
- **Full coverage**: every changed non-lockfile path appears in `files` exactly once.
- `areaId` in reading order matches an `areas[].id`.

Compatibility: the editor accepts v1 and v2. A stored v1 guide shows as "Made by an older version"
with Regenerate, and the queue treats it as `stale`, so it is replaced on the next automatic run.

## 2. Prompt (`src/prompt.ts`)

- New shape from §1, with the headline limits stated next to each field and the rule "put
  everything else in `detail`; never drop a point to stay short".
- **Findings first**: "List every concrete problem a reviewer should know about, with file and
  PR-head line. For each one a reviewer would raise, write `suggestedComment` as you would post
  it: specific, courteous, no preamble."
- **No description**: when the PR body is empty the prompt says so and `claimsCheck` must be `[]`;
  the editor then shows "No description to check against the diff" (worker sets
  `pr.hasDescription`).
- Diff section built by `src/diff.ts` (§3), followed by the list of files that are *not* in the
  prompt, with the exact `git show`/`git diff` commands to read them.

## 3. Diff handling (new `src/diff.ts`)

Replaces the single truncated `git diff` (today: cut at 180k characters, silently).

1. `git diff --numstat base...head` and per-file `git diff base...head -- <path>`, lockfiles excluded.
2. **Budget**: fill the prompt with whole files, most important first, up to `PROMPT_DIFF_BUDGET`
   (180k characters). Order: non-test source by change size, then config, then tests, then docs.
   A file never goes in partially.
3. Files over the budget are listed with their sizes and read by the agent with its tools.
4. **Valid comment lines**: `commentableLines(diffText): Map<path, Set<number>>`, parsed from hunk
   headers (`@@ -a,b +c,d @@`): added and context lines on the RIGHT side. Used by the schema check
   (§1) and by review submission (§6).
5. **Coverage**: `readByAgent` comes from the Claude run's `tool_use` events (`Read` file paths,
   `Bash` `git show <ref>:<path>` / `git diff … -- <path>`), confirmed working: `--output-format json`
   returns every event. Codex has no event stream, so for Codex `readByAgent` is empty and
   `notRead` is "every file not in the prompt"; the guide says so.

`src/agent.ts`: `runAgent` returns `{ text, toolCalls: { name, input }[] }`.

## 4. Queue (new `src/queue.ts`, worker, protocol)

### Review-request time

`src/github.ts` `requestTimes(repo, numbers[])`: one GraphQL query per repo with an alias per PR:

```graphql
pr123: pullRequest(number: 123) {
  createdAt
  timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT, READY_FOR_REVIEW_EVENT], last: 20) {
    nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } ... on Team { slug } } }
            ... on ReadyForReviewEvent { createdAt } }
  }
}
```

`requestedAt` = latest request naming you or one of your teams, else ready-for-review, else
`createdAt`. Cached per PR head in memory; re-fetched when the head changes. (Query verified
against GitHub.)

### Ordering and grouping (pure, unit-tested)

```ts
export function buildQueue(items: QueueItem[], now: number): {
  queue: QueueItem[]        // lanes user + team whose manualReason is null, or that have a guide
  notQueued: QueueItem[]    // the rest of user + team, each with its reason
  authored: QueueItem[]
}
// queue sort: newSinceYourReview desc, riskRank asc (high 0, medium/unknown 1, low 2), requestedAt asc
```

### State changes (`src/protocol.ts`)

```ts
type QueueItem = { …v1 fields, requestedAt: number; team: string | null; position: number | null; repoLabel: string }
type QueueState = {
  queue: QueueItem[]; notQueued: QueueItem[]; authored: QueueItem[]
  repos: RepoState[]; checking: boolean; checkedAt: number | null
  notice: null | { tone: 'warning' | 'danger'; text: string }   // the only status line the panel shows
}
```

`notice` replaces `error`, `runsToday`, `dailyLimit` and `agentLabel` in the panel. It is set for:
GitHub unreachable ("Couldn't reach GitHub · last checked 14:02"), agent not signed in, and daily
limit reached ("Automatic guides paused until tomorrow · Generate still works").

`repoLabel` is `repo` without the owner unless two items share a repo name.

### Fix: local-day counter

`today()` uses the local date (`toLocaleDateString('en-CA')`) instead of `toISOString()`, so the
limit resets at local midnight.

## 5. Panel (`src/panel.tsx`)

```
Reviews                                          ⟳   (tooltip: "Check now · last checked 14:02")
[notice line, only when set]
Queue · 3
 1  ● High    api #43841                       2h     ← ListItem, onPress opens guide
    Record why sessions end in auth events
    ↻ 2 new commits since your review
 2  ● Medium  api #43183  team                 1d
 3  ◌ Writing guide…  api #43910               5m
▸ Not queued · 2     (Collapsible, closed)  rows keep their Generate button and reason
▸ Your PRs · 1       (Collapsible, closed)
```

- `List` + `ListItem` (`title`, `description`, `onPress`); the row has no other controls, as
  `ListItem` requires. Generate lives only in Not queued, where rows are not pressable.
- Risk badge keeps its text label. Waited time uses `RelativeTime`.
- One empty state, only when the queue is empty: "Nothing waiting for your review".
- Repo with no local clone: no button, the reason reads "Add this repo to Orca to get a guide".
- Opt-in callout unchanged in behaviour, shown above the queue.
- `src/panel.check.ts` scenarios: empty, opt-in, queue (all statuses), notices (offline, limit,
  not signed in), dark.

## 6. Reviewing from the guide

### Model (new `src/review.ts`, storage `draft:<key>`)

```ts
type DraftComment = {
  id: string
  path: string
  line: number | null            // null = comment on the whole file
  body: string
  source: 'manual' | `finding:${string}`
}
type Draft = { commitId: string; body: string; comments: DraftComment[]; dismissedFindings: string[] }
```

Drafts are keyed by PR and survive closing the tab. A draft made on an older commit is kept;
its line comments are re-validated against the new diff before submit (§ below).

### Requests (`src/protocol.ts`)

| Request | Does |
| --- | --- |
| `review.get { key }` | Draft, plus `canApprove` (false on your own PR) and the PR head |
| `review.save { key, draft }` | Stores the draft |
| `review.submit { key, event, body }` | Validates, posts, clears the draft, refreshes the queue |

`event` is `APPROVE`, `REQUEST_CHANGES` or `COMMENT`.

### Submission (worker)

1. Re-fetch the PR head; if it moved since the draft's `commitId`, re-check every line comment
   against `commentableLines` of the new diff. Any that no longer fit are returned as
   `conflict` with the list, and the editor shows them for fixing; nothing is posted.
2. Line comments go in one review:
   `gh api -X POST repos/{repo}/pulls/{n}/reviews --input -` with
   `{ commit_id, event, body, comments: [{ path, line, side: 'RIGHT', body }] }`.
3. File-level comments are not accepted inside a review by GitHub, so each is posted right after
   with `POST repos/{repo}/pulls/{n}/comments` and `subject_type: 'file'`. If one fails, the review
   still stands and the editor lists the comment that was not posted, kept in the draft.
4. GitHub refuses `APPROVE` and `REQUEST_CHANGES` on your own PR; the editor hides both there.
5. Errors keep the draft and show GitHub's message next to the review bar.

### Guide tab UI (`editor/review.ts`)

- **Suggested comments** section (findings with `suggestedComment`, not dismissed, not already in
  the draft): `file:line`, the text, **Add** (copies into the draft, editable) and **Dismiss**.
- **Comment** link on each reading-order row and each All-files row: opens an inline composer
  (textarea, optional line field validated against the diff, **Add to review**; Cmd+Enter adds).
- **Review bar** fixed to the bottom of the tab: `Review · N comments pending`, then
  **Comment**, **Request changes**, **Approve**. Pressing one opens an inline confirmation in the
  bar: verdict, summary textarea, the comments to be posted, **Post to GitHub** / **Cancel**.
  The bar uses `role="region"` and the result line `role="status"`.
- The worker never posts on its own: every submit comes from a press in the frame.

## 7. Guide tab layout (`editor/main.ts`, `editor/style.ts`)

One column, `max-width: 760px`, in this order:

1. Title; one meta line `daedux #3 · branch → main · +594 −807 · 23 files · Open on GitHub`.
2. **Risk strip**: level + headline, **More** for detail, then Before merge (when present).
3. **What / Why / Impact** as three rows (label, headline, More).
4. **Changes**: one stacked bar of areas with a legend (area label, +/−, file count).
5. **Since your last review** (when present).
6. **Findings** (when present): severity, `file:line` link, headline, More; each with its
   suggested comment controls (§6).
7. **What changed · in reading order**: file link, area label, headline, More, Comment.
8. **All files** (collapsed `<details>`): every changed file with its note and Comment link.
9. **Claims check**, or "No description to check against the diff".
10. **Flows** (when present).
11. **Coverage line**: "Agent read 31 of 35 files · not read: …" (only when anything was not read).
12. Footer line: `Claude Code · claude-opus-5-5 · 14:02 · 281882c · Regenerate` (Regenerate is a link).
13. Review bar (fixed).

"More" uses `<details>`/`<summary>` so it is keyboard-accessible with no script.

## 8. Testing

Unit (`orca plugin test`):

- `diff.test.ts`: hunk parsing to commentable lines (adds, context, deletions excluded, multiple
  hunks, renames, binary files); budget fills whole files in priority order; coverage from
  sample Claude tool calls.
- `queue.test.ts`: ordering (all three keys and ties), grouping into queue / not queued /
  authored, `repoLabel` collisions.
- `schema.test.ts`: v2 valid; headline over limit; unknown file; finding line outside the diff;
  missing file in `files`; v1 accepted by the editor check.
- `review.test.ts`: payload for line comments; file comments split out; stale lines reported.

Worker (`mountWorker` with the fake runner):

- requested-at ordering end to end; notice for daily limit; local-day reset.
- `review.submit` posts exactly one review with the right JSON on stdin, then file comments;
  refuses lines outside the diff with `conflict` and posts nothing; Approve refused on own PR.
- Coverage: a fake Claude event stream that reads one file marks it `readByAgent`.

Checks: `bun run typecheck`, `bunx oxlint src editor`, `bunx oxfmt --check src editor`,
`orca plugin validate .`, `orca plugin check .` (panel scenarios + editor scan).

Live in Orca (desktop, dark theme as in use):

- Panel shots for queue, empty, notice states (`orca plugin shot`).
- Guide shots at the real editor width with both sidebars open, top and scrolled, on a
  regenerated `daedux#3` guide.
- Review flow up to the confirmation step without posting. **Posting is tested only with your
  go-ahead**, as a `COMMENT` review with one line comment on your own `daedux#3` (Approve is not
  possible on your own PR).

## 9. Delivery order

Each step leaves the plugin working and tested.

1. `diff.ts` + coverage + `agent.ts` tool calls (fixes the silent truncation first).
2. Schema v2 + prompt v2 + editor v1/v2 support; regenerate `daedux#3` and check the result.
3. Guide tab layout (§7) without review actions.
4. Queue: `requestTimes`, `queue.ts`, protocol, panel, notices, local-day fix.
5. Review model, requests and submission (worker), with tests.
6. Review UI in the guide (§6), then the live checks in §8.

## 10. Risks and open points

- **Longer runs**: findings, per-file notes and suggested comments add output. Expect roughly
  1.5× v0.1's ~50 s on a 1,400-line PR. Watch it on `daedux#3`; if it is much slower, notes for
  test and docs files can move to one line per area.
- **Line drift**: the agent's line numbers can be wrong; the schema check rejects lines outside
  the diff and the repair round fixes them, else the finding keeps `line: null` and becomes a
  file comment.
- **GitHub rate limits**: one GraphQL query per repo per check plus one `gh pr view` per PR; well
  under limits at a 5-minute poll for a normal queue.
- **Storage**: drafts add a key per PR under review; pruned with their guide (14 days after the
  PR leaves the queue). Values stay under the 256 KiB per-key limit; a guide over that is stored
  without `detail` fields and the editor says so.

## v0.3: split diff view

Built after v0.2 shipped. On a 5K display the guide tab is ~1,500 CSS px wide, but the guide sat in a
~560–760 px column with no code in sight.

**Layout** (`editor/main.ts`, `editor/style.ts`). A `ResizeObserver` on the tab's own `<html>`
(not a window media query, so it follows Orca's sidebars) sets `html.wide` at ≥ 1100 px:

- **Wide**: two independently scrolling panes above the fixed review bar. The guide is on the
  left, `clamp(480px, 40%, 680px)`; the diff pane takes the rest. The bar's measured height
  (`--bar-h`) sizes the panes, so focus can never sit behind the bar. The pane opens on the first
  reading-order file.
- **Narrow**: the old single column. Pressing a file reference opens its diff under that row; pressing
  again closes it (`aria-expanded`, ▸/▾). A diff opened from a finding doesn't repeat that finding.

**Navigation.** Every file reference (findings `file:line`, reading order, All files, Since your last
review) selects the file in the pane. A `file:line` scrolls the pane alone to that PR-head line and
highlights it. The pane header shows the path, +/−, the area, previous/next (reading order, then All
files order), **Comment on file** and **Open in Orca** (`file.open`). A `role="status"` line
announces the selection, and the selected file's references get `aria-current`.

**Diff** (new `editor/diff-view.ts`, pure `src/diff-model.ts`). The rendering is unified: hunk
headers, old and new line numbers in a sticky gutter, and +/− signs on tinted rows. Lines don't wrap
and scroll sideways. The gutter uses `--orca-font-mono` with `tab-size: 4`, and all diff text is
inserted as text nodes. Binary, renamed-only, empty and cut-off diffs each get a one-line notice.
The first 2,000 rows are drawn, then **Show remaining N lines**. There is no syntax highlighting.

**Comments in the diff.** All comments use the same draft as `editor/review.ts`. That file now exports
`composer`, `commentCard`, `comments`, `canComment` and `onChange`, and drops slots once they leave
the page. Added and context lines have a "+" button (visible on hover or focus), which opens the
composer under the line with the line prefilled. Deleted lines have none. Pending comments (Edit /
Remove) and the file's findings (severity, headline, the same Add to review / Dismiss slot as the
findings list) sit under their line. Whole-file items sit above the diff.

**Data.** The new `diff.get { key, path, commit? }` request returns `DiffFile`:
`{ path, oldPath, commit, status, binary, lines, totalLines, additions, deletions, truncated }`.
`lines` holds the raw unified lines from the first `@@` on, and the tab numbers them with
`diffRows`. The worker runs `git --literal-pathspecs diff -M refs/pr-tour/base-N...<commit> --
[oldPath] path`, with the old path taken from a cached `--name-status -M` of the same range so
renames diff properly. If the commit or base ref is missing, it fetches the refs first. Results are
cached in memory per `key@commit:path` (failures are not cached). Answers are capped at 600k JSON
characters / 20k lines and marked `truncated`. Lockfiles are allowed here and stay out of prompts.
`commit` is optional; the tab sends its own guide's commit, so a tab showing an older guide gets the
matching diff.

**Tests.** `src/diff-model.test.ts` covers numbering across hunks, the no-newline marker, row lookup,
binary/rename/delete/lockfile and truncation. `src/worker.test.ts` covers `diff.get` (range and
pathspec flags, cache, rename old path), the fetch when the commit is missing, and refusing a
non-hex commit.

## v0.4: guided tour

Built after v0.3. The split view put a whole file's diff next to a long guide; the reviewer still had
to find the lines that mattered. The guide tab is now a tour through the PR, one idea at a time, in
order, with only the code that explains it. It replaces the v0.3 split layout (`editor/main.ts`
controller, new `editor/tour.ts` views, `editor/parts.ts` shared pieces).

**Data.** Each `readingOrder` item (a *stop*) gains two optional fields, so v2 guides written before
the tour still load (whole-file stops, no Check line) and the schema id stays `prguide/v2`:

```ts
focus?: { start: number; end: number }[]   // 1-3 PR-head (RIGHT) line ranges inside the file's hunks
check?: string                             // one concrete question for the reviewer, ≤ 20 words
```

The prompt asks for both on every stop and tells the agent to pick the hunks that explain the
stop. `checkAgentGuide` requires them in the first round (`tour: true`), checks each range's shape
and that it overlaps an added or context line of that file (`overlapsDiff`, from the same
commentable data as finding lines), and a failure goes to the repair round. After the repair round
the tour fields are optional and `settle` drops malformed or out-of-diff ranges (a stop left with
none shows its whole file) and a missing check, logging each, as it does for finding lines. A stored
guide is checked only for the fields it has.

**Views.** `overview | stop:<i> | wrapup`, drawn from scratch on each move.

- *Overview* (default on a new commit): title and meta line; Since your last review; then two
  columns at ≥ 1100 px: risk strip, Before merge and What / Why / Impact on the left, the tour card
  on the right (`Tour · N stops · ~M min`, Start tour, or Resume at stop k and Restart when there is
  progress, then each stop's headline, file name, severity tags and ✓ seen); a bottom strip with
  findings counted by severity (text labels) and the area bar. No diffs.
- *Stop n of N*: a sticky top bar (label with the area, a `role="progressbar"` of stops seen with a
  text count, ‹ Prev / Next ›, Overview). At ≥ 1400 px a 210 px rail lists Overview, every stop
  (● current, ✓ seen, ⚑ findings, all in the button's accessible name too), Not in tour · K files and
  Wrap-up; below that the label becomes a "Stop n of N ▾" menu button with a list. The main column
  has the headline (h2), the detail at a 72ch measure, "Check: …", then the file's diff header (path,
  +/−, Full file, Comment on file, Open in Orca) and only the focused hunks.
- *Wrap-up*: stops seen (unseen ones as links), Not in the tour (each file's note and finding tags;
  pressing the file opens its whole diff inline), claims check, coverage, flows, and the review
  composer (below).

←/→ and j/k move between views when focus is not in a text field (arrows are left to a focused diff,
which scrolls sideways); every move is announced in a `role="status"` line outside the redrawn
area and focus goes to the new heading. Layout classes (`w-cols` ≥ 1100, `w-rail` ≥ 1400,
`w-narrow` < 600) come from a `ResizeObserver` on the tab's own `<html>`.

**Focused hunks** (`focusPieces` in `src/diff-model.ts`, pure). For each range: every row from its
first to its last PR-head line, the deleted rows straight above it (what it replaced) and right
after it, a trailing no-newline marker, and two unchanged rows of context on each side within the
hunk. A hunk header right above a shown run stays (it names the function). Everything else is a
gap, drawn as a "⋯ N unchanged lines" / "⋯ N other lines" button (`aria-expanded`, line span in its
label) that reveals those rows. No ranges, or ranges that land on no row, show the whole file.
Findings on shown lines sit under their line with the same Add to review / Dismiss state as
before; findings and pending comments on lines not shown are listed under the hunks as "Also in
this file" with **Show line N**, which switches to the full file and scrolls there. Full file toggles
(`aria-pressed`) the whole diff in place. The line "+" is now a 24×24 target (rows are 24 px).

**Review.** One element, two placements (`review.place`): the compact fixed bar on the overview and
stops, and inline in the wrap-up as the full composer: every pending comment (editable, sized to
its text), a summary pre-filled with `suggestedSummary` (`src/review.ts`: one line per finding the
reviewer added, most severe first; never saved or posted until they edit or confirm), then
Comment / Request changes / Approve (the last two hidden on your own PR, where Comment becomes the
primary button) and the existing confirmation with Post to GitHub.

**State.** `tour:<repo#n>` in plugin storage holds `{ commit, view, visited }` (plain JSON),
through two new requests: `tour.get { key, commit?, stops }` and `tour.save { key, state }`. Pure
rules in `src/tour.ts`: progress from another commit (or malformed) starts again at the overview
with nothing visited (Since your last review is part of the guide, so it stays); showing a stop
visits it; resume is the stop on screen, else the first unseen one. The worker adds
`QueueItem.tour` ("Stop k of N", "Reviewed tour" once every stop was seen, or null) from storage,
updates it on `tour.save`, and prunes the key with the guide. The panel shows it on ready rows.

**Estimate.** `~M min` = ceil(Σ over stops of (lines / 40 + 1)), where a stop's lines are the
added and unchanged diff lines of its file inside its focus ranges (all of the file's when it has
none), counted from the guide's stored `commentable` ranges, so the overview needs no diff.

**Tests.** `src/tour.test.ts` (state cleanup, reset on a new commit, visiting, resume, queue label,
estimate), `src/diff-model.test.ts` (focus with context and replaced lines, two hunks with gaps,
no focus / no matching row, merged ranges), `src/schema.test.ts` (focus and check required for the
agent, ranges outside the diff, too many ranges, stored guides without them, settle fallback),
`src/review.test.ts` (suggested summary), `src/worker.test.ts` (out-of-diff focus dropped after
the repair round, `tour.get`/`tour.save` persistence, reset for another commit, queue progress).
`src/panel.check.ts` has rows with tour progress.

**First real run** (`adamthewilliam/daedux#3`, 23 files): 198 s with one repair round (a finding
line outside the diff); 9 stops, all with focus (23 ranges, none dropped), 17 findings.

## v0.5: overview order and tour controls

Built after v0.4, from the first use of the tour on `daedux#3`. The reviewer couldn't close a file
once it was open or find a clear way out of the tour. The risk card repeated the findings, and its
Before merge items were generic ("Run oxlint/tsc and the build", "Check each analytics tab
visually"). The overview should read in this order: what, why and impact; then findings, changes
and risk; then the tour.

**Leaving the tour.** The top bar of a stop or the wrap-up starts with a labelled **✕ Exit tour**
button (`aria-keyshortcuts="Escape"`). **Esc** does the same when focus is not in a text field; an
open stop menu closes first. The plain "Overview" button is gone, but the rail keeps its Overview
entry. Exiting keeps progress, so the overview offers Resume.

**Collapsible files** (`editor/diff-view.ts`). Every file block's path is a toggle button: a
chevron plus the path, with `aria-expanded` and `aria-controls` pointing at the diff body. This
covers a stop's file, every row in Not in the tour and every row in Since your last review. A
stop's file starts open on its focused hunks. Closing it is remembered per stop in the stored tour
state (`TourState.collapsed: number[]`, plain JSON, cleaned like `visited` in `tourState`, set with
`setCollapsed`). A new commit or Restart opens every file again, and state stored before v0.5 loads
with every file open. Full file, Comment on file and Open in Orca stay; pressing Full file or
Comment on file on a closed file opens it. Files outside the stops are listed closed (the
`listed` variant: no card header, actions only while open). Each loads its diff the first time it
is opened and can be closed again. This replaces the v0.3 `diffToggle`, whose inline diffs could
not be closed from the diff itself.

**Overview, in reading order** (`editor/tour.ts`; no diffs):

1. Title, with the way in at the top right: **Start tour →**, or **Resume at stop k →** plus a
   small Restart. The meta line carries the risk as a text badge (`● Medium risk`, coloured by
   level).
2. Since your last review, full width, when there is one.
3. What / Why / Impact (about 60%) beside **Changes**, the stacked bar with a compact legend:
   label, +/−, files, with the numbers in aligned columns. At ≥ 1100 px these are two columns;
   below that, one column in the same order.
4. **Findings · 2 major · 6 minor · 4 nit** (counts as text), sorted blocker → nit, one row per
   finding: severity label, headline, `file:line` and **Stop n →**. `file:line` opens the stop
   that shows the finding at that line, opening the file if it was closed. A finding outside every
   stop opens the file at the line in the wrap-up's Not in the tour, and its row says "not in
   tour". Every blocker and major is listed; minors and nits after the first six wait behind
   **Show N more** (`aria-expanded`).
5. **Before merge**, only when the guide has items: a checklist of headlines, with no More.
6. **Tour · N stops · ~M min**: the stop list, in two columns at ≥ 1100 px. Pressing a stop starts
   the tour there.

The risk card is gone. Risk `detail` stays in the data but is no longer drawn. The risk headline
opens the Findings section only when it adds something: it is left out when at least half of its
keywords appear in the headlines of the most severe findings (`riskIntro`). On the regenerated
`daedux#3` guide it named the two major findings, so it is left out.

Pure helpers in the new `src/overview.ts`: `sortFindings`, `splitFindings`, `stopForFinding` (the
stop on the file whose focus covers the line, else the file's first stop), `riskIntro` and
`severityCounts`.

**Review bar.** The overview keeps the measured `--bar-h` bottom padding, so the last content clears
the bar. The bar's actions have 72 px of right padding so Orca's floating layout button never
covers Comment.

**Prompt** (`src/prompt.ts`, doc comment in `src/schema.ts`; same field shape, schema id still
`prguide/v2`). `risk.beforeMerge` is now limited to steps outside the code review that the merge
depends on: a migration, an env var, secret or config, a feature flag, deploy order, a backfill,
or coordination with another service. Generic advice (run the tests, lint or the build; check the
screens; review carefully) is explicitly ruled out, and most PRs should have `[]`.

**Also.** The wrap-up's "unseen stops" list has no bullets, because a bullet sat on the last line of
a wrapped button.

**Tests.** `src/tour.test.ts`: collapsed per stop, kept across moves, cleaned, plain JSON, empty for
old state and on a new commit. `src/overview.test.ts`: severity order, Show more split, stop for a
finding, the risk headline left out on the real `daedux#3` wording and kept otherwise, and the
counts. `src/schema.test.ts`: the prompt's Before merge rule. `src/worker.test.ts`: tour state with
`collapsed` round-trips through `tour.save`/`tour.get`.

**Real run** (`daedux#3`, one run): 109 s, no repair round. `beforeMerge` is now `[]` (it was two
generic items), with 12 findings (2 major, 6 minor, 4 nit; there were 17) and 9 stops, all
focused (14 ranges).

## v0.6: inline comments and panel polish

Built after v0.5, from a screenshot of commenting on `daedux#3`. "Comment on file" opened a
full-width form above the code with an optional line-number field, so whole-file and line comments
were mixed and the line was guesswork. After a suggested comment's Add to review, the confirmation
appeared in the review bar, far from the press, and the comment itself wasn't shown. Nothing marked
where pending comments were. The bar's "Comment" (post the whole review) was easy to confuse with
the composer's "Add to review", which wasn't styled as the main action.

### Comments in the guide tab

**Model** (`src/review.ts`). `DraftComment` gains optional `startLine`, the first line of a range.
It is left out, never `undefined`, so storage stays plain JSON. `asDraft` keeps it only when it's a
positive integer below `line` on a line comment. `rangeProblem(isCommentable, path, start, end)`
needs both ends to be added or unchanged PR-head lines and every line between them to be one too.
A hunk's PR-head lines are consecutive and hunks are separated by lines the diff doesn't show, so
this is GitHub's same-hunk rule without hunk headers, and it works from the guide's `commentable`
ranges and the worker's `isCommentable` alike. `staleComments` applies it to ranges after the PR
moves. `reviewPayload` adds `start_line` and `start_side: 'RIGHT'` when `startLine < line`.
`commentPlace` gives "line 38", "lines 34–38" or "the whole file".

**Composer** (`editor/review.ts`, `editor/diff-view.ts`). There is no line field anywhere:

- **+** on a hover-or-focus line (24×24, as before) opens the composer under that line, indented to
  the code column, `max-width: 760px`, titled "Comment on line 38". Shift+click, or Shift+Enter on a
  focused **+**, on a second line while a composer is open makes a range from the first line pressed
  ("Comment on lines 34–38"), in either direction. Typed text carries over. A range across hunks
  is refused in the composer's error line, with the reason, and the composer stays as it was.
- **Comment on file** (`aria-expanded`) opens the same composer under the file header: "Comment on
  the whole file".
- Textarea: 3 rows, grows with the text up to 12, focused on open. Hint "⌘↩ add · Esc cancel" on the
  left, then **Cancel** (ghost) and **Add to review** (primary, disabled while empty) on the right.
- **Esc** cancels an empty composer. With text, it leaves the field for Cancel and never throws text
  away. It never reaches the tour's Esc (exit tour).
- Focus returns to the line's **+** (or Comment on file) on cancel, and to the new card on add. The
  tab's `role="status"` line announces "Comment added on line 38", "Comment on lines 34–38 deleted".

**Pending comments in place.** Each comment is a card under its line (range comments under the last
line), or under the file header for whole-file comments: a **Pending** tag, "You", the body as text
with `backticks` as code, **Edit** and **Delete**. Edit reopens the same composer in the card's place
("Edit your comment on line 38", **Save**). Lines with a comment get a speech-bubble SVG in the **+**
slot (`aria-hidden`, under the **+**, which still shows on hover). They also get a hidden "Has a
pending comment" note and the **+** label "Comment on line 38 (has a pending comment)". Lines a range
covers, and the lines of an open composer, get a light tint and an accent bar at the gutter edge.

**Suggested comments.** A finding's **Add to review** (now primary) turns into "✓ In your review".
The comment's card appears under the same line, gets focus, and the status line announces it.
There's no message in the bar any more.

**Counts and moving between comments.** The file header shows "2 pending". Each stop in the rail and
in the stop menu shows its pending count, which updates in place as comments change, and the count
is in the button's name too. Pure helpers in the new `src/pending.ts`:

- `stopForComment`: the stop showing a finding on that line.
- `pendingByStop`
- `pendingOrder`: by stop, then files outside the tour, whole-file comments first, then by line.

**Review bar** (overview and stops): "Review · N pending" with **‹ ›** that go to the previous or
next pending comment across stops, wrapping around. They open its stop (or the wrap-up's Not in the
tour for a file outside it), reveal the gap that hides its line, scroll to the card and focus it.
With no comments the bar says "No comments yet" and has no ‹ ›. **Finish review →** (primary) goes
to the wrap-up. The verdict buttons and their confirmation are only in the wrap-up now, so
nothing in the bar reads like "Add to review". The bar's text line is only for errors. "Your own
PR: GitHub only takes comments here" is shown only in the wrap-up composer. The wrap-up's pending
list is in the same tour order, and each comment has **Show in diff →**. A comment whose line left
the diff after a push offers **Make it a whole-file comment** (or Delete) instead of a line field.

### Reviews panel (`src/panel.tsx`)

- **Risk** is one outlined pill for every level. The old `Badge` drew `danger` filled and
  `warning`/`success` outlined, and `Badge` has no variant prop. It's now a fixed-width (76 px)
  `Box` with `radius="full"` and a toned border around toned text. The word carries the meaning.
- **Rows without a risk** keep the same slot, with "Writing…", "Queued" or "No guide", so repo
  names line up. The status line under the title no longer repeats "Writing guide" or "Waiting to
  start" when the slot already says it. It still says "Updating guide" when an older guide exists.
- **Failed runs** read "Couldn't write the guide (rate limited)" with **Try again**. The full error
  is the button's tooltip, and **Open older guide** appears when one exists. A failed row is no
  longer pressable, so it can hold buttons. `failureReason` (new `src/failure.ts`) maps errors to
  "rate limited", "not signed in", "timed out" or "didn't match the format", else "see logs".
- **Your PRs** rows don't show the waited time, which there was the PR's age ("229d").
- **Empty queue** with Not queued or Your PRs rows shows one muted line, "Nothing waiting for your
  review" (plus Show my own PRs when that lane is off). The large empty state is only for when
  nothing is listed at all.
- **Current row**: `QueueState.openKey` is the guide last opened with `guide.open` or moved
  through in a tab (`tour.save`). Orca tells plugins nothing about editor focus. Its row gets
  `ListItem current`. The catalog has no trailing icon for `ListItem`, so there's no chevron. Rows
  with a guide stay pressable through `onPress`, as before.
- **Progress line**: "Tour · Stop 3 of 9 · 2 pending comments". `QueueItem.pendingComments` is
  read from `draft:<key>` on each check and updated on `review.save` and after posting.

### Tests

- `src/review.test.ts`: range validation (same hunk, either order, ends off the diff), the payload
  with and without `start_line`/`start_side`, ranges going stale, stored ranges kept and malformed
  ones refused.
- `src/pending.test.ts`: the stop for a comment, counts per stop, and ‹ › order.
- `src/failure.test.ts`: reason mapping.
- `src/worker.test.ts`: `pendingComments` after `review.save`, after a refresh (from storage) and
  after posting, and `openKey` after `tour.save`.
- `src/panel.check.ts`: a row with pending comments that is the current row, a failed row with a
  real-looking error, rows with no risk, and the new `onlyYourPrs` scenario (empty queue, Your PRs
  with a pending comment and a format failure).

## v0.6.1: Resume after a restart

- **Bug**: Restart, then ✕ Exit tour, showed "Resume at stop 2". `resumeStop` returned the first
  unvisited stop whenever the view wasn't a stop, and Restart had just visited stop 1.
- **Fix** (`src/tour.ts`): `TourState.last` is the stop shown most recently (`null` until one is),
  set by `showView` and kept on the overview and wrap-up; `freshTour` resets it, `tourState`
  range-checks it. Resume, and the queue row's "Stop k of N", go to the stop on screen, else
  `last`, else (states stored before `last`) the first stop not seen.
- **Tests**: `src/tour.test.ts` covers Resume after a restart and after going back a stop, and an
  old stored state without `last`.

## v0.7: changes breakdown

Built after v0.6.1. The overview's "Changes · by area" bar showed the agent's own areas, which are
a reading aid, not a classification: two guides of one PR could group files differently, and a
migration or a CI change could sit inside "Runtime" unnoticed. The author's Diff Breakdown plugin
already sorts a branch by kind of change, with stable rules. The overview now draws the PR the
same way.

**Overview.** The meta line is `daedux #3 · Open on GitHub`; branches, line counts and the file
count moved to Changes, so each appears once. The right column is the risk card, then **Changes ·
23 files**, laid out like Diff Breakdown's panel:

- `chore/shekel-ui → main` (mono) with the total `+597 −810`, then a share bar with one segment
  per kind, sized by changed lines, in Diff Breakdown's colours (`role="img"`, the shares in its
  label, each segment's numbers in its tooltip). Generated is left out of the bar and the total.
- One row per non-empty kind, in Diff Breakdown's order (Runtime, Tests, Contracts, DB migrations,
  CI/CD, Config & rollout, Dependencies, Docs, Generated): a chevron toggle (`aria-expanded`,
  `aria-controls`), colour dot, name, "N files", share (`formatShare`: never 0% or 100% for a real
  share; Generated says "not counted") and +/−. All closed at first; open kinds are remembered per
  PR in the frame's `localStorage` (`changes-open:<repo#n>`, every access in try/catch).
- An open kind lists its files: Catppuccin icon, name, folder (muted, ellipsis), git's status
  letter (A, M, D, R…; the full word in its tooltip and for screen readers), +/−, and where to
  review it. **Stop n →** opens the first stop on the file (opening the file if it was closed);
  **not in tour** opens it in the wrap-up's Not in the tour, opened and scrolled to, as findings
  outside stops do. Pressing the name does the same. Lockfiles have neither (they are not in the
  guide) and read "not in guide". Deleted files are struck through.
- The totals, the kinds and the files are one CSS grid (rows are subgrids), so the share and line
  count columns line up. Zero counts are left blank, as in Diff Breakdown.
- Under the rows, one muted line per risky kind with files no stop covers, e.g. "⚠ 1 dependency
  file isn’t in the tour · package.json" (the file is a link to the same place as its row). Kinds:
  Contracts, DB migrations, CI/CD, Config & rollout, Dependencies. Lockfiles don't count: no tour
  ever covers them.
- Below 1100 px the section is full width after What / Why / Impact and the risk card, same rows.

The agent's `areas` stay in the data and still label stops ("Stop 1 of 9 · Theme and design
tokens"); the overview no longer draws them, and `areaBar` and its styles are gone.

**Classification** (vendored, `src/breakdown/`). `categories.ts`, `classify.ts`, `share.ts`,
`colors.ts`, `icons/*` (resolver, associations, palette and the whole SVG set: 202 KB, well under
the 1 MiB per-file limit) and their tests are copied from orca-diff-breakdown v0.3.0, each headed
"Vendored from orca-diff-breakdown v0.3.0 (MIT); keep in step with it". `types.ts` holds the two
types they share from its `protocol.ts`; `parse.ts` holds its git output parsers (`--name-status
-z`, `--numstat -z`, `check-attr -z`). Precedence is Diff Breakdown's: the repo's
`.orca/diff-breakdown.json`, then `.gitattributes` linguist attributes, then ecosystem presets,
else Runtime. `THIRD_PARTY_NOTICES.md` carries Diff Breakdown's and Catppuccin's licences.

**Data.** New request `breakdown.get { key, commit? }` → `Breakdown`
(`src/breakdown/assemble.ts`):

```ts
{ headRef, baseRef, additions, deletions, fileCount,
  categories: [{ id, name, additions, deletions, omitted,
                 files: [{ path, oldPath?, status, additions, deletions, binary? }] }] }
```

The worker computes it from the local clone at the guide's commit, all read-only:

- `git diff --name-status -M -z base...commit` (status letters; the same cached call now gives
  `diff.get` its rename paths) and `git diff --numstat -M -z --no-textconv base...commit` (counts,
  lockfiles included). The guide stores no per-file counts, so they come from git; they follow the
  user's `diff.algorithm` like every other diff in the tab (on daedux#3, histogram gives
  +597 −810 where GitHub's Myers says +594 −807).
- Ecosystems from `git ls-tree -r --name-only -z <commit>`, cached per repo and commit.
- Overrides from `git show <commit>:.orca/diff-breakdown.json` (a bad file is logged and ignored).
- Attributes from `git check-attr -z --source=<commit> --stdin linguist-…`, so the PR head's
  `.gitattributes` is used, not the working tree's.
- A missing commit or base ref is fetched first (shared with `diff.get` as `cloneAt`).
- Cached per `key@commit` (failures dropped, so the tab's Try again retries). The worker warms the
  cache right after writing a guide; existing guides get the section on first open, with no agent
  run. Each kind lists at most 300 files (`omitted` counts the rest, shown as "N more files not
  listed"), keeping answers well under 1 MiB.

**Tests.** Vendored: `classify.test.ts`, `share.test.ts`, `colors.test.ts` (without its panel-only
literal check), `icons/resolve.test.ts`, `parse.test.ts`. New: `assemble.test.ts` (order and status
letters, renames' old path, binary files, Generated not counted, shares summing to the total, the
cap), `overview.test.ts` (`stopForFile`, `tourGaps` wording, lockfiles skipped, runtime never
flagged), `worker.test.ts` (`breakdown.get` grouping with presets from the tree and generated from
check-attr, `--source` and the range, caching, overrides at the head, the fetch when the commit is
missing, a non-hex commit refused).

### What / Why / Impact: headline only

The reviewer wants these short. On the overview they show the headline alone, with no More; risk
detail was already gone, and findings and stops keep their More. The prompt asks for
`summary.what/why/impact` as `{ headline }`: one plain sentence each, at most 20 words (was 25),
facts only, no filler or hedging, not restating the title, with the specifics in findings and
stops. `checkAgentGuide` enforces 20 words with that advice in the repair message, and still
accepts a `detail` there, so existing guides load (it just isn't shown). The existing daedux#3
guide was not regenerated; the prompt change applies to the next run. Tests: `schema.test.ts`
(the 20-word limit and message, an old detail still valid, the prompt wording).

## v0.8: full-coverage tour

Built after v0.7. The tour showed the files the agent picked (9 of 23 on `daedux#3`); the rest sat
in "Not in the tour" and a Changes line flagged risky ones it missed. Now one tour covers **every
changed file exactly once**, with attention weighted by importance.

**Model.** Each stop has a depth:

| Depth | What goes there | What the reviewer sees |
| --- | --- | --- |
| deep | files with a blocker/major finding, risky kinds (contracts, DB migrations, CI/CD, config, dependency manifests; not lockfiles), core logic | explanation, Check, the first file's focused hunks, findings and comments inline |
| skim | routine or repeated changes (one wrapper replaced in 9 section files) | headline, detail, a highlighted **Differences** note when files break the pattern, the representative file's focused hunks, then "Same change in N more files", each a closed file block that loads its diff when opened (with its file note) |
| skip | lockfiles, generated files, whitespace-only changes, pure renames | one last stop, **Skipped by design**: each file with a reason tag, closed, openable |

Deep and skim stops come in the order the change flows (contracts → core → callers → UI → tests);
the skip stop is always last.

**Data** (`src/schema.ts`, still `prguide/v2`). A stop is `{ depth, files (≥1; the first is the
primary/representative), why, areaId, headline, detail?, focus? (on the first file), check? (asked
on deep stops), differences? }`. `why` is one of `finding | risky | core | routine | repeated |
tests | docs`. Stored guides with the old `{ file, … }` stops still pass `checkGuide` and are read
as deep `core` stops (`upgradeStop`/`upgradeGuide`, applied by the worker's `getGuide` and the
tab). `PrGuide.skipped?: { path, reason: 'lockfile' | 'generated' | 'whitespace' | 'rename' }[]` is
worker-filled.

**Triage before the run** (new `src/triage.ts`, pure). The worker classifies the range with the
vendored Diff Breakdown classifier (now shared with `breakdown.get` through one cached
`changedFilesAt`) and runs one extra `git diff -w --numstat -M -z`:

- skipped: lockfile (`isLockfile`), else Generated kind, else status R with 0/0 lines (pure
  rename), else a file with line changes that is missing from the `-w` numstat (whitespace only);
- must be deep: files of a risky kind, lockfiles and skipped files excluded, limited to the files
  the guide covers.

**Prompt.** The full-coverage rule, the new stop shape, `<skipped_by_design>` and
`<must_be_deep>` lists (fenced as data), "a file where you report a blocker or major finding MUST be
in a deep stop", group repeated/routine changes into one skim stop with the clearest example first
and `differences` for outliers, and the flow order. Headline limits are unchanged.

**Enforcement** (new `src/coverage.ts`, pure). First round: `checkAgentGuide` with
`DiffContext.tour` adds coverage problems (file in no stop, file in two stops, skipped file in a
stop, risky or severe file in a skim stop) so the repair round can fix them. After the reply (and
the repair round, where `settle` also drops non-changed files from stops and fills a missing depth
or tag), `enforceCoverage` always runs: skipped/unchanged/duplicate files leave their stop (first
occurrence wins; focus goes with its first file; empty stops are dropped), risky and severe files in
a skim stop move to their own deep stop right after it (`why` risky/finding; the first takes the
skim's text if nothing is left), and files in no stop are appended: risky/severe ones as deep stops,
the rest in one skim stop "Other changes the agent didn’t place in a stop". `fullTour` runs the same
function when a guide is opened, so older guides get full coverage too (missing files appended, so
stored stop indices stay put). Every fix is logged.

**Requests.** New `skipped.get { key, commit? }` for guides written before `skipped` was stored
(cached per `key@commit`). `tour.get`'s `stops` now counts the skip stop.

**Progress counts files** (`src/tour.ts`). `filesCovered(visited, shape)`: a file is covered once
its stop was shown; skipped files once the skip stop was. The skip stop is the last stop index, so
`TourState` keeps its shape and older states load. Queue label: "18 of 23 files" (panel: "Tour · 18
of 23 files · 1 pending comment"), "Reviewed tour" when all are covered. Estimate: deep as before;
skim = representative's lines / 40 + 1 + 1 minute per 5 more files; skip 0.

**UI** (`editor/tour.ts`, `editor/changes.ts`, `editor/style.ts`).

- Overview tour list: "Tour · 13 stops · covers 23 files · ~22 min"; each row has a **Deep**/**Skim**
  text tag, the why ("repeated change"; "has findings" is left out when severity tags say it), the
  file name or "6 files", severity tags and ✓ seen; the last row "Skipped by design · 1 file" with
  the reasons.
- Top bar: "Stop 10 of 13 · Skim · Area" (or "Skipped by design"); the progress bar and its text are
  "17 of 23 files covered · 1 skipped by design". Without the rail the bar takes its own line under
  the controls (focus padding raised to match).
- Rail: each stop shows the first file, "+N" for more, and a DEEP/SKIM word (also in the button's
  name), then "Skipped · N files".
- Wrap-up: "5 files not covered yet, in these stops:" with links (the top bar already shows the
  count), or "You’ve covered all 23 files."
- Removed: the wrap-up's Not in the tour, the rail's Not in tour entry, the Changes ⚠ gap lines
  (`tourGaps`) and "not in tour" labels. Every Changes row resolves: "Stop n →", or "Skipped →" for
  skipped files (lockfiles included). Findings and pending comments on a skim stop's other file open
  that file's block at the line; comments on skipped files belong to the skip stop.

**Tests.** `coverage.test.ts` (missing files, duplicates, skipped/unchanged removal with focus,
must-be-deep moves, all-deep skim, `fullTour` on an old guide), `triage.test.ts` (lockfile,
generated, rename, whitespace, precedence, risky files), `schema.test.ts` (old single-file stops
load as deep, stop shape, first-round coverage problems, prompt wording), `tour.test.ts` (skip stop
index, files covered, label, skim estimate), `overview.test.ts`/`pending.test.ts` (multi-file
stops, skip stop lookup), `worker.test.ts` (a reply that leaves README out, skims a contract file
and puts a lockfile in a stop: one repair round, then the worker moves and appends; `skipped`
stored; `skipped.get` on an older guide; file-based queue labels).

**Real runs** (`daedux#3`, 23 files). Run 1: 207 s wall; 13 stops (7 deep, 6 skim) + `bun.lock`
skipped. Run 2 (kept; logs captured): 156 s wall, 144 s in the agent, no repair round, no coverage
fixes needed; 13 stops: 7 deep, 6 skim (6 + 2 + 2 + 2 files in the repeated ones), `bun.lock`
skipped as a lockfile, `package.json` given its own deep stop as required.
