# Review Desk

An [Orca](https://github.com/stablyai/orca) plugin for reviewing pull requests without leaving
Orca.

- **Review Desk panel** in the right sidebar: PRs waiting on you, PRs you reviewed and may need to
  look at again, and your own, each with its next action.
- **A guide per PR**, written by your own agent CLI (Claude Code or Codex): what the PR does, why,
  its risk and findings, and a walkthrough that groups the change into a few ideas, each with
  every file it touches.
- **Real diffs** with syntax colours from your editor theme (Cursor Dark or Armada), GitHub's
  Viewed state per file and per folder, and a file tree.
- **Comments** posted straight away or gathered into one review, with the suggested comments from
  the guide's findings.
- **A worktree on the PR's own branch**, so you can run and test it while you review, and Open in
  Orca opens files there.

Nothing reaches GitHub until you press Comment or Post to GitHub.

## Install

You need Orca 1.4.259 or newer, `gh` signed in (`gh auth status`), and `claude` or `codex` signed
in. Add each repository you review to Orca as a project.

```sh
orca plugin install SheaGuev/orca-review-desk
```

Or from a local checkout: `orca plugin install /path/to/this/folder`.

Orca lists what the plugin can access and prints the command to approve it.

## Develop

No build step: Orca transpiles the TypeScript when it loads.

```sh
bun install && orca plugin types .
bun run typecheck && bun run lint && orca plugin test .
orca plugin dev watch .
```

`bun scripts/vendor-shiki.ts` rebuilds the bundled highlighter; `bun scripts/vendor-code-themes.ts`
rebuilds the code themes from `scripts/code-themes/`.

## Credits

Based on [PR Tour](https://github.com/adamthewilliam/orca-pr-tour) by Adam Williams, MIT. Guides
PR Tour already wrote are picked up the first time you open their PR here; its files are left as
they are. Other credits are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
