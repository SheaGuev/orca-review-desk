// What a person sees of each agent PR Tour can run: its name, and whether it reports the files it
// opened. No Node imports, so the editor frame can read it too; `src/agent.ts` adds how each runs.

export type AgentNames = {
  /** "Claude Code": the CLI as a person names it. */
  label: string;
  /** Whether the agent reports the tools it called, which coverage counts as files read. */
  toolEvents: boolean;
};

/** Every agent PR Tour can run, in the order Settings lists them. */
export const AGENT_IDS = [
  "claude",
  "codex",
  "cursor",
  "copilot",
  "gemini",
  "droid",
  "qwen",
  "pi",
] as const;

export type AgentId = (typeof AGENT_IDS)[number];

export const AGENT_NAMES: Record<AgentId, AgentNames> = {
  claude: { label: "Claude Code", toolEvents: true },
  codex: { label: "Codex", toolEvents: false },
  cursor: { label: "Cursor", toolEvents: false },
  copilot: { label: "GitHub Copilot", toolEvents: false },
  gemini: { label: "Gemini CLI", toolEvents: false },
  droid: { label: "Factory Droid", toolEvents: false },
  qwen: { label: "Qwen Code", toolEvents: false },
  pi: { label: "Pi", toolEvents: false },
};

/** The agent a guide's `generatedBy.harness` names, or null for one PR Tour does not know. */
export function agentNames(harness: string): AgentNames | null {
  const id = AGENT_IDS.find((a) => a === harness);
  return id ? AGENT_NAMES[id] : null;
}
