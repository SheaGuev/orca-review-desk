# PR Tour

An Orca plugin that keeps a review queue of the PRs waiting for you, in the order to review them,
and has your own agent CLI write a guide for each one: the risk, findings with ready-to-post
comments, what it does and why, where the changes are, what changed in reading order, a note on
every changed file, before/after flows, a check of the PR description against the diff, and what
changed since your last review. You can review from the guide: comments, Approve, Request changes
or Comment, posted as one GitHub review by pressing **Post to GitHub**.

Everything runs inside Orca on your machine, with your own `gh` and agent sign-ins. Nothing is
posted to GitHub except by pressing **Post to GitHub** in a guide, and no CI is involved.

## Where it shows up in Orca

| Where | What |
| --- | --- |
| Right sidebar, **Reviews** (gauge icon) | The queue (direct and team requests, team ones tagged), then **Not queued** and **Your PRs**, folded |
| Editor tab for `*.prtour.json` | The guide as a tour of every changed file: overview, then deep stops (one idea, only the hunks that explain it) and skim stops (one example of a routine change, the other files listed), the files skipped by design last, then **Finish review**, where you settle the findings and post the review (**Review guide** view; Orca's **Source** shows the JSON) |
| Status bar | `PR tour: High risk` for the focused branch, or `Reviews: N`; pressing it opens the guide |
| Command palette | `PR Tour: Check for review requests`, `Open guide for this branch`, `Generate guide for this branch` |
| Settings → Plugins → PR Tour | Agent harness, model, teams, team filter, daily limit, extra instructions |

## How guides get made

1. Every 5 minutes (and when you press refresh) the worker asks GitHub, through `gh`, for open PRs
   that request **your** review (`user-review-requested:@me`), PRs for the **teams** you list in
   Settings, and optionally **your own** PRs.
2. The first time a repository appears, the panel asks once whether to keep guides up to date
   there. Until you turn it on, each PR has a **Generate** button.
3. In a repository you turned on, a guide is made in the background for direct requests, and for
   team requests that pass your filter (owns files per `CODEOWNERS`, at least N lines). Drafts and
   lockfile-only PRs are skipped, and automatic runs stop at your daily limit.
4. The worker fetches the PR into `refs/pr-tour/*` of your local clone (your working tree is not
   touched), puts whole per-file diffs in the prompt up to 180k characters (source first, then
   config, tests, docs; lockfiles left out), lists the rest with the command to read each, and runs
   the agent headless with read-only tools:
   - Claude Code: `claude -p --model <m> --tools Read,Grep,Glob,Bash` with Bash limited to
     `git diff/show/log`, no MCP servers, no project settings from the PR's repo, no saved session.
   - Codex: `codex exec -m <m> --sandbox read-only`.
5. The reply is checked against `prguide/v2` (`src/schema.ts`): headline word limits, every file
   and finding line must exist in the diff, every changed file needs a note, and the tour covers
   every changed file once (skipped files, decided by the worker, in none; risky files and files
   with a blocker or major finding in deep stops). After the repair round the worker enforces
   coverage itself (`src/coverage.ts`). A reply that doesn't
   match gets one repair attempt; after it, a finding line outside the diff becomes a whole-file
   finding and a missing note is filled in. Counts, commit, comment lines, provenance and
   **coverage** (which files were in the prompt, which the agent opened with its tools, which
   neither) are filled in by the worker, never by the agent. Guides from v0.1 still open and are
   replaced by the next automatic run.
6. When the author pushes, the guide is updated after pushes settle (90 s). Opening a guide records
   the commit you saw, so the next update adds **Since your last review**.

Pressing a queue row writes the guide to `.pr-tour/pr-<n>.prtour.json` in the repo's Orca
workspace (adding `.pr-tour/` to `.git/info/exclude`, so it never shows up in `git status`) and
opens it.

## The queue

Order: new commits since your review first, then risk high to low (no guide yet counts as
medium), then whoever has waited longest, by the time your review was requested (GitHub
timeline, one GraphQL query per repo). One notice line appears only when it matters: GitHub
unreachable, the agent not signed in, or the daily limit reached (which resets at local midnight).

## Reviewing from the guide

Hover or focus an added or unchanged line and press **+** to comment on it; Shift+**+** on a
second line of the same hunk makes it a range. **Comment on file** comments on the whole file. Each
opens a composer in place (no line numbers to type), and pending comments show as cards under
their line, with a marker in the gutter. A finding's **Add to review** turns its suggested comment
into such a card. The draft is kept by the worker per PR, so it survives closing the tab. The review
bar counts pending comments, steps through them with ‹ ›, and **Finish review →** opens the
last step: first the blocker and major findings you have not added or dismissed, then the review,
where you edit the comments and summary, choose **Comment**, **Request changes** or **Approve** (no
choice on your own PR, which only takes comments). A line under them says where the review goes,
as what, and what it carries, and what is not done yet (open findings, files not covered);
**Post to GitHub** below it is the only thing that posts:

1. If the PR moved since the guide, every line comment is checked against the new diff; any that
   no longer fit are shown for fixing and nothing is posted.
2. Line comments go in one review (`POST /repos/{repo}/pulls/{n}/reviews`, RIGHT side of the head;
   a range adds `start_line`).
3. Whole-file comments follow one by one (`subject_type: file`); one GitHub refuses stays in the
   draft and is listed.

## Changes on the overview

The guide's overview groups the PR's files by kind, the same way the
[Diff Breakdown](https://github.com/adamthewilliam/orca-diff-breakdown) plugin groups a branch:
Runtime, Tests, Contracts, DB migrations, CI/CD, Config & rollout, Dependencies, Docs, and
Generated (listed, not counted). The repo's `.orca/diff-breakdown.json` at the PR head wins, then
its `.gitattributes`, then built-in presets for the ecosystems found in the repo. Each file row says
where to review it: its tour stop, or the skipped files' stop. Line counts
follow your git `diff.algorithm`, so they can differ a little from GitHub's.

File icons are [Catppuccin for VSCode Icons](https://github.com/catppuccin/vscode-icons) (MIT). See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Requirements

- A local clone of the repository added to Orca as a project (the plugin reads diffs from it).
- `gh` signed in (`gh auth status`), and `claude` or `codex` signed in.
- Orca 1.4.259 or newer.

## Develop

```sh
bun install                 # typings, TypeScript, oxlint, oxfmt and a headless DOM for tests; nothing is bundled
bun run typecheck           # tsc against Orca's typings (.orca/types, written by `orca plugin types .`)
bun run lint                # oxlint with type-aware rules (.oxlintrc.json); `lint:fix` applies safe fixes
bun run format              # oxfmt (.oxfmtrc.json); `format:check` only reports
orca plugin test .          # diff, queue, review, schema, CODEOWNERS, prompt; worker end to end with faked git/gh/claude; the guide tab in a headless DOM
orca plugin check .         # renders the panel in each src/panel.check.ts scenario and checks the editor
orca plugin dev watch .     # load into Orca and stream logs
orca plugin dev request . queue.refresh --json
```

| File | What it does |
| --- | --- |
| `src/worker.ts` | Puts the worker together and polls |
| `src/worker-state.ts` | What the worker knows between requests, and the panel's queue made from it |
| `src/queue-check.ts` | One check of GitHub: the PRs waiting, their details and request times |
| `src/run-queue.ts`, `src/guide-run.ts` | Agent runs one at a time (settle wait, daily limit), and one run from start to stored guide |
| `src/requests.ts` | The panel's and the guide tab's requests and the palette commands, inputs checked |
| `src/open-guide.ts`, `src/focus.ts` | Opening a guide in its workspace; the focused workspace and the status bar item |
| `src/write-guide.ts` | One agent run: fetch the PR, build the prompt, ask (and once more if the reply doesn't fit), fill in the worker's facts |
| `src/queue-items.ts` | One PR as the queue shows it: the lane searches, why it gets no automatic guide, its status |
| `src/pr-data.ts` | What the guide tab asks git about a PR at a commit (a file's diff, the Changes breakdown, skipped files), cached |
| `src/review-service.ts`, `src/post-review.ts` | The draft a guide tab saves, and checking and posting it as one GitHub review |
| `src/store.ts` | The plugin's storage by what is kept in it; every read is checked |
| `src/clones.ts`, `src/git.ts` | Which local clone holds which repository, and the git calls made on it |
| `src/settings.ts`, `src/status-bar.ts`, `src/tour-progress.ts` | Settings as the worker uses them, the status bar's text, a row's tour progress |
| `src/json.ts`, `src/errors.ts`, `src/cache.ts` | Reading unchecked JSON, request errors with a code, remembered answers and bounded concurrency |
| `src/github.ts` | `gh` calls: search, PR details, review-request times, your review comments, canonical repo names |
| `src/agent.ts` | Agent command lines and reading their output, including Claude's tool calls |
| `src/diff.ts` | Per-file diffs, the prompt budget, commentable lines, coverage from tool calls |
| `src/queue.ts` | Queue order and grouping |
| `src/review.ts` | The review draft, range checks and the GitHub payloads |
| `src/pending.ts` | Pending comments per tour stop and the order ‹ › steps through them |
| `src/failure.ts` | A failed run's error as a short reason for the panel |
| `src/prompt.ts` | The instructions and data the agent gets |
| `src/schema.ts` | The `prguide/v2` contract (and v1 for old files), shared by the worker and the editor |
| `src/repo.ts` | Remote URLs, `CODEOWNERS` matching, lockfile detection |
| `src/panel.tsx` | The Reviews panel (components UI) |
| `editor/main.ts` | The guide tab: tour state, moving between views, layout by tab width |
| `editor/tour.ts` | The overview, stop and wrap-up views |
| `editor/changes.ts` | The overview's Changes: files by kind, as Diff Breakdown draws a branch, and where to review each |
| `src/breakdown/` | Kinds of change, from [Diff Breakdown](https://github.com/adamthewilliam/orca-diff-breakdown) v0.3.0 (vendored, MIT); `assemble.ts` groups a PR's files |
| `editor/diff-view.ts` | One file's diff: a stop's focused hunks, or the whole file; loading it, open and closed |
| `editor/diff-draw.ts`, `editor/diff-composers.ts` | Drawing the view from its state (rows, notes under lines, going to a line); opening composers on a line, a range or the file |
| `editor/diff-frame.ts`, `editor/diff-rows.ts` | The view's elements; the rows, gaps, finding cards and gutter marks it is drawn from |
| `src/tour.ts` | Tour state (view, stops seen, files collapsed), progress label and reading-time estimate |
| `src/overview.ts` | The overview's findings (order, Show more, the stop for each) and each file's stop |
| `src/triage.ts` | Files the tour skips by design (lockfile, generated, whitespace only, pure rename) and risky files that need a deep stop |
| `src/coverage.ts` | Full coverage: every changed file in exactly one stop, risky and severe files deep, enforced after the agent replies |
| `editor/review.ts` | Suggested comments, composers and pending comment cards in the diffs |
| `editor/review-session.ts` | The draft in a guide tab: saving it and redrawing what shows it |
| `editor/review-bar.ts`, `editor/review-verdict.ts` | The review bar, and the wrap-up's composer that posts the review |
| `editor/composer.ts` | The comment text field with Add and Cancel |
