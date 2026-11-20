// Running the chosen agent CLI headless, with read-only tools so it never stops for permission
// and cannot be steered by PR content into writing files.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCall } from "./diff";
import { run } from "./exec";

export type Harness = "claude" | "codex";

export function asHarness(value: unknown): Harness {
  return value === "codex" ? "codex" : "claude";
}

/** Only these built-in tools exist in the run; Bash is pre-approved for read-only git only. */
const CLAUDE_TOOLS_AVAILABLE = "Read,Grep,Glob,Bash";
const CLAUDE_TOOLS_ALLOWED = "Read,Grep,Glob,Bash(git diff:*),Bash(git show:*),Bash(git log:*)";
const AGENT_TIMEOUT_MS = 15 * 60_000;

/** The command line for a harness; the prompt goes to stdin. */
export function agentCommand(
  harness: Harness,
  model: string,
  outFile: string,
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
      "--strict-mcp-config",
      "--setting-sources",
      "user",
      "--no-session-persistence",
      "--disable-slash-commands",
    ],
  };
}

const tail = (text: string) => text.trim().split("\n").slice(-4).join(" ").slice(0, 400);

type ClaudeResult = { type?: string; result?: string; is_error?: boolean };
type ClaudeEvent = ClaudeResult & {
  message?: { content?: { type?: string; name?: unknown; input?: unknown }[] };
};

function claudeEvents(stdout: string): ClaudeEvent[] | ClaudeEvent | null {
  try {
    return JSON.parse(stdout) as ClaudeEvent[] | ClaudeEvent;
  } catch {
    return null;
  }
}

/** `claude -p --output-format json` prints one result object, or (newer versions) every event as a list. */
export function claudeResult(stdout: string): ClaudeResult | null {
  const parsed = claudeEvents(stdout);
  if (!parsed || !Array.isArray(parsed)) return parsed;
  return [...parsed].reverse().find((e) => e.type === "result") ?? null;
}

/** The tools the agent called, from the assistant events; empty when only a result was printed. */
export function claudeToolCalls(stdout: string): ToolCall[] {
  const parsed = claudeEvents(stdout);
  if (!Array.isArray(parsed)) return [];
  const calls: ToolCall[] = [];
  for (const e of parsed) {
    if (e.type !== "assistant") continue;
    for (const c of e.message?.content ?? []) {
      if (c?.type === "tool_use" && typeof c.name === "string")
        calls.push({
          name: c.name,
          input: c.input && typeof c.input === "object" ? (c.input as Record<string, unknown>) : {},
        });
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
    const { cmd, args } = agentCommand(harness, model, outFile);
    const result = await run(cmd, args, {
      cwd,
      input: prompt,
      timeoutMs: AGENT_TIMEOUT_MS,
      signal,
    });
    if (harness === "codex") {
      if (result.code !== 0)
        throw new Error(
          `codex exited with ${result.code}: ${tail(result.stderr || result.stdout)}`,
        );
      return { text: await readFile(outFile, "utf8"), toolCalls: [] };
    }
    // Claude's own error (such as "Not logged in") is in its result, even when it exits 1.
    const outcome = claudeResult(result.stdout);
    if (outcome?.is_error)
      throw new Error(`Claude Code: ${String(outcome.result ?? "").slice(0, 400)}`);
    if (result.code !== 0 || !outcome)
      throw new Error(`claude exited with ${result.code}: ${tail(result.stderr || result.stdout)}`);
    return { text: outcome.result ?? "", toolCalls: claudeToolCalls(result.stdout) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
