// "Since your last review" on the guide's overview: one line under the header that says what is
// worth acting on, the per-file list behind Show changes, and the tour's stops marked where a file
// changed. Runs the real guide tab in a headless DOM, as editor.test.ts does.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { assert, test } from "orca/testing";
import { splitDiff } from "./diff";
import { fileDiffView } from "./diff-model";
import { AGENT_GUIDE, DIFF, PR_VIEW } from "./fixtures";
import { emptyDraft } from "./review";
import { freshTour } from "./tour";

const commit = PR_VIEW.headRefOid;
const files = splitDiff(DIFF, { keepLockfiles: true });
const SINCE = {
  fromCommit: "0b9366c0000000000000000000000000000000000",
  toCommit: commit,
  changes: [
    {
      file: "src/SessionDataAccess.ts",
      headline: "Keeps the session row until the event is written",
      answersComment: true,
    },
    { file: "README.md", headline: "Notes the new event", answersComment: false },
  ],
  riskChanged: false,
  openComments: 2,
};
const guide = (since: unknown) => ({
  schema: "prguide/v2",
  ...AGENT_GUIDE,
  pr: {
    repo: "acme/api",
    number: 7,
    url: PR_VIEW.url,
    author: "sam",
    commit,
    baseRef: "main",
    headRef: PR_VIEW.headRefName,
    additions: 120,
    deletions: 30,
    fileCount: 4,
    requestedAt: null,
    hasDescription: true,
  },
  generatedBy: { harness: "claude", model: null, at: "2026-11-19T10:00:00Z" },
  reviewRequest: "user",
  areas: AGENT_GUIDE.areas.map((a) => ({ ...a, additions: 1, deletions: 0 })),
  sinceLastReview: since,
  coverage: null,
  commentable: Object.fromEntries(files.map((f) => [f.path, [[1, 40]]])),
  skipped: [],
});

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

test("Since your last review is one line, with the changed files behind Show changes", async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  let replace: (text: string) => void = () => undefined;
  const asked: string[] = [];
  const answers: Record<string, (input: never) => unknown> = {
    "review.get": () => ({ draft: emptyDraft(commit), canApprove: true, head: commit }),
    "review.save": () => ({ saved: true }),
    "diff.get": (input: { path: string }) =>
      fileDiffView(files.find((f) => f.path === input.path) ?? null, input.path, commit),
    "breakdown.get": () => {
      throw new Error("not in this test");
    },
    "tour.get": () => freshTour(commit),
    "tour.save": () => ({ saved: true }),
  };
  Object.assign(globalThis, {
    orca: {
      plugin: {
        request: async (name: string, input: never) => {
          asked.push(name);
          const answer = answers[name];
          if (!answer) throw new Error(`no answer for ${name}`);
          return structuredClone(await answer(input));
        },
      },
      host: { has: () => false },
      on: () => undefined,
      shell: { openExternal: () => undefined },
      document: {
        session: () =>
          Promise.resolve({
            value: JSON.stringify(guide(SINCE)),
            onReplace: (listener: (text: string) => void) => {
              replace = listener;
            },
          }),
      },
    },
  });
  window.scrollTo = () => undefined;
  const line = () => document.querySelector<HTMLElement>(".since");
  const toggle = () =>
    Array.from(line()?.querySelectorAll("button") ?? []).find((b) =>
      /^(Show|Hide) changes$/.test((b.textContent ?? "").trim()),
    );

  try {
    await import("../editor/main.ts");
    await tick(150);

    // One line: what changed and what is still yours to act on; nothing that changes no decision.
    const text = line()?.textContent ?? "";
    assert.ok(text.includes("2 files changed since you last looked"), text);
    assert.ok(text.includes("2 of your comments still open"), text);
    assert.ok(text.includes("1 answers your comment"), text);
    assert.ok(!/risk/i.test(text), `an unchanged risk is not mentioned: ${text}`);
    assert.ok(!text.includes("→"), `no commit pair: ${text}`);
    assert.equal(
      Array.from(document.querySelectorAll("h2")).some((h) =>
        (h.textContent ?? "").startsWith("Since your last review"),
      ),
      false,
      "no section heading above the summary",
    );

    // Collapsed by default; Show changes opens the per-file list, Hide changes closes it.
    assert.equal(line()?.querySelectorAll("li").length, 0, "no file rows until asked");
    assert.equal(toggle()?.textContent?.trim(), "Show changes");
    assert.equal(toggle()?.getAttribute("aria-expanded"), "false");
    const diffsBefore = asked.filter((n) => n === "diff.get").length;
    toggle()?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await tick();
    assert.equal(line()?.querySelectorAll("li").length, 2, "one row per changed file");
    assert.ok(line()?.textContent?.includes("answers your comment"));
    assert.ok(line()?.textContent?.includes("Keeps the session row until the event is written"));
    assert.equal(toggle()?.textContent?.trim(), "Hide changes");
    assert.equal(toggle()?.getAttribute("aria-expanded"), "true");
    // No diffs here: the tour shows them. Each row leads to the stop that covers its file.
    assert.equal(
      asked.filter((n) => n === "diff.get").length,
      diffsBefore,
      "opening the list loads no diff",
    );
    assert.equal(line()?.querySelectorAll(".diff, .dl").length, 0, "no diff lines in the list");
    const links = () =>
      Array.from(line()?.querySelectorAll("li button") ?? []).map((b) =>
        (b.textContent ?? "").trim(),
      );
    assert.deepEqual(links(), ["Stop 1 →", "Stop 3 →"]);
    toggle()?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await tick();
    assert.equal(line()?.querySelectorAll("li").length, 0, "closed again");

    // The tour marks the stops that cover a changed file, in words.
    const steps = Array.from(document.querySelectorAll<HTMLElement>(".tour-step"));
    assert.deepEqual(
      steps.map((s) => /\bchanged\b/.test(s.textContent ?? "")),
      [true, false, true],
      "stop 1 (SessionDataAccess.ts) and stop 3 (README.md) changed; stop 2 did not",
    );

    // A changed risk is said once, with the level it is now; no open comments, no count.
    replace(JSON.stringify(guide({ ...SINCE, riskChanged: true, openComments: 0 })));
    await tick(150);
    const changed = line()?.textContent ?? "";
    assert.ok(/risk is now high/i.test(changed), changed);
    assert.ok(!changed.includes("still open"), changed);

    // A row's link opens its stop in the tour.
    toggle()?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await tick();
    Array.from(line()?.querySelectorAll("li button") ?? [])
      .find((b) => (b.textContent ?? "").trim() === "Stop 3 →")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await tick(100);
    assert.equal(
      document.querySelector(".view-heading")?.textContent,
      AGENT_GUIDE.readingOrder[2]?.headline,
      "Stop 3 → opens stop 3",
    );

    // A first visit has nothing since a last one: no line, no markers.
    replace(JSON.stringify(guide(null)));
    await tick(150);
    assert.equal(line(), null);
    assert.ok(
      Array.from(document.querySelectorAll(".tour-step")).every(
        (s) => !/\bchanged\b/.test(s.textContent ?? ""),
      ),
    );
  } finally {
    await GlobalRegistrator.unregister();
  }
});
