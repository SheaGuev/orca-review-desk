# Contributing

## Set up

You need [Orca](https://github.com/stablyai/orca), [Bun](https://bun.sh), and `gh` plus `claude`
or `codex` signed in.

```sh
bun install              # TypeScript, oxlint, oxfmt and a headless DOM for tests; nothing is bundled
orca plugin types .      # Orca's typings, into .orca/types
orca plugin dev watch .  # load into Orca, stream logs and reloads; Ctrl-C unloads
```

The first load prints what the plugin can access and asks you to approve it. There's no build
step: Orca transpiles the TypeScript when it loads, and reloads on save.

To call the worker without opening the panel:

```sh
orca plugin dev request . queue.refresh --json
```

## How a guide gets made

1. **Find PRs.** Every 5 minutes the worker asks GitHub through `gh` for PRs requesting your
   review (`user-review-requested:@me`), your teams' PRs, and optionally your own.
2. **Decide.** In a repository you turned on, direct requests get a guide, and team requests do
   when they pass the filter. Drafts and lockfile-only PRs are skipped. Automatic runs stop at the
   daily limit, which resets at local midnight.
3. **Fetch and prompt.** The PR is fetched into `refs/pr-tour/*`. Whole per-file diffs go in the
   prompt up to 180k characters (source first, then config, tests, docs; lockfiles left out). The
   rest are listed with the command to read each.
4. **Check the reply** against `prguide/v2` (`src/schema.ts`): headline word limits, every file and
   finding line must be in the diff, every changed file needs a note, and the tour covers each
   changed file once. A reply that doesn't fit gets one repair round.
5. **Fill in facts.** After that, the worker enforces coverage itself (`src/coverage.ts`), turns a
   finding line outside the diff into a whole-file finding, and fills in a missing note. Counts,
   commit, provenance and coverage (which files were in the prompt, which the agent opened, which
   neither) always come from the worker, never the agent.
6. **Update.** When the author pushes, the guide is rewritten once pushes settle (90 s). Opening a
   guide records the commit you saw, so the next one adds **Since your last review**.

Guides from v0.1 still open and get replaced by the next automatic run.

Posting a review: line comments go in one review (`POST /repos/{repo}/pulls/{n}/reviews`, on the
RIGHT side of the head, with `start_line` for a range). Whole-file comments follow one by one
(`subject_type: file`). One that GitHub refuses stays in the draft and is listed.

## Where things are

### Worker

| File                                                  | What it does                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `src/worker.ts`                                       | Puts the worker together and polls                                                               |
| `src/worker-state.ts`                                 | What the worker knows between requests, and the panel's queue made from it                       |
| `src/requests.ts`                                     | The panel's and guide tab's requests and the palette commands, inputs checked                    |
| `src/queue-check.ts`                                  | One check of GitHub: the PRs waiting, their details and request times                            |
| `src/queue-items.ts`                                  | One PR as the queue shows it: lane, why it gets no automatic guide, status                       |
| `src/queue.ts`                                        | Queue order and grouping                                                                         |
| `src/run-queue.ts`, `src/guide-run.ts`                | Agent runs one at a time (settle wait, daily limit), and one run from start to stored guide      |
| `src/write-guide.ts`                                  | One agent run: fetch, prompt, ask (once more if the reply doesn't fit), fill in the worker facts |
| `src/open-guide.ts`, `src/focus.ts`                   | Opening a guide in its workspace; the focused workspace and the status bar item                  |
| `src/pr-data.ts`                                      | What the guide tab asks git about a PR at a commit, cached                                       |
| `src/review-service.ts`, `src/post-review.ts`         | The draft a guide tab saves, and checking and posting it as one GitHub review                    |
| `src/store.ts`                                        | The plugin's storage; every read is checked                                                      |
| `src/clones.ts`, `src/git.ts`                         | Which local clone holds which repository, and the git calls made on it                           |
| `src/github.ts`                                       | `gh` calls: search, PR details, request times, your review comments, repo names                  |
| `src/agent.ts`                                        | Agent command lines and reading their output, including Claude's tool calls                      |
| `src/settings.ts`, `src/status-bar.ts`                | Settings as the worker uses them, and the status bar text                                        |
| `src/tour-progress.ts`                                | A queue row's tour progress                                                                      |
| `src/json.ts`, `src/errors.ts`, `src/cache.ts`        | Reading unchecked JSON, request errors with a code, caching and bounded concurrency              |
| `src/failure.ts`                                      | A failed run's error as a short reason for the panel                                             |

### Guide content

| File               | What it does                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `src/prompt.ts`    | The instructions and data the agent gets                                                        |
| `src/schema.ts`    | The `prguide/v2` contract (and v1 for old files), shared by the worker and the editor           |
| `src/diff.ts`      | Per-file diffs, the prompt budget, commentable lines, coverage from tool calls                  |
| `src/triage.ts`    | Files the tour skips by design, and risky files that need a deep stop                           |
| `src/coverage.ts`  | Every changed file in exactly one stop, risky and severe files deep                             |
| `src/tour.ts`      | Tour state (view, stops seen, files collapsed), progress label and reading time                 |
| `src/overview.ts`  | The overview's findings (order, Show more, the stop for each) and each file's stop              |
| `src/review.ts`    | The review draft, range checks and the GitHub payloads                                          |
| `src/pending.ts`   | Pending comments per stop and the order ‹ › steps through them                                  |
| `src/repo.ts`      | Remote URLs, `CODEOWNERS` matching, lockfile detection                                          |
| `src/breakdown/`   | Kinds of change, vendored from Diff Breakdown v0.3.0 (MIT); `assemble.ts` groups a PR's files   |

### UI

| File                                                | What it does                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------------- |
| `src/panel.tsx`                                     | The Reviews panel (components UI); `src/panel.check.ts` has its scenarios  |
| `editor/main.ts`                                    | The guide tab: tour state, moving between views, layout by tab width       |
| `editor/tour.ts`                                    | The overview, stop and wrap-up views                                       |
| `editor/changes.ts`                                 | The overview's Changes: files by kind, and where to review each            |
| `editor/diff-view.ts`                               | One file's diff: a stop's focused hunks or the whole file                  |
| `editor/diff-draw.ts`, `editor/diff-composers.ts`   | Drawing the diff from its state; opening composers on a line, range or file |
| `editor/diff-frame.ts`, `editor/diff-rows.ts`       | The diff's elements; the rows, gaps, finding cards and gutter marks        |
| `editor/review.ts`                                  | Suggested comments, composers and pending comment cards in the diffs       |
| `editor/review-session.ts`                          | The draft in a guide tab: saving it and redrawing what shows it            |
| `editor/review-bar.ts`, `editor/review-verdict.ts`  | The review bar, and the wrap-up's composer that posts the review           |
| `editor/composer.ts`                                | The comment text field with Add and Cancel                                 |

Most changes touch the prompt (`src/prompt.ts`) and the contract (`src/schema.ts`) together. If you
change the contract, update the editor views that read it and add a case to `src/schema.test.ts`.

## Before you open a pull request

```sh
bun run typecheck
bun run lint
bun run format:check
orca plugin test .
orca plugin check .
orca plugin validate .
```

All six must pass. `orca plugin test .` runs the worker end to end with faked git, `gh` and
`claude`, and the guide tab in a headless DOM. `orca plugin check .` renders the panel in each
`src/panel.check.ts` scenario.

For a UI change, add a screenshot to the pull request:

- Panel: `orca plugin shot local.pr-tour`
- Guide: `orca plugin shot local.pr-tour --editor <repo>/.pr-tour/pr-<n>.prtour.json`

Both save to `.orca/shots/`.

Keep a pull request to one change. Commit messages start with the area when it helps, such as
`Guide: …`, `Queue: …` or `README: …`.

## Release

Releases are Git tags. `orca plugin install` and the [plugin directory](https://orca.dev/plugins)
pick the newest `vX.Y.Z` tag.

1. Set the new `version` in `orca-plugin.json`.
2. Run the six checks above.
3. Commit and push: `git commit -am "Release vX.Y.Z" && git push origin main`.
4. Tag that commit and push the tag: `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`.
5. Check https://orca.dev/plugins/adamthewilliam/orca-pr-tour.

The repository needs the `orca-plugin` topic for the directory to list it (already set).

Things to know before tagging:

- Users update without being asked unless the release needs new access. A new capability, panel,
  command or event subscription, or a higher execution profile, makes every user approve again.
- Set `engines.orca` to the newest Orca release whose features you use. The directory checks the
  plugin against the latest Orca release and holds the listing if it fails.
- Listing images in `assets/` (`icon`, `cover`, `screenshots` in the manifest) must be static PNG,
  JPEG or WebP (the icon PNG or WebP). The icon is square, at least 128×128 and at most 256 KB,
  rendered from `assets/icon.svg` with `rsvg-convert -w 512 -h 512 assets/icon.svg -o assets/icon.png`.
  The cover is at least 800×500 and at most 1 MB, each screenshot at least 1280×800 and at most
  1.5 MB, with at most 6 screenshots. Leave out a screenshot's `theme`: it hides the screenshot
  from everyone using the other Orca theme.
