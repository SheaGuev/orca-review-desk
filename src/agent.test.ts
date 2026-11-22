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
