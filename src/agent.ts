// Running the chosen agent CLI headless, with read-only tools so it never stops for permission
// and cannot be steered by PR content into writing files.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCall } from "./diff";
import { run } from "./exec";
import { asList, asObj, asString, isObj, parseJson } from "./json";

export type Harness = "claude" | "codex";

export function asHarness(value: unknown): Harness {
  return value === "codex" ? "codex" : "claude";
}

/** Only these built-in tools exist in the run; Bash is pre-approved for read-only git only. */
const CLAUDE_TOOLS_AVAILABLE = "Read,Grep,Glob,Bash";
const CLAUDE_TOOLS_ALLOWED = "Read,Grep,Glob,Bash(git diff:*),Bash(git show:*),Bash(git log:*)";
const AGENT_TIMEOUT_MS = 15 * 60_000;
/** Claude refuses `--strict-mcp-config` when an enterprise MCP config is present. */
const ENTERPRISE_MCP_REFUSAL =
  "You cannot use --strict-mcp-config when an enterprise MCP config is present";

/**
 * The command line for a harness; the prompt goes to stdin. `strictMcp: false` is the fallback for
 * enterprise-managed MCP configs: the managed servers load, so their tools are denied instead.
 */
export function agentCommand(
  harness: Harness,
  model: string,
  outFile: string,
  strictMcp = true,
): { cmd: string; args: string[] } {
  const m = model.trim();
  if (harness === "codex") {
    return {
      cmd: "codex",
      args: [
        "exec",
        ...(m ? ["-m", m] : []),
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--output-last-message",
        outFile,
        "-",
      ],
    };
  }
  return {
    cmd: "claude",
    args: [
      "-p",
      ...(m ? ["--model", m] : []),
      "--output-format",
      "json",
      "--tools",
      CLAUDE_TOOLS_AVAILABLE,
      "--allowedTools",
      CLAUDE_TOOLS_ALLOWED,
      // No MCP servers, no project settings or hooks from the PR's repo, no saved session, no skills.
      ...(strictMcp ? ["--strict-mcp-config"] : ["--disallowedTools", "mcp__*"]),
      "--setting-sources",
      "user",
      "--no-session-persistence",
      "--disable-slash-commands",
    ],
  };
}

const tail = (text: string) => text.trim().split("\n").slice(-4).join(" ").slice(0, 400);

/** One event of Claude's output as printed: unchecked fields, read with the json helpers. */
type ClaudeEvent = Record<string, unknown>;

/** What `claude -p` printed, parsed; null when it is not JSON. */
function claudeOutput(stdout: string): unknown {
  try {
    return parseJson(stdout);
  } catch {
    return null;
  }
}

/** `claude -p --output-format json` prints one result object, or (newer versions) every event as a list. */
export function claudeResult(stdout: string): ClaudeEvent | null {
  const parsed = claudeOutput(stdout);
  if (!Array.isArray(parsed)) return isObj(parsed) ? parsed : null;
  return (
    parsed
      .filter(isObj)
      .filter((e) => e.type === "result")
      .at(-1) ?? null
  );
}

/** The tools the agent called, from the assistant events; empty when only a result was printed. */
export function claudeToolCalls(stdout: string): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const e of asList(claudeOutput(stdout))) {
    if (!isObj(e) || e.type !== "assistant") continue;
    for (const c of asList(asObj(e.message).content)) {
      if (isObj(c) && c.type === "tool_use" && typeof c.name === "string")
        calls.push({ name: c.name, input: asObj(c.input) });
    }
  }
  return calls;
}

export type AgentReply = {
  text: string;
  /** Tools the agent called; always empty for Codex, which prints no event stream. */
  toolCalls: ToolCall[];
};

/** Runs the agent once in `cwd` and returns its final message and the tools it called. */
export async function runAgent(
  harness: Harness,
  model: string,
  prompt: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<AgentReply> {
  const dir = await mkdtemp(join(tmpdir(), "pr-tour-"));
  const outFile = join(dir, "last-message.txt");
  try {
    const attempt = (strictMcp: boolean) => {
      const { cmd, args } = agentCommand(harness, model, outFile, strictMcp);
      return run(cmd, args, { cwd, input: prompt, timeoutMs: AGENT_TIMEOUT_MS, signal });
    };
    let result = await attempt(true);
    // Retry once without strict MCP only for Claude's enterprise-policy refusal.
    if (
      harness === "claude" &&
      result.code !== 0 &&
      `${result.stdout}\n${result.stderr}`.includes(ENTERPRISE_MCP_REFUSAL)
    )
      result = await attempt(false);
    if (harness === "codex") {
      if (result.code !== 0)
        throw new Error(
          `codex exited with ${result.code}: ${tail(result.stderr || result.stdout)}`,
        );
      return { text: await readFile(outFile, "utf8"), toolCalls: [] };
    }
    // Claude's own error (such as "Not logged in") is in its result, even when it exits 1.
    const outcome = claudeResult(result.stdout);
    if (outcome?.is_error === true)
      throw new Error(`Claude Code: ${asString(outcome.result).slice(0, 400)}`);
    if (result.code !== 0 || !outcome)
      throw new Error(`claude exited with ${result.code}: ${tail(result.stderr || result.stdout)}`);
    return { text: asString(outcome.result), toolCalls: claudeToolCalls(result.stdout) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
