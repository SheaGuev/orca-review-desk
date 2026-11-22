import { readFile } from "node:fs/promises";
import { afterEach, assert, test } from "orca/testing";
import { AGENTS, AgentMissing, agentCommand, diffBudget, runAgent, type AgentId } from "./agent";
import { PROMPT_DIFF_BUDGET } from "./diff";
import { setRunner, type RunOptions, type RunResult } from "./exec";
import { readSettings } from "./settings";

type Call = { cmd: string; args: string[]; options?: RunOptions };

afterEach(() => setRunner(null));

/** The settings as Orca fills them in: every declared default from the manifest. */
type ManifestSetting = { key: string; default?: unknown; enum?: string[]; enumLabels?: string[] };

async function manifestSettings(): Promise<ManifestSetting[]> {
  const manifest = JSON.parse(
    await readFile(new URL("../orca-plugin.json", import.meta.url), "utf8"),
  ) as { contributes: { settings: ManifestSetting[] } };
  return manifest.contributes.settings;
}

async function manifestDefaults(): Promise<Record<string, unknown>> {
  return Object.fromEntries((await manifestSettings()).map((s) => [s.key, s.default]));
}

test("switching to Codex with default settings does not pass Codex a Claude model", async () => {
  const settings = readSettings({ ...(await manifestDefaults()), harness: "codex" });
  const { cmd, args } = agentCommand(settings.harness, settings.model, "/tmp/out.txt");
  assert.equal(cmd, "codex");
  assert.ok(
    !args.some((a) => a.startsWith("claude-")),
    `codex was given a Claude model: ${args.join(" ")}`,
  );
});

const ENTERPRISE_REFUSAL =
  "Error: You cannot use --strict-mcp-config when an enterprise MCP config is present";

test("Claude under an enterprise MCP config retries without strict MCP, MCP tools still denied", async () => {
  const calls: Call[] = [];
  setRunner(async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    if (args.includes("--strict-mcp-config"))
      return { code: 1, stdout: "", stderr: ENTERPRISE_REFUSAL };
    return {
      code: 0,
      stdout: JSON.stringify({ type: "result", is_error: false, result: "the guide" }),
      stderr: "",
    };
  });

  const reply = await runAgent("claude", "", "prompt", "/repo");

  assert.equal(reply.text, "the guide");
  assert.equal(calls.length, 2, "one retry, no more");
  const [, second] = calls as [Call, Call];
  const retry = second.args;
  assert.ok(!retry.includes("--strict-mcp-config"));
  const denied = retry.indexOf("--disallowedTools");
  assert.ok(
    denied >= 0 && retry[denied + 1] === "mcp__*",
    `MCP tools not denied: ${retry.join(" ")}`,
  );
  assert.equal(second.options?.input, "prompt", "the retry gets the same prompt");
});

test("any other Claude failure is not retried", async () => {
  const calls: Call[] = [];
  setRunner(async (cmd, args) => {
    calls.push({ cmd, args });
    return { code: 1, stdout: "", stderr: "something else broke" };
  });

  await assert.rejects(runAgent("claude", "", "prompt", "/repo"), /something else broke/);
  assert.equal(calls.length, 1);
});

/** Runs the agent with a fake CLI and answers the environment it was given. */
async function envOfRun(harness: AgentId): Promise<Record<string, string> | undefined> {
  let seen: Record<string, string> | undefined;
  setRunner(async (_cmd, _args, options) => {
    seen = options?.env;
    return {
      code: 0,
      stdout: JSON.stringify({ type: "result", is_error: false, result: "the guide" }),
      stderr: "",
    };
  });
  await runAgent(harness, "", "prompt", "/repo").catch(() => undefined);
  return seen;
}

test("the agent gets a clean environment: its own variables, never the worker's tokens", async () => {
  const set = {
    GH_TOKEN: "gh-secret",
    GITHUB_TOKEN: "github-secret",
    GH_ENTERPRISE_TOKEN: "ghe-secret",
    NPM_TOKEN: "npm-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    SOME_SERVICE_SECRET: "other-secret",
    ANTHROPIC_API_KEY: "anthropic-key",
    CLAUDE_CONFIG_DIR: "/claude-config",
    OPENAI_API_KEY: "openai-key",
    CODEX_HOME: "/codex-home",
    HOME: process.env.HOME ?? "/home/me",
    LANG: "en_GB.UTF-8",
    LC_ALL: "en_GB.UTF-8",
  };
  const saved = Object.fromEntries(Object.keys(set).map((k) => [k, process.env[k]]));
  Object.assign(process.env, set);
  try {
    const claude = await envOfRun("claude");
    assert.ok(claude, "the agent run is given its own env");
    for (const k of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "NPM_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "SOME_SERVICE_SECRET",
      "OPENAI_API_KEY",
      "CODEX_HOME",
    ])
      assert.equal(claude[k], undefined, `${k} reached Claude`);
    assert.equal(claude.ANTHROPIC_API_KEY, "anthropic-key");
    assert.equal(claude.CLAUDE_CONFIG_DIR, "/claude-config");
    assert.equal(claude.HOME, set.HOME);
    assert.equal(claude.LANG, "en_GB.UTF-8");
    assert.equal(claude.LC_ALL, "en_GB.UTF-8");
    assert.ok(claude.PATH, "PATH is kept");

    const codex = await envOfRun("codex");
    assert.equal(codex?.OPENAI_API_KEY, "openai-key");
    assert.equal(codex?.CODEX_HOME, "/codex-home");
    assert.equal(codex?.ANTHROPIC_API_KEY, undefined);
    assert.equal(codex?.GH_TOKEN, undefined);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

/** Sets these variables for `fn`, then puts the worker's environment back as it was. */
async function withEnv(set: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(set).map((k) => [k, process.env[k]]));
  Object.assign(process.env, set);
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const AWS = { AWS_REGION: "eu-west-1", AWS_ACCESS_KEY_ID: "AKIA-x", AWS_PROFILE: "work" };
const GOOGLE = {
  GOOGLE_APPLICATION_CREDENTIALS: "/creds.json",
  GCLOUD_PROJECT: "proj",
  CLOUDSDK_CONFIG: "/gcloud",
  VERTEX_REGION_CLAUDE_4_0_OPUS: "us-east5",
  CLOUD_ML_REGION: "us-east5",
};

test("Claude on Bedrock keeps the AWS variables; without the flag they stay stripped", async () => {
  await withEnv({ ...AWS, GH_TOKEN: "gh-secret" }, async () => {
    const plain = await envOfRun("claude");
    for (const k of Object.keys(AWS)) assert.equal(plain?.[k], undefined, `${k} reached Claude`);
  });
  await withEnv({ ...AWS, GH_TOKEN: "gh-secret", CLAUDE_CODE_USE_BEDROCK: "1" }, async () => {
    const bedrock = await envOfRun("claude");
    for (const [k, v] of Object.entries(AWS)) assert.equal(bedrock?.[k], v, `${k} missing`);
    assert.equal(bedrock?.CLAUDE_CODE_USE_BEDROCK, "1");
    assert.equal(bedrock?.GH_TOKEN, undefined, "tokens still never pass");
    const codex = await envOfRun("codex");
    assert.equal(codex?.AWS_ACCESS_KEY_ID, undefined, "only Claude reads the Bedrock flag");
  });
});

test("Claude on Vertex keeps the Google Cloud variables; without the flag they stay stripped", async () => {
  await withEnv(GOOGLE, async () => {
    const plain = await envOfRun("claude");
    for (const k of Object.keys(GOOGLE)) assert.equal(plain?.[k], undefined, `${k} reached Claude`);
  });
  await withEnv({ ...GOOGLE, CLAUDE_CODE_USE_VERTEX: "1" }, async () => {
    const vertex = await envOfRun("claude");
    for (const [k, v] of Object.entries(GOOGLE)) assert.equal(vertex?.[k], v, `${k} missing`);
  });
  await withEnv({ ...GOOGLE, CLAUDE_CODE_USE_VERTEX: "0" }, async () => {
    const off = await envOfRun("claude");
    assert.equal(off?.GOOGLE_APPLICATION_CREDENTIALS, undefined, "a flag set to 0 is off");
  });
});

const PROMPT = "You are preparing a review guide.";
const STDIN_HINT = "Follow the instructions above and reply as they say.";
const OUT = "/tmp/out.txt";

/** Every agent's exact command line with and without a model, and where its prompt goes. */
const ARGV: Record<AgentId, { cmd: string; args: (model: string[]) => string[]; argv: boolean }> = {
  claude: {
    cmd: "claude",
    argv: false,
    args: (m) => [
      "-p",
      "--output-format",
      "json",
      "--tools",
      "Read,Grep,Glob",
      "--allowedTools",
      "Read,Grep,Glob",
      "--permission-mode",
      "dontAsk",
      "--strict-mcp-config",
      "--setting-sources",
      "user",
      "--settings",
      '{"disableAllHooks":true}',
      "--no-session-persistence",
      "--disable-slash-commands",
      ...(m.length ? ["--model", ...m] : []),
    ],
  },
  codex: {
    cmd: "codex",
    argv: false,
    args: (m) => [
      "exec",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--output-last-message",
      OUT,
      ...(m.length ? ["-m", ...m] : []),
      "-",
    ],
  },
  cursor: {
    cmd: "cursor-agent",
    argv: true,
    args: (m) => [
      "--print",
      "--mode",
      "ask",
      "--trust",
      "--output-format",
      "json",
      ...(m.length ? ["--model", ...m] : []),
      PROMPT,
    ],
  },
  copilot: {
    cmd: "copilot",
    argv: true,
    args: (m) => [
      "--prompt",
      PROMPT,
      "--silent",
      "--no-custom-instructions",
      "--available-tools=view,glob,grep",
      "--deny-tool=write",
      "--deny-tool=shell",
      "--deny-tool=memory",
      "--disable-builtin-mcps",
      ...(m.length ? ["--model", ...m] : []),
    ],
  },
  gemini: {
    cmd: "gemini",
    argv: false,
    args: (m) => [
      "-p",
      STDIN_HINT,
      "--approval-mode",
      "plan",
      "--output-format",
      "json",
      ...(m.length ? ["-m", ...m] : []),
    ],
  },
  droid: {
    cmd: "droid",
    argv: false,
    args: (m) => [
      "exec",
      "--only-tools",
      "Read,Grep,Glob,LS",
      "-o",
      "json",
      ...(m.length ? ["-m", ...m] : []),
    ],
  },
  qwen: {
    cmd: "qwen",
    argv: false,
    args: (m) => [
      "-p",
      STDIN_HINT,
      "--approval-mode",
      "plan",
      "-o",
      "json",
      ...(m.length ? ["-m", ...m] : []),
    ],
  },
  pi: {
    cmd: "pi",
    argv: false,
    args: (m) => [
      "--print",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--tools",
      "read",
      "--mode",
      "text",
      ...(m.length ? ["--model", ...m] : []),
    ],
  },
};

test("the snapshot covers every agent in the table", () => {
  assert.deepEqual(Object.keys(ARGV).sort(), Object.keys(AGENTS).sort());
});

for (const [id, want] of Object.entries(ARGV) as [AgentId, (typeof ARGV)[AgentId]][]) {
  test(`${id}: exact command line, model flag only when set, prompt ${want.argv ? "in argv" : "on stdin"}`, async () => {
    for (const model of ["", "some-model"]) {
      const m = model ? [model] : [];
      assert.deepEqual(agentCommand(id, model, OUT, PROMPT), { cmd: want.cmd, args: want.args(m) });
      const calls: Call[] = [];
      setRunner(async (cmd, args, options) => {
        calls.push({ cmd, args, options });
        return { code: 1, stdout: "", stderr: "stop here" };
      });
      await runAgent(id, model, PROMPT, "/repo").catch(() => undefined);
      const [call] = calls;
      assert.ok(call, `${id} was not run`);
      assert.equal(call.cmd, want.cmd);
      assert.deepEqual(
        call.args.map((a) => (a.endsWith("last-message.txt") ? OUT : a)),
        want.args(m),
      );
      assert.equal(call.options?.input ?? "", want.argv ? "" : PROMPT);
      assert.equal(call.options?.cwd, "/repo");
    }
  });
}

test("only the verified agents are offered in Settings, with the table's labels", async () => {
  const harness = (await manifestSettings()).find((s) => s.key === "harness");
  const verified = (Object.keys(AGENTS) as AgentId[]).filter((id) => AGENTS[id].verified);
  assert.deepEqual(verified, ["claude", "codex"]);
  assert.deepEqual(harness?.enum, verified);
  assert.deepEqual(
    harness?.enumLabels,
    verified.map((id) => AGENTS[id].label),
  );
  assert.equal(harness?.default, "claude");
});

test("argv agents get a smaller diff budget that leaves room for the rest of the prompt", () => {
  for (const [id, spec] of Object.entries(AGENTS)) {
    if (spec.promptDelivery === "argv")
      assert.ok(
        spec.maxPromptChars !== undefined && spec.maxPromptChars <= 128 * 1024,
        `${id} has no prompt limit under Linux's 128 KB per argument`,
      );
    else assert.equal(spec.maxPromptChars, undefined, `${id} reads stdin, so has no limit`);
  }
  assert.equal(diffBudget("claude", 20_000), PROMPT_DIFF_BUDGET);
  assert.equal(diffBudget("codex", 500_000), PROMPT_DIFF_BUDGET);
  const max = AGENTS.cursor.maxPromptChars ?? 0;
  assert.equal(diffBudget("cursor", 20_000), max - 20_000);
  assert.equal(diffBudget("copilot", max + 1), 0, "never below nothing");
});

test("a missing agent CLI fails before anything runs, naming the agent", async () => {
  const calls: Call[] = [];
  setRunner(
    async (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: "", stderr: "" };
    },
    (cmd) => cmd !== "codex",
  );
  const error = await runAgent("codex", "", "prompt", "/repo").then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(error instanceof AgentMissing, `expected AgentMissing, got ${String(error)}`);
  assert.match(error.message, /^Codex isn't installed/);
  assert.equal(calls.length, 0, "nothing was run");
});

/** The reply of `id` when its CLI prints `result`. */
async function replyOf(id: AgentId, result: RunResult) {
  setRunner(async () => result);
  return runAgent(id, "", "prompt", "/repo");
}

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" });

test("JSON replies are read from each CLI's documented final-text field", async () => {
  assert.equal((await replyOf("gemini", ok('{"response":"G","stats":{}}'))).text, "G");
  assert.equal((await replyOf("qwen", ok('{"response":"Q"}'))).text, "Q");
  assert.equal((await replyOf("droid", ok('{"type":"result","result":"D"}'))).text, "D");
  assert.equal((await replyOf("cursor", ok('{"type":"result","result":"C"}'))).text, "C");
  // A shape we did not expect is not thrown away: the guide parser looks for JSON in it.
  assert.equal((await replyOf("gemini", ok("  plain text\n"))).text, "plain text");
  assert.equal((await replyOf("droid", ok('{"other":1}'))).text, '{"other":1}');
});

test("text replies are the trimmed output, and no agent but Claude reports tool calls", async () => {
  assert.deepEqual(await replyOf("pi", ok('\n{"a":1}\n')), { text: '{"a":1}', toolCalls: [] });
  assert.deepEqual(await replyOf("copilot", ok(" guide ")), { text: "guide", toolCalls: [] });
  for (const [id, spec] of Object.entries(AGENTS))
    assert.equal(spec.toolEvents, id === "claude", `${id} toolEvents`);
});

test("a non-zero exit names the binary, the code and the end of its output", async () => {
  await assert.rejects(
    replyOf("gemini", { code: 41, stdout: "", stderr: "line 1\nAuth failed" }),
    /^Error: gemini exited with 41: line 1 Auth failed/,
  );
  await assert.rejects(
    replyOf("cursor", { code: 1, stdout: "boom", stderr: "" }),
    /cursor-agent exited with 1: boom/,
  );
  await assert.rejects(
    replyOf("pi", { code: 2, stdout: "", stderr: "No API key" }),
    /pi exited with 2: No API key/,
  );
});
