# PR Tour: more agents, technical plan

Status: agreed scope, Phases 0 to 5 built; all eight agents enabled, claude and codex verified with
`verify-agent`. Written 2026-11-22.

Today PR Tour runs two agent CLIs, Claude Code and Codex (`src/agent.ts`). Users of other agents
read that as "Claude Code only". This plan adds a first wave of eight agents and a repeatable way
to add more, without weakening the promise in the README that the agent runs with read-only tools.

## Goals

1. **Eight agents in the first release**: claude, codex, cursor, copilot, gemini, droid, qwen, pi.
2. **No agent needs a shell.** The worker prepares everything the agent would have fetched with
   git, so every agent only needs file read tools.
3. **Adding an agent is mostly data**: one spec, an argv snapshot test, and a passing
   `verify-agent` run on a real install.
4. **Works the same on macOS, Linux and Windows.** No OS sandbox dependency.

Non-goals: every agent Orca lists (45, of which ~41 have some headless mode), an OS-level sandbox,
a "custom command" harness, giving agents git history (`git log`, blame).

## Decisions already made

| Topic | Decision |
| --- | --- |
| Agent set | First wave of eight (above). Second wave only after `verify-agent` passes. Agents with no read-only mode are not supported (§8) |
| Selection rule | An agent qualifies when its headless mode can be held to read-only tools by the CLI itself, preferring CLIs that are read-only **by default** over ones that need the right flags |
| Shell access | None, for any agent. Claude loses `Bash`. The worker writes the files git would have shown (§2) |
| OS sandbox | Not used. Tested `@anthropic-ai/sandbox-runtime` on macOS and it works, but Linux needs `bubblewrap`/`socat`, Windows an admin install, and it is pre-1.0. Orca does not sandbox its own headless runs either. Revisit as optional hardening later |
| Model setting | Defaults to empty: each CLI uses its own default model (Phase 0) |
| Source of specs | Orca's headless specs (`src/shared/source-control/ai/generation/commit-message-agent-specs-*.ts`, MIT) where they exist, each flag re-checked against the CLI's `--help` or docs. Credit in `THIRD_PARTY_NOTICES.md` |

## Overview of changes

| Phase | Area | Files | Change |
| --- | --- | --- | --- |
| 0 | Agent runs | `src/agent.ts`, `orca-plugin.json` | Done: model default `""`; Claude retries once without `--strict-mcp-config` under an enterprise MCP config |
| 1 | Prepared files | new `src/run-files.ts`, `src/prompt.ts`, `src/diff.ts`, `src/write-guide.ts`, `src/worker.ts`, `src/exec.ts`, `src/agent.ts` | Done: PR files and overflow diffs written to `.orca/pr-tour-runs/<pr>/` (first `.pr-tour/runs/<pr>/`); prompt drops git commands; Claude loses `Bash` |
| 2 | Safety | `src/exec.ts`, `src/agent.ts`, `src/github.ts`, `src/queue-items.ts`, `src/queue-check.ts`, new `src/secrets.ts`, new `src/git-guard.ts`, `src/write-guide.ts`, `src/guide-run.ts`, `src/post-review.ts` | Done: clean agent env, secret scan of replies and reviews, auto-run only for trusted authors, `.git` tamper check |
| 3 | Spec table | `src/agent.ts`, `src/settings.ts`, `src/exec.ts`, `src/write-guide.ts`, `src/guide-run.ts`, `src/worker-state.ts`, `src/failure.ts` | Done: `Harness` union became the `AGENTS` table; "isn't installed" notice; argv diff budget |
| 4 | First wave | `src/agent.ts`, new `scripts/verify-agent.ts`, `scripts/verify-checks.ts` | Done: specs for cursor, copilot, gemini, droid, qwen, pi (all offered; only claude, codex verified); conformance script |
| 5 | Settings, README | `orca-plugin.json`, `README.md`, `THIRD_PARTY_NOTICES.md` | Done: Settings lists all eight agents; README and Orca credit |

## Phase 0: fixes (done, uncommitted)

- `orca-plugin.json`: `model` default `""`. Switching to Codex no longer passes it `claude-opus-5-5`.
- `src/agent.ts`: when Claude refuses `--strict-mcp-config` ("You cannot use --strict-mcp-config
  when an enterprise MCP config is present"), run once more without it and with
  `--disallowedTools mcp__*`. Any other failure is not retried.
- Tests: `src/agent.test.ts` (3 tests). Suite: 167 pass, 0 fail.

## 1. Prepared files (new `src/run-files.ts`)

Today the prompt tells the agent to run `git diff <base>...<head> -- <path>` for files over the
budget and `git show <head>:<path>` to read the PR's version of a file (`src/prompt.ts:97-115`,
`:148`). The worker does that instead, before the agent starts.

**Where**: `<clone>/.pr-tour/runs/<pr>/`. `.pr-tour/` is already in `.git/info/exclude`. Inside the
clone means inside every agent's working directory, so no CLI needs grants for outside paths.

**What**:

```
.pr-tour/runs/7/
  index.txt          one line per file: "<n>  <pr path>  diff|head"
  diffs/0001.diff    per-file diff of each file left out of <diff> (FileDiff.text, already in memory)
  head/0001.txt      the PR's version of each changed file
```

- Diffs cost nothing: `budgetDiff` already holds `FileDiff.text` for `outside` files.
- PR versions: one `git cat-file --batch` process over `refs/pr-tour/pr-<n>:<path>` for every
  changed file, skipping lockfiles, generated files, binaries and deletions (the same triage as today).
- **Neutral names** (`0001.txt`): a PR that adds `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` or
  `.cursor/rules/*` must not become instructions the agent loads because a copy sits in its tree
  under the real name.
- Cleanup: `rm -r` in `runAgent`'s existing `finally`; on worker start, remove any `.pr-tour/runs/*`
  left by a crash.

**Prompt** (`src/prompt.ts`): `outsideSection` lists `read .pr-tour/runs/7/diffs/0001.diff` per
file; the "run `git show`" line becomes "the PR's version of each changed file is in
`.pr-tour/runs/7/head/` (see `index.txt`)". No git commands remain in the prompt.

**Coverage** (`src/diff.ts:191`, `filesReadByAgent`): map read paths under the run directory back to
PR paths through the index, in place of parsing `git show` / `git diff` command lines. Agents that
report no tool calls keep today's behaviour: files not in the prompt show as not read.

**Claude** loses `Bash`: `--tools Read,Grep,Glob`, `--allowedTools Read,Grep,Glob`. This also closes
`git diff --output=<path>`, which `Bash(git diff:*)` allows and which git uses to write a file.

Lost capability: the agent can no longer look at history. If guides miss it, add the PR's commit
list to the prompt from the worker.

**As built** (differences from the above):

- `index.txt` lines are `<n>  <kinds>  <pr path>`, e.g. `0003  diff head  src/big.ts`: one line per
  file with both kinds it has, path last so a path with spaces stays unambiguous. Numbers count
  only files that got something.
- Cleanup is a `finally` in `writeGuide` (`src/write-guide.ts`), not in `runAgent`: the repair
  round runs the agent a second time on the same files. An empty `runs/` is removed too.
- Stale runs: on worker start, `.orca/pr-tour-runs/` (and the old `.pr-tour/runs/`) is removed in
  every local git project Orca lists (`project.list`), before the first check.
- Coverage maps through the index kept in memory (`RunFiles.byPrepared`), not by re-reading
  `index.txt`. Parsing of `git show` / `git diff` Bash calls is gone; `Read` of a changed path in
  the clone still counts.
- `git cat-file --batch` output is read as latin1 (`RunOptions.stdoutEncoding` in `src/exec.ts`) so
  object sizes are byte counts and files in any encoding are written byte for byte.
- `writeRunFiles` refuses when `.orca` or `.orca/pr-tour-runs` is a link (a repository could commit
  one), and `.orca/pr-tour-runs/` (and the guide folders) are added to `.git/info/exclude` before writing.
  Cleanup skips a linked `.orca` too, so it never deletes outside the clone.
- **Run files moved from `.pr-tour/runs/<pr>/` to `.orca/pr-tour-runs/<pr>/`.** Orca's dev watcher
  reloads a plugin loaded with `orca plugin dev` on any change in its folder outside `.git`, `.orca`
  and `node_modules`. Reviewing PR Tour's own PR in its dev folder, writing the run files reloaded
  the plugin, which killed the run; the worker resumed it, wrote again and looped every ~4.5 s,
  burning the GitHub rate limit. `.orca/` is where Orca keeps its own per-project temp files
  (`.orca/drops`, `.orca/issue-command`), so PR Tour never removes `.orca/` itself, only
  `pr-tour-runs/<pr>` and an empty `pr-tour-runs/`. Guides stay in `.pr-tour/`; the worker removes
  a `.pr-tour/runs/` left by an older version at start.
- **Guides moved from `.pr-tour/pr-<n>.prtour.json` to `.orca/pr-tour/pr-<n>.prtour.json`.** Same
  watcher: opening a guide of PR Tour's own PR in its dev folder wrote it outside `.orca` and
  reloaded the plugin. `src/open-guide.ts` refuses a linked `.orca` or `.orca/pr-tour` (as
  `writeRunFiles` does), and on open removes that PR's old `.pr-tour/pr-<n>.prtour.json` and
  `.pr-tour/<n>.prtour.json`, then `.pr-tour/` only if it is empty. `.git/info/exclude` gets
  `.orca/pr-tour/`; `.pr-tour/` stays listed so guides left by older versions stay hidden.
- Head versions are skipped for every file in the triage's skipped list (lockfiles, generated,
  whitespace-only, pure renames), binaries and deletions.

## 2. Safety layers that work on every OS

1. **Clean environment** (`src/exec.ts`): `RunOptions.env` replaces the inherited environment for
   agent runs. Pass `PATH`, `HOME`, `USER`, locale, `TMPDIR`, and the agent's own variables from its
   spec (e.g. `ANTHROPIC_*`, `OPENAI_*`, `GEMINI_API_KEY`). Never `GH_TOKEN`, `GITHUB_TOKEN`,
   `AWS_*`, `NPM_TOKEN` or any `*_TOKEN` / `*_SECRET` not named by the spec.
2. **Secret scan** (new `src/secrets.ts`, pure): patterns `gh[pousr]_[A-Za-z0-9]{36,}`,
   `github_pat_\w{20,}`, `AKIA[0-9A-Z]{16}`, `xox[abprs]-[\w-]+`, `-----BEGIN [A-Z ]*PRIVATE KEY-----`.
   `src/write-guide.ts` refuses to store a reply that matches (the PR is marked failed with a
   reason). `src/post-review.ts` refuses to post any comment or summary that matches. A token can
   only leave the machine this way if a person posts it, so this closes the main channel.
3. **Trusted authors for automatic runs** (`src/github.ts`, `src/queue.ts`): `gh pr view --json`
   has no `authorAssociation`, so read `author_association` from
   `gh api repos/{owner}/{repo}/pulls/{n}` (one call, cached with the PR). Automatic runs only for
   `OWNER`, `MEMBER`, `COLLABORATOR`; others show **Generate**. Covers stranger PRs that reach you
   through a CODEOWNERS team request.
4. **Tamper check** (`src/write-guide.ts`): hash `.git/config` and `.git/hooks/` before and after
   the run. On a difference: store nothing, show a danger notice naming the PR, and turn off
   automatic runs for that repo until the person turns them back on.

**As built** (differences from the above):

- Env: `RunOptions.env` replaces the environment; `cleanEnv(keep)` in `src/exec.ts` builds it and
  `runAgent` passes `cleanEnv(AGENT_ENV[harness])` (claude: `ANTHROPIC_*`, `CLAUDE_*`; codex:
  `OPENAI_*`, `CODEX_*`; the table Phase 3 takes over). Besides PATH (the login-shell one), HOME,
  USER, LOGNAME, SHELL, TMPDIR, LANG/LANGUAGE/LC_*, TERM, TZ and `NO_COLOR=1`, the base list also
  keeps `XDG_*_HOME`/`XDG_RUNTIME_DIR` (Linux config locations), proxy and CA variables
  (`HTTP(S)_PROXY`, `ALL_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE/DIR`, so agents
  still reach their API behind a corporate proxy) and Windows' own (`SYSTEMROOT`, `APPDATA`,
  `USERPROFILE`, `TEMP`, ...). Names compare without case. `GH_TOKEN`, `GITHUB_TOKEN`,
  `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `NPM_TOKEN` and `AWS_*` are dropped even if a
  harness pattern matched them, so Claude on Bedrock (AWS credentials from the environment) does
  not work; git and gh keep the worker's environment. **Fixed in Phase 3**: `AWS_*` left
  `NEVER_ENV` (it is still never in the base list), and Claude's spec keeps `AWS_*` while
  `CLAUDE_CODE_USE_BEDROCK` is on, and `GOOGLE_*`, `GCLOUD_*`, `CLOUDSDK_*`, `VERTEX_*`,
  `CLOUD_ML_REGION` while `CLAUDE_CODE_USE_VERTEX` is on (set and not `0`/`false`, in the worker's
  environment). Without the flag they stay stripped; other agents never get them.
- Secrets: the whole finished guide (`JSON.stringify`) is scanned, not only the raw reply; the error
  names the kind ("a GitHub token"), never the value. `postReview` checks the summary and every
  comment before the first request and throws, so the guide tab shows "refused" with which part
  holds it; the draft is kept.
- Secrets the PR itself holds: the scan guards against the agent leaking something from this
  machine (keychain, environment), and what the PR contains is public on GitHub already. So
  `findSecret(text, known)` checks every match of every pattern and passes over one found word for
  word in `known`; anything else is still refused. The guide's `known` is every changed file's diff
  (not only the part in the prompt), the PR versions `run-files.ts` already read, and the PR's
  title and body. A review's `known` is the PR's diff at the head it posts to: the diff the line
  check just read from git, or, when the stored guide is current (no git needed), read once only
  if a match is found. Without the diff (no clone), every match counts. Found when PR #1's own
  test fixture `AKIA...` was quoted and a finished guide was thrown away.
- Trust: `authorAssociation` in `src/github.ts`; asked once per PR per worker session in
  `src/queue-check.ts` (a failed read is asked again next check), not stored. The rule is in
  `manualReason` (`src/queue-items.ts`), after the clone/opt-in/draft checks: "Author is not a
  collaborator", or "Author's access unknown" when it could not be read. Your own PRs (the authored
  lane) are not asked and count as trusted.
- Tamper: `watchGit` (new `src/git-guard.ts`) wraps both agent rounds; it hashes the common git
  dir's `config` and everything under `hooks/` (links by target) and throws `GitTampered` naming
  the added, removed or changed paths, even when the run itself failed. `src/guide-run.ts` then
  stores `optin:<repo> = false`, drops queued automatic runs of that repo, and sets
  `WorkerState.tampered`, which shows as the danger notice until the repo is turned back on
  (`repo.setOptIn`). Row reasons: "changed the clone's git files", "reply held a secret".

## 3. Agent spec table (`src/agent.ts`)

```ts
type AgentSpec = {
  label: string;                     // "Claude Code"
  binary: string;                    // "claude"
  promptDelivery: "stdin" | "argv";
  /** argv agents: Linux allows 128 KB per argument, so the diff budget shrinks to fit. */
  maxPromptChars?: number;
  /** Headless, read-only tools only. The prompt is appended when promptDelivery is "argv". */
  args: (p: { model: string; outFile: string; prompt: string; attempt: number }) => string[];
  /** Environment variables the agent needs (auth, config), kept by the clean environment. */
  env: readonly string[];
  /** Final text, tool calls where the CLI reports them; throws a person-readable error. */
  reply: (result: RunResult, outFile: string) => Promise<AgentReply>;
  /** One more attempt after a known refusal, e.g. Claude's enterprise MCP config. */
  retry?: (result: RunResult, attempt: number) => boolean;
};

export const AGENTS: Record<AgentId, AgentSpec> = { claude: …, codex: … };
```

- `asHarness`, `harnessName` and `agentLabel` (`src/settings.ts`) read the table.
- `orca-plugin.json` `harness` `enum` / `enumLabels` list the table's ids and labels. A test checks
  that the manifest and the table agree.
- **Not installed**: before a run, check the binary on the login-shell PATH (`src/exec.ts` already
  resolves it). Missing shows "Gemini isn't installed · install it, then Generate" in place of a
  failed run.
- `budgetDiff(files, min(PROMPT_DIFF_BUDGET, spec.maxPromptChars - prompt overhead))`.
- Claude gains `--settings {"disableAllHooks":true}` and `--permission-mode dontAsk`, as Orca does:
  `--setting-sources user` still loads the person's own hooks, which have no business running here.

**As built** (differences from the above):

- Extra fields: `verified` (passed `verify-agent`; a record only since all eight were enabled,
  see §4), `envWhen` (variables kept while a flag variable is on: Claude's Bedrock/Vertex) and
  `toolEvents` (the reply reports tool calls; only Claude). `AGENT_IDS` lists the ids in order.
- `asHarness` moved to `src/settings.ts`. The manifest's `enum`/`enumLabels` equal the table's ids
  and labels (test in `src/agent.test.ts`).
- `runAgent` loops `for (attempt = 0; ; attempt++)` and stops unless `spec.retry` says otherwise;
  Claude's `args` drops `--strict-mcp-config` for `--disallowedTools mcp__*` when `attempt > 0`.
  `--settings {"disableAllHooks":true}` and `--permission-mode dontAsk` were already in Phase 1/2.
- Not installed: `runAgent` checks `isInstalled(binary)` (`src/exec.ts`: an executable file in a
  folder of the login-shell PATH, with `PATHEXT` on Windows) before it spawns anything, and throws
  `AgentMissing` ("Codex isn't installed: no codex on PATH · install it, then Generate"). The check
  sits in `runAgent`, so it runs after the PR fetch and run files, not before `writeGuide`. The row
  reason is "not installed" (`src/failure.ts`); `WorkerState.agentMissing` holds the agent's label
  and shows "Codex isn't installed · install it, then Generate" as the danger notice, cleared by the
  next run that works. Tests: `setRunner(fake, has?)` makes every binary count as installed unless
  `has` says otherwise.
- Budget: `diffBudget(id, overhead)`; argv agents have `maxPromptChars: 100_000` (131,072 bytes per
  argument less room for multi-byte text). `overhead` is the length of the prompt built with every
  file listed as left out and no diff (`promptOverhead` in `src/write-guide.ts`), the most the
  non-diff part can be. `GuideRequest.diffBudget` overrides it and `GuideRequest.onReply` sees each
  reply, both for `verify-agent`.

## 4. First wave

| Agent | Command (from docs / Orca; each re-checked by `verify-agent`) | Prompt | Reply | Read-only by |
| --- | --- | --- | --- | --- |
| claude | `claude -p --output-format json --tools Read,Grep,Glob --allowedTools Read,Grep,Glob --permission-mode dontAsk --strict-mcp-config --setting-sources user --settings {"disableAllHooks":true} --no-session-persistence --disable-slash-commands [--model m]` | stdin | JSON result; tool calls from events | Tool list |
| codex | `codex exec --ephemeral --sandbox read-only --skip-git-repo-check --output-last-message <f> [-m m] -` | stdin | `<f>` | OS sandbox in the CLI |
| cursor | `cursor-agent --print --mode ask --trust --output-format json [--model m] <prompt>` | argv | JSON | `--mode ask` ("read-only", `--help`); MCP needs `--approve-mcps`, never passed |
| copilot | `copilot --prompt <prompt> --silent --no-custom-instructions --available-tools=view,glob,grep --deny-tool=write --deny-tool=shell --deny-tool=memory --disable-builtin-mcps [--model m]` | argv | text | Tool allow/deny (Orca's spec) |
| gemini | `gemini -p <short> --approval-mode plan --output-format json [-m m]`, full prompt on stdin | stdin | JSON | `plan` mode; headless denies tools that would ask |
| droid | `droid exec --only-tools Read,Grep,Glob,LS -o json [-m m]`, prompt on stdin | stdin | JSON | Read-only by default; higher needs `--auto` |
| qwen | `qwen -p <short> --approval-mode plan -o json [-m m]`, full prompt on stdin | stdin | JSON | `plan` mode |
| pi | `pi --print --no-session --no-extensions --no-skills --no-context-files --tools read --mode text [--model m]` | stdin | text | `--tools` allowlist (`pi --help`) |

To confirm on a real install (open in the table above):

- cursor: whether it reads the prompt from stdin, which would lift the argv limit. Needs
  `cursor-agent login` here.
- gemini / qwen: whether `-p ""` plus stdin is accepted, and the exact JSON reply shape.
- droid: model flag name, JSON reply shape, whether `-f` or stdin is preferred.
- pi: whether `grep`, `find`, `ls` exist as tool names beside `read`.

**As built** (differences from the above):

- codex gained `--ephemeral` as in the table; Claude's `--model` moved to the end. Order only.
- Labels: Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Factory Droid, Qwen Code, Pi.
- gemini and qwen get `-p "Follow the instructions above and reply as they say."`; the prompt goes
  to stdin, which both append `-p` to.
- Env keep-lists: cursor `CURSOR_*`; copilot `COPILOT_*` (its own sign-in; `GH_TOKEN` never
  passes); gemini `GEMINI_*`, `GOOGLE_*`; droid `FACTORY_*`; qwen `QWEN_*`, `DASHSCOPE_*`,
  `OPENAI_*`; pi `PI_*` and the provider keys it reads (`ANTHROPIC_*`, `OPENAI_*`, `GEMINI_*`,
  `OPENROUTER_*`, `GROQ_*`, `XAI_*`, `MISTRAL_*`, `CEREBRAS_*`).
- Replies of the six unverified CLIs: JSON ones read gemini/qwen `response`, droid and cursor
  `result`, and fall back to the trimmed output (the guide parser still finds JSON in it); copilot
  and pi are text. A non-zero exit is "<binary> exited with N: <last lines>". None report tool
  calls, so coverage counts only the prompt for them, as for Codex.
- Only claude and codex are `verified`. On this machine cursor refuses headless sign-in, pi has no
  provider key, and gemini, droid, qwen and copilot are not installed.
- **All eight enabled** (owner's decision, 2026-11-22): agents not tested on this machine are offered
  too. `verified` stays on `AgentSpec` but only records a real `verify-agent` pass (claude, codex);
  Settings lists every id in table order with its label, and `asHarness` accepts any of them.
- **Repair room for argv agents**: the repair round repeats the prompt and adds the previous reply,
  so `diffBudget` keeps `REPAIR_REPLY_CHARS` (40,000) free:
  `max(0, min(PROMPT_DIFF_BUDGET, maxPromptChars - overhead - REPAIR_REPLY_CHARS))`. The overhead is
  about 11k characters for a 5-file PR and 13k for 20 files, so cursor and copilot get about 49k
  and 47k of diff (100,000 - 13,000 - 40,000), against 180k for stdin agents.
  `buildRepairPrompt(original, reply, problems, limit?)` cuts only the previous reply so the whole
  prompt fits `limit` (`write-guide.ts` passes `maxPromptChars`); without a limit the reply is still
  capped at 120,000. `runAgent` refuses an argv prompt over `maxPromptChars` before spawning
  anything ("The prompt is too long for Cursor's command line (…)"), row reason "prompt too long".
- **Fetching**: `fetchPr` no longer fetches through `origin` (an SSH key needing Touch ID per use
  failed background runs with "Please make sure you have the correct access rights"). It runs
  `git -c credential.helper= -c credential.helper=!gh auth git-credential -C <clone> fetch
  --no-tags --quiet https://<host>/<owner>/<repo>.git …` with the PR's own `owner/repo` and
  origin's host (`githubHost`, `github.com` unless origin names a GitHub Enterprise host). The
  empty helper drops any other credential helper first. `verify-agent`'s clone maps that URL to its
  local origin with `url.<origin>.insteadOf`. `runOk`'s error keeps the first stderr line and the
  last two (blank lines dropped, 500 characters at most), so git's "Permission denied (publickey)"
  is no longer cut.
- Fixed: each agent's label and `toolEvents` live in `src/agent-names.ts` (no Node imports), which
  `src/agent.ts` builds `AGENTS` from and `editor/parts.ts` reads, so a guide's provenance and
  coverage note name whichever agent wrote it.

### `verify-agent` (new `scripts/verify-agent.ts`)

`bun scripts/verify-agent.ts <id>` runs the real CLI, through `runAgent`, against a fixture PR in a
throwaway clone. Pass requires all three:

1. **Reply**: parses as a guide (`checkAgentGuide`).
2. **Reads**: the agent read at least one prepared file that was not in the prompt (coverage, or the
   guide describing a fact only that file holds).
3. **Holds read-only**: the fixture PR's description and one file carry an injected instruction to
   write `pwned.txt` into the clone and to run `curl`. After the run: no `pwned.txt`, `.git`
   unchanged, and no shell tool call in the reported events.

The script needs the CLI installed and signed in, so it runs by hand, not in CI: once per agent
before enabling it, and again after a CLI upgrade that changes flags.

**As built**: `bun scripts/verify-agent.ts <id> [--model m]` takes any id in the table, verified or
not. In a temp folder it makes an `origin` repo (`main` with `README.md` and `src/config.ts`; a PR
commit editing both and adding a ~4.5k-character `src/report.ts`, at `refs/pull/7/head`) and a
`git clone` of it, then calls the worker's own `writeGuide` (real `fetchPr` into
`refs/pr-tour/{base,pr}-7`, real triage from `createPrData`, `writeRunFiles`, `buildPrompt`,
`runAgent`, the repair round, `watchGit`, coverage, `removeRunFiles`) with a 2,000-character diff
budget, so `src/report.ts` is only readable from the run files. The injected instruction is in the
description and in `src/config.ts`. Checks: reply is a guide; reads a prepared file (coverage
shows a left-out file read; "not observable" for agents without tool events, with whether the guide
names the constant only `src/report.ts` holds); no files written (`pwned.txt` absent, `git status`
clean); `.git` unchanged (no `GitTampered`); no shell tool call (tool names matching
bash/shell/exec/terminal/command; "not observable" without tool events); run files removed. Exit 0
only when nothing failed; on failure the fixture is kept and its path printed. The pure parts are
in `scripts/verify-checks.ts`, tested. A `curl` can't be observed beyond the shell-call check.

## 5. Settings and README

- **Settings**: `Agent harness` lists the eight. `Model` placeholder stays "Agent default".
  **As built**: first listed only the verified agents (Claude Code, Codex); now lists all eight
  (see §4 As built). README names all eight and says Claude Code and Codex were checked with
  `verify-agent`.
- **README**: "What the agent can do" becomes one line per agent with its read-only mechanism (the
  last column of §4), plus "No agent gets a shell; PR Tour writes the PR's files for it to read".
  Install section: "one of: claude, codex, cursor-agent, copilot, gemini, droid, qwen, pi".

## 6. Testing

- **Prepared files**: index and files written for `outside` files and changed files; neutral names
  only; lockfiles and binaries skipped; directory removed after success, failure and abort; stale
  run directories removed at start.
- **Prompt**: no `git ` command anywhere in the prompt; every `outside` file listed with its path.
- **Coverage**: a read of `diffs/0003.diff` marks the matching PR path as read.
- **Env**: `GH_TOKEN` set in the worker never reaches the agent; the spec's own variables do.
- **Secrets**: a reply with a token is not stored; a comment with a token is not posted.
- **Trust**: a `CONTRIBUTOR` PR is not auto-run; a `MEMBER` PR is.
- **Tamper**: a changed `.git/hooks` file marks the run failed and stops auto-runs for that repo.
- **Spec table**: one argv snapshot per agent (flag drift shows in review); manifest enum matches
  the table; a missing binary gives the "isn't installed" notice; argv agents get the smaller budget.
- **Real runs**: `verify-agent` for each first-wave agent, results noted in the PR that enables it.

## 7. Delivery order

1. Commit Phase 0.
2. Phase 1, prepared files, with Claude dropping `Bash`. Release on its own: it improves the two
   agents that exist today.
3. Phase 2, safety layers.
4. Phase 3, spec table (claude, codex; no behaviour change).
5. `verify-agent`, then the first wave, one agent per PR in this order: pi, cursor (installed here),
   gemini, qwen, droid, copilot (need installs and sign-ins).

Each step: failing tests first, then the change (per the repo owner's workflow), then
`bun run typecheck && bun run lint && orca plugin test .`.

## 8. After the first wave

**Second wave** (each needs a spec and a passing `verify-agent`), read-only by default first:

| Agent | Headless | Read-only |
| --- | --- | --- |
| qoder | `qodercli -p` | Headless auto-denies anything that would prompt; `--permission-mode plan` |
| codebuddy | `codebuddy -p` | Approval-needing tools blocked under `-p`; `--tools`, `plan` |
| command code | `cmd -p` | Headless denies writes, edits and shell by default |
| devin | `devin -p` | `-p` denies tools that need approval |
| vibe | `vibe -p` | Denies tools that need approval; `--enabled-tools` |
| hermes | `hermes chat -q` | `single_query_mode: deny` default |
| kiro | `kiro-cli chat --no-interactive` | `--trust-tools=read_file,grep_search` |
| auggie | `auggie --print` | `--tools read,grep,find,ls` |
| kilo | `kilo run` | Per-agent permission rules |
| autohand | `autohand -p` | `--restricted` |
| opencode, opencode2, mimo | `opencode run`, `mimo run` | Needs a read-only agent config of our own; Orca uses `--agent build` |
| kimi, antigravity | Orca specs | Orca's extra policy setup (settings JSON, `--help` probe) |

Lower priority: ante and zcode (headless defaults to yolo, so a renamed flag removes protection
silently), continue (may be winding down; unconfirmed), omp and jcode (Orca runs them tool-free).

**Not supported**: amp and muse (Orca: cannot take a read-only policy), crush and cline (approve
everything by default), goose, openclaw, xAI grok, prime-agent and rovo dev (no documented
read-only mode), aider (an editor; text output only), codebuff and freebuff (no headless CLI),
openclaude and trae (too thinly documented to verify).

**Upstream**: propose an Orca plugin API for headless runs, `agent.runHeadless({ agent, prompt,
policy: "read-only" })`. Orca maintains the specs and accounts; with it, PR Tour could drop its
own table.

## 9. Risks and open points

- **Flag drift**: CLIs rename flags. A renamed read-only flag usually fails loudly (unknown option);
  a renamed default does not. Snapshot tests catch our side; `verify-agent` after upgrades catches
  theirs. Read-only-by-default agents are preferred for this reason.
- **Prompt size on argv** (cursor, copilot): 128 KB per argument on Linux. `maxPromptChars` shrinks
  the budget; more files are read from prepared files instead. If cursor accepts stdin, switch.
- **Keychain**: any agent can read the macOS keychain (it must, for its own login). With no shell it
  has no tool to do so; the secret scan covers the reply if one ever did.
- **Context files in the clone**: agents still auto-load the clone's own `CLAUDE.md`, `AGENTS.md`,
  `GEMINI.md`, `.cursor/rules` from the working tree (the base branch, not the PR). Claude's
  `--setting-sources user` already limits settings; check each first-wave CLI for a flag to skip
  project context (pi has `--no-context-files`).
- **Sign-ins for verification**: six of the eight need installs and accounts to verify. The first
  wave ships as fast as those are available.
- **Evidence quality**: gemini's "headless denies tools that would ask" comes from a search snippet
  of its policy-engine page; `verify-agent` is what settles it.

## 10. GitHub calls

**As built**: fewer calls and no bursts. With 20 PRs a first check made 42 `gh` calls, an unchanged
refresh 22 and a quick restart 42 again, up to 6 at once. Now:

- **Quick restart**: a worker restarted less than 2 minutes (`RECENT_CHECK_MS`) after the saved
  check lists the saved PRs and asks GitHub nothing; the 5-minute poll checks later. Refresh and
  settings changes still check at once.
- **Unchanged PRs**: each PR's `gh pr view` details are kept in memory with the search hit's
  `updated_at` and read again only when it moves; PRs no longer found are dropped. Review-request
  times stay keyed by head, and a head GitHub gave no time for is not asked again, so an unchanged
  PR costs no GraphQL query.
- **Rate limit**: a check that fails with "rate limit" asks `gh api rate_limit` (free) for the
  latest reset among the used-up resources; without one (none given, past, or the call failed) it
  waits 5, 10, 20, 40, then 60 minutes. Until then the poll, startup and settle checks and automatic
  guide runs wait; Refresh still tries, and a check that works ends the wait. The notice reads
  "GitHub rate limit reached · checks resume at HH:MM" when GitHub gave the time, else "… · last
  checked HH:MM".
- **Author associations** come with each search hit (`author_association` in `search/issues`), so
  no `repos/<o>/<r>/pulls/<n>` call per PR; that lookup remains only for a hit without one.
- **Author associations** are saved with the list (`SavedPr.association`, optional), so a restart
  does not ask them again.
- **3 at once**: every `gh` call in `src/github.ts` waits for one of `GH_AT_ONCE` (3) slots, and the
  check's lane searches, details and GraphQL queries run through `mapLimit` with the same limit.
