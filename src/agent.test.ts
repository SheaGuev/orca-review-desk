import { readFile } from "node:fs/promises";
import { afterEach, assert, test } from "orca/testing";
import { agentCommand, runAgent } from "./agent";
import { setRunner, type RunOptions } from "./exec";
import { readSettings } from "./settings";

type Call = { cmd: string; args: string[]; options?: RunOptions };

afterEach(() => setRunner(null));

/** The settings as Orca fills them in: every declared default from the manifest. */
async function manifestDefaults(): Promise<Record<string, unknown>> {
  const manifest = JSON.parse(
    await readFile(new URL("../orca-plugin.json", import.meta.url), "utf8"),
  ) as { contributes: { settings: { key: string; default?: unknown }[] } };
  return Object.fromEntries(manifest.contributes.settings.map((s) => [s.key, s.default]));
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
async function envOfRun(harness: "claude" | "codex"): Promise<Record<string, string> | undefined> {
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
