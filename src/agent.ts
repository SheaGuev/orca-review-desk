// Running the chosen agent CLI headless, with read-only tools so it never stops for permission
// and cannot be steered by PR content into writing files. Each CLI is one entry of AGENTS: its
// command line, the environment it keeps, and how its reply is read. Commands adapted from Orca's
// headless agent specs (MIT, stablyai/orca); see THIRD_PARTY_NOTICES.md.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROMPT_DIFF_BUDGET, type ToolCall } from "./diff";
import { cleanEnv, isInstalled, run, type RunResult } from "./exec";
import { asList, asObj, asString, isObj, parseJson } from "./json";

export type AgentId =
  | "claude"
  | "codex"
  | "cursor"
  | "copilot"
  | "gemini"
  | "droid"
  | "qwen"
  | "pi";

export type AgentReply = {
  text: string;
  /** Tools the agent called; empty for CLIs that print no event stream (`toolEvents: false`). */
  toolCalls: ToolCall[];
};

type ArgsInput = { model: string; outFile: string; prompt: string; attempt: number };

export type AgentSpec = {
  /** "Claude Code": the CLI as a person names it. */
  label: string;
  binary: string;
  /**
   * Passed `scripts/verify-agent.ts` on a real install. A record only: every agent in the table is
   * offered in Settings, verified or not.
   */
  verified: boolean;
  /** "argv": the prompt is in the command line (`args` places it); else it goes to stdin. */
  promptDelivery: "stdin" | "argv";
  /**
   * argv agents: Linux allows 128 KB per argument, so the diff budget shrinks to fit and a longer
   * prompt is refused before the CLI runs.
   */
  maxPromptChars?: number;
  /** Headless, read-only tools only. */
  args: (p: ArgsInput) => string[];
  /** Variables the agent needs (auth, config), kept by the clean environment; `*` ends a prefix. */
  env: readonly string[];
  /** More variables to keep while the worker's environment has this flag on (set, not "0"/"false"). */
  envWhen?: Readonly<Record<string, readonly string[]>>;
  /** Whether `reply` reports the tools the agent called, which coverage counts as files read. */
  toolEvents: boolean;
  /** Final text and tool calls; throws a person-readable error. */
  reply: (result: RunResult, outFile: string) => Promise<AgentReply>;
  /** One more attempt after a known refusal, e.g. Claude's enterprise MCP config. */
  retry?: (result: RunResult, attempt: number) => boolean;
};

const AGENT_TIMEOUT_MS = 15 * 60_000;
/** Claude refuses `--strict-mcp-config` when an enterprise MCP config is present. */
const ENTERPRISE_MCP_REFUSAL =
  "You cannot use --strict-mcp-config when an enterprise MCP config is present";
/** Only these built-in tools exist in a Claude run, all pre-approved; no shell. */
const CLAUDE_TOOLS = "Read,Grep,Glob";
/** gemini and qwen append `-p` to what stdin holds, so the prompt itself goes to stdin. */
const STDIN_HINT = "Follow the instructions above and reply as they say.";
/**
 * argv agents: Linux's 128 KiB (131,072 bytes) per argument, less room for multi-byte characters
 * in the PR's text, since this counts characters.
 */
const ARGV_PROMPT_CHARS = 100_000;
/**
 * Room an argv agent's diff budget keeps for the repair round, which repeats the prompt and adds
 * the previous reply (cut to fit by `buildRepairPrompt`).
 */
export const REPAIR_REPLY_CHARS = 40_000;

const tail = (text: string) => text.trim().split("\n").slice(-4).join(" ").slice(0, 400);

/** "gemini exited with 1: <the end of its output>". */
const failed = (binary: string, result: RunResult): Error =>
  new Error(`${binary} exited with ${result.code}: ${tail(result.stderr || result.stdout)}`);

const parsed = (stdout: string): unknown => {
  try {
    return parseJson(stdout);
  } catch {
    return null;
  }
};

/**
 * A CLI printing one JSON object (`-o json`): its `field` when that is text, else the whole output
 * trimmed, which the guide parser still searches for JSON. Not checked on a real install yet.
 */
const jsonReply =
  (binary: string, field: string) =>
  async (result: RunResult): Promise<AgentReply> => {
    if (result.code !== 0) throw failed(binary, result);
    const value = asObj(parsed(result.stdout))[field];
    return { text: typeof value === "string" ? value : result.stdout.trim(), toolCalls: [] };
  };

/** A CLI printing only its final message. */
const textReply =
  (binary: string) =>
  async (result: RunResult): Promise<AgentReply> => {
    if (result.code !== 0) throw failed(binary, result);
    return { text: result.stdout.trim(), toolCalls: [] };
  };

const withModel = (flag: string, model: string): string[] => (model ? [flag, model] : []);

/** One event of Claude's output as printed: unchecked fields, read with the json helpers. */
type ClaudeEvent = Record<string, unknown>;

/** `claude -p --output-format json` prints one result object, or (newer versions) every event as a list. */
export function claudeResult(stdout: string): ClaudeEvent | null {
  const out = parsed(stdout);
  if (!Array.isArray(out)) return isObj(out) ? out : null;
  return (
    out
      .filter(isObj)
      .filter((e) => e.type === "result")
      .at(-1) ?? null
  );
}

/** The tools the agent called, from the assistant events; empty when only a result was printed. */
export function claudeToolCalls(stdout: string): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const e of asList(parsed(stdout))) {
    if (!isObj(e) || e.type !== "assistant") continue;
    for (const c of asList(asObj(e.message).content)) {
      if (isObj(c) && c.type === "tool_use" && typeof c.name === "string")
        calls.push({ name: c.name, input: asObj(c.input) });
    }
  }
  return calls;
}

export const AGENTS: Record<AgentId, AgentSpec> = {
  claude: {
    label: "Claude Code",
    binary: "claude",
    verified: true,
    promptDelivery: "stdin",
    // A retry (enterprise MCP config) loads the managed servers, so their tools are denied instead.
    args: ({ model, attempt }) => [
      "-p",
      "--output-format",
      "json",
      "--tools",
      CLAUDE_TOOLS,
      "--allowedTools",
      CLAUDE_TOOLS,
      // Anything else that would ask for permission is denied, not waited on.
      "--permission-mode",
      "dontAsk",
      // No MCP servers, no project settings or hooks from the PR's repo, no saved session, no skills.
      ...(attempt === 0 ? ["--strict-mcp-config"] : ["--disallowedTools", "mcp__*"]),
      "--setting-sources",
      "user",
      // The person's own hooks (user settings) have no business running here either.
      "--settings",
      JSON.stringify({ disableAllHooks: true }),
      "--no-session-persistence",
      "--disable-slash-commands",
      ...withModel("--model", model),
    ],
    env: ["ANTHROPIC_*", "CLAUDE_*"],
    // Claude on Bedrock or Vertex signs in with the cloud's own credentials from the environment.
    envWhen: {
      CLAUDE_CODE_USE_BEDROCK: ["AWS_*"],
      CLAUDE_CODE_USE_VERTEX: ["GOOGLE_*", "GCLOUD_*", "CLOUDSDK_*", "VERTEX_*", "CLOUD_ML_REGION"],
    },
    toolEvents: true,
    reply: async (result) => {
      // Claude's own error (such as "Not logged in") is in its result, even when it exits 1.
      const outcome = claudeResult(result.stdout);
      if (outcome?.is_error === true)
        throw new Error(`Claude Code: ${asString(outcome.result).slice(0, 400)}`);
      if (result.code !== 0 || !outcome) throw failed("claude", result);
      return { text: asString(outcome.result), toolCalls: claudeToolCalls(result.stdout) };
    },
    retry: (result, attempt) =>
      attempt === 0 &&
      result.code !== 0 &&
      `${result.stdout}\n${result.stderr}`.includes(ENTERPRISE_MCP_REFUSAL),
  },
  codex: {
    label: "Codex",
    binary: "codex",
    verified: true,
    promptDelivery: "stdin",
    args: ({ model, outFile }) => [
      "exec",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--output-last-message",
      outFile,
      ...withModel("-m", model),
      "-",
    ],
    env: ["OPENAI_*", "CODEX_*"],
    toolEvents: false,
    reply: async (result, outFile) => {
      if (result.code !== 0) throw failed("codex", result);
      return { text: await readFile(outFile, "utf8"), toolCalls: [] };
    },
  },
  cursor: {
    label: "Cursor",
    binary: "cursor-agent",
    verified: false,
    promptDelivery: "argv",
    maxPromptChars: ARGV_PROMPT_CHARS,
    // `--mode ask` is read-only Q&A; MCP servers need `--approve-mcps`, never passed.
    args: ({ model, prompt }) => [
      "--print",
      "--mode",
      "ask",
      "--trust",
      "--output-format",
      "json",
      ...withModel("--model", model),
      prompt,
    ],
    env: ["CURSOR_*"],
    toolEvents: false,
    reply: jsonReply("cursor-agent", "result"),
  },
  copilot: {
    label: "GitHub Copilot",
    binary: "copilot",
    verified: false,
    promptDelivery: "argv",
    maxPromptChars: ARGV_PROMPT_CHARS,
    args: ({ model, prompt }) => [
      "--prompt",
      prompt,
      "--silent",
      "--no-custom-instructions",
      "--available-tools=view,glob,grep",
      "--deny-tool=write",
      "--deny-tool=shell",
      "--deny-tool=memory",
      "--disable-builtin-mcps",
      ...withModel("--model", model),
    ],
    // Its own sign-in; GH_TOKEN and GITHUB_TOKEN never reach an agent.
    env: ["COPILOT_*"],
    toolEvents: false,
    reply: textReply("copilot"),
  },
  gemini: {
    label: "Gemini CLI",
    binary: "gemini",
    verified: false,
    promptDelivery: "stdin",
    // `plan` mode is read-only; headless denies any tool that would ask.
    args: ({ model }) => [
      "-p",
      STDIN_HINT,
      "--approval-mode",
      "plan",
      "--output-format",
      "json",
      ...withModel("-m", model),
    ],
    env: ["GEMINI_*", "GOOGLE_*"],
    toolEvents: false,
    reply: jsonReply("gemini", "response"),
  },
  droid: {
    label: "Factory Droid",
    binary: "droid",
    verified: false,
    promptDelivery: "stdin",
    // Read-only by default; anything more needs `--auto`.
    args: ({ model }) => [
      "exec",
      "--only-tools",
      "Read,Grep,Glob,LS",
      "-o",
      "json",
      ...withModel("-m", model),
    ],
    env: ["FACTORY_*"],
    toolEvents: false,
    reply: jsonReply("droid", "result"),
  },
  qwen: {
    label: "Qwen Code",
    binary: "qwen",
    verified: false,
    promptDelivery: "stdin",
    args: ({ model }) => [
      "-p",
      STDIN_HINT,
      "--approval-mode",
      "plan",
      "-o",
      "json",
      ...withModel("-m", model),
    ],
    // Qwen Code also signs in with an OpenAI-compatible key and base URL.
    env: ["QWEN_*", "DASHSCOPE_*", "OPENAI_*"],
    toolEvents: false,
    reply: jsonReply("qwen", "response"),
  },
  pi: {
    label: "Pi",
    binary: "pi",
    verified: false,
    promptDelivery: "stdin",
    args: ({ model }) => [
      "--print",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--tools",
      "read",
      "--mode",
      "text",
      ...withModel("--model", model),
    ],
    // Pi talks to many providers, each with its own key.
    env: [
      "PI_*",
      "ANTHROPIC_*",
      "OPENAI_*",
      "GEMINI_*",
      "OPENROUTER_*",
      "GROQ_*",
      "XAI_*",
      "MISTRAL_*",
      "CEREBRAS_*",
    ],
    toolEvents: false,
    reply: textReply("pi"),
  },
};

/** Every agent in the table, in its order. */
export const AGENT_IDS: readonly AgentId[] = [
  "claude",
  "codex",
  "cursor",
  "copilot",
  "gemini",
  "droid",
  "qwen",
  "pi",
];

/** The command line for an agent; the prompt is in it only for argv agents. */
export function agentCommand(
  id: AgentId,
  model: string,
  outFile: string,
  prompt = "",
  attempt = 0,
): { cmd: string; args: string[] } {
  const spec = AGENTS[id];
  return { cmd: spec.binary, args: spec.args({ model: model.trim(), outFile, prompt, attempt }) };
}

const flagOn = (value: string | undefined): boolean =>
  value !== undefined && !["", "0", "false"].includes(value.trim().toLowerCase());

/** The agent's clean environment: the base list, its own variables, and those its flags turn on. */
export function agentEnv(id: AgentId): Record<string, string> {
  const spec = AGENTS[id];
  const extra = Object.entries(spec.envWhen ?? {})
    .filter(([flag]) => flagOn(process.env[flag]))
    .flatMap(([, keep]) => keep);
  return cleanEnv([...spec.env, ...extra]);
}

/**
 * Characters of diff the prompt may carry for this agent, given the rest of the prompt
 * (`overhead`): argv agents fit the whole prompt in one argument, with room left for the repair
 * round's previous reply.
 */
export function diffBudget(id: AgentId, overhead: number): number {
  const max = AGENTS[id].maxPromptChars;
  if (max === undefined) return PROMPT_DIFF_BUDGET;
  return Math.max(0, Math.min(PROMPT_DIFF_BUDGET, max - overhead - REPAIR_REPLY_CHARS));
}

/** The agent's CLI is not on the PATH the worker runs it with. */
export class AgentMissing extends Error {
  constructor(
    readonly label: string,
    binary: string,
  ) {
    super(`${label} isn't installed: no ${binary} on PATH · install it, then Generate`);
    this.name = "AgentMissing";
  }
}

/** Runs the agent once in `cwd` and returns its final message and the tools it called. */
export async function runAgent(
  id: AgentId,
  model: string,
  prompt: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<AgentReply> {
  const spec = AGENTS[id];
  const max = spec.maxPromptChars;
  if (spec.promptDelivery === "argv" && max !== undefined && prompt.length > max)
    throw new Error(
      `The prompt is too long for ${spec.label}'s command line (${prompt.length.toLocaleString("en-US")} characters, at most ${max.toLocaleString("en-US")})`,
    );
  if (!(await isInstalled(spec.binary))) throw new AgentMissing(spec.label, spec.binary);
  const dir = await mkdtemp(join(tmpdir(), "pr-tour-"));
  const outFile = join(dir, "last-message.txt");
  const env = agentEnv(id);
  const input = spec.promptDelivery === "stdin" ? prompt : "";
  try {
    for (let attempt = 0; ; attempt++) {
      const { cmd, args } = agentCommand(id, model, outFile, prompt, attempt);
      const result = await run(cmd, args, { cwd, input, timeoutMs: AGENT_TIMEOUT_MS, signal, env });
      if (!spec.retry?.(result, attempt)) return await spec.reply(result, outFile);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
