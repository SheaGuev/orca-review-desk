import { assert, test } from "orca/testing";
import { agentLabel, readSettings } from "./settings";
import { statusBar } from "./status-bar";
import type { QueueItem } from "./protocol";

test("settings of the wrong type fall back to their defaults", () => {
  const s = readSettings({
    harness: "gemini",
    model: 4,
    teams: "acme/pay, @acme/id",
    dailyLimit: "9",
  });
  assert.equal(s.harness, "claude");
  assert.equal(s.model, "");
  assert.deepEqual(s.teams, ["acme/pay", "acme/id"]);
  assert.equal(s.dailyLimit, 20);
  assert.equal(s.teamMinLines, 200);
  assert.equal(s.autoRequested, true);
  assert.equal(s.includeAuthored, false);
});

test("the agent label names the CLI and the model, if one is set", () => {
  assert.equal(agentLabel({ harness: "codex", model: "" }), "Codex");
  assert.equal(
    agentLabel({ harness: "claude", model: "claude-opus-5-5" }),
    "Claude Code · claude-opus-5-5",
  );
});

const item = (over: Partial<QueueItem>) =>
  ({ number: 7, status: "ready", risk: null, riskSummary: null, ...over }) as QueueItem;

test("the status bar shows the focused branch's guide, else how many reviews wait", () => {
  assert.deepEqual(statusBar({ focused: undefined, onRepo: false, waiting: 0 }), {
    text: "PR tour",
    tone: "neutral",
    tooltip: "PR Tour",
  });
  assert.equal(statusBar({ focused: undefined, onRepo: true, waiting: 3 }).text, "Reviews: 3");
  assert.deepEqual(
    statusBar({ focused: item({ status: "generating" }), onRepo: true, waiting: 1 }),
    {
      text: "PR tour: writing #7…",
      tone: "accent",
    },
  );
  assert.deepEqual(
    statusBar({
      focused: item({ status: "stale", risk: "medium", riskSummary: "Check the flag." }),
      onRepo: true,
      waiting: 1,
    }),
    { text: "PR tour: Medium risk (older commit)", tone: "warning", tooltip: "Check the flag." },
  );
  // A PR in the queue with no guide yet says nothing about risk.
  assert.equal(
    statusBar({ focused: item({ status: "none" }), onRepo: true, waiting: 2 }).text,
    "Reviews: 2",
  );
});
