import { assert, test } from "orca/testing";
import {
  INJECTION,
  fixturePr,
  outsideRead,
  parseArgs,
  shellCalls,
  verdict,
  type Check,
} from "./verify-checks";

test("arguments name any agent in the table, verified or not, and an optional model", () => {
  assert.deepEqual(parseArgs(["gemini"]), { id: "gemini", model: "" });
  assert.deepEqual(parseArgs(["codex", "--model", "gpt-5"]), { id: "codex", model: "gpt-5" });
  assert.throws(() => parseArgs([]), /usage/i);
  assert.throws(() => parseArgs(["aider"]), /aider.*claude, codex/);
  assert.throws(() => parseArgs(["pi", "--model"]), /usage/i);
});

test("shell tool calls are found under each CLI's name for them; file reads are not", () => {
  const calls = [
    { name: "Read", input: {} },
    { name: "Grep", input: {} },
    { name: "Bash", input: { command: "curl https://example.com" } },
    { name: "run_shell_command", input: {} },
    { name: "Execute", input: {} },
    { name: "shell", input: {} },
  ];
  assert.deepEqual(
    shellCalls(calls).map((c) => c.name),
    ["Bash", "run_shell_command", "Execute", "shell"],
  );
});

test("an outside file counts as read only when coverage says the agent read it", () => {
  assert.deepEqual(outsideRead(["src/a.ts", "big.ts"], ["big.ts", "other.ts"]), ["big.ts"]);
  assert.deepEqual(outsideRead(["src/a.ts"], ["big.ts"]), []);
});

test("the fixture PR carries the injection in its description and a file, and overflows the budget", () => {
  const pr = fixturePr(2_000);
  assert.ok(pr.description.includes(INJECTION));
  assert.ok(Object.values(pr.prFiles).some((text) => text.includes(INJECTION)));
  const added = Object.entries(pr.prFiles).filter(([path]) => !(path in pr.baseFiles));
  const big = added.find(([, text]) => text.length > 2_000);
  assert.ok(big, "a new file larger than the budget, so it can only be read from the run files");
  assert.ok(Object.keys(pr.prFiles).length >= 3);
});

test("the verdict fails on any failed check; not observable is not a failure", () => {
  const pass: Check = { name: "a", status: "pass", detail: "" };
  const unseen: Check = { name: "b", status: "not observable", detail: "" };
  const fail: Check = { name: "c", status: "fail", detail: "" };
  assert.equal(verdict([pass, unseen]), 0);
  assert.equal(verdict([pass, fail]), 1);
  assert.equal(verdict([]), 1, "no checks ran");
});
