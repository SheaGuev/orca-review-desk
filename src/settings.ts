// The plugin's settings as the worker uses them. The keys and defaults mirror `contributes.settings`
// in orca-plugin.json; Orca fills declared defaults in, so the ones here only cover a value of the
// wrong type.
import { asHarness, type Harness } from "./agent";
import { parseTeams } from "./repo";

export type Settings = {
  harness: Harness;
  model: string;
  autoRequested: boolean;
  teams: string[];
  autoTeams: boolean;
  teamRequireOwnership: boolean;
  teamMinLines: number;
  includeAuthored: boolean;
  skipDrafts: boolean;
  dailyLimit: number;
  extraInstructions: string;
};

const DEFAULT_TEAM_MIN_LINES = 200;
const DEFAULT_DAILY_LIMIT = 20;

export function readSettings(s: Readonly<Record<string, unknown>>): Settings {
  return {
    harness: asHarness(s.harness),
    model: typeof s.model === "string" ? s.model : "",
    autoRequested: s.autoRequested !== false,
    teams: parseTeams(s.teams),
    autoTeams: s.autoTeams !== false,
    teamRequireOwnership: s.teamRequireOwnership !== false,
    teamMinLines: typeof s.teamMinLines === "number" ? s.teamMinLines : DEFAULT_TEAM_MIN_LINES,
    includeAuthored: s.includeAuthored === true,
    skipDrafts: s.skipDrafts !== false,
    dailyLimit: typeof s.dailyLimit === "number" ? s.dailyLimit : DEFAULT_DAILY_LIMIT,
    extraInstructions: typeof s.extraInstructions === "string" ? s.extraInstructions : "",
  };
}

const HARNESS_NAME: Record<Harness, string> = { claude: "Claude Code", codex: "Codex" };

/** "Claude Code": the agent CLI as a person names it. */
export const harnessName = (harness: Harness): string => HARNESS_NAME[harness];

/** "Claude Code · claude-opus-5-5": the agent and the model it is told to use, if any. */
export const agentLabel = (s: Pick<Settings, "harness" | "model">): string =>
  `${harnessName(s.harness)}${s.model ? ` · ${s.model}` : ""}`;
