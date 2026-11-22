# PR Tour: more agents, technical plan

Status: agreed scope, Phase 0 done (uncommitted), nothing else started. Written 2026-11-22.

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
| 1 | Prepared files | new `src/run-files.ts`, `src/prompt.ts`, `src/diff.ts`, `src/write-guide.ts` | PR files and overflow diffs written to `.pr-tour/runs/<pr>/`; prompt drops git commands |
| 2 | Safety | `src/exec.ts`, `src/github.ts`, `src/queue.ts`, new `src/secrets.ts`, `src/write-guide.ts`, `src/post-review.ts` | Clean agent env, secret scan of replies, auto-run only for trusted authors, `.git` tamper check |
| 3 | Spec table | `src/agent.ts`, `src/settings.ts`, `orca-plugin.json` | `Harness` union becomes a spec table; still claude and codex only |
| 4 | First wave | `src/agent.ts`, new `scripts/verify-agent.ts`, `README.md` | Conformance script; add cursor, copilot, gemini, droid, qwen, pi |

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

## 5. Settings and README

- **Settings**: `Agent harness` lists the eight. `Model` placeholder stays "Agent default".
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
