// The guide tab names the agent that wrote the guide, for every agent PR Tour can run.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { assert, test } from "orca/testing";
import type { PrGuide } from "./schema";

const guideBy = (harness: string, coverage: PrGuide["coverage"] = null) =>
  ({
    generatedBy: { harness, model: null, at: "2026-11-19T10:00:00Z" },
    pr: { commit: "abcdef1234567" },
    coverage,
  }) as unknown as PrGuide;

const text = (nodes: (Node | string)[]) =>
  nodes.map((n) => (typeof n === "string" ? n : (n.textContent ?? ""))).join("");

test("provenance names the agent that wrote the guide, for every agent", async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  try {
    const { provenance } = await import("../editor/parts");
    assert.ok(text(provenance(guideBy("claude"))).startsWith("Claude Code · "));
    assert.ok(text(provenance(guideBy("codex"))).startsWith("Codex · "));
    assert.ok(text(provenance(guideBy("gemini"))).startsWith("Gemini CLI · "));
    assert.ok(text(provenance(guideBy("cursor"))).startsWith("Cursor · "));
  } finally {
    await GlobalRegistrator.unregister();
  }
});

test("the coverage note explains a missing read log for any agent that reports no tool calls", async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  try {
    const { coverageLine } = await import("../editor/parts");
    const coverage = { inPrompt: ["a.ts"], readByAgent: [], notRead: ["b.ts"] };
    const note = (h: string) => coverageLine(guideBy(h, coverage))?.textContent ?? "";
    assert.ok(
      note("gemini").includes("Gemini CLI does not report which files it opened"),
      note("gemini"),
    );
    assert.ok(note("codex").includes("Codex does not report which files it opened"));
    assert.ok(!note("claude").includes("does not report"), note("claude"));
  } finally {
    await GlobalRegistrator.unregister();
  }
});
