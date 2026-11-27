// The unchanged lines between hunks open from the gutter's arrows, 20 at a time, from the file's
// PR-head text; what was opened is kept in the tab's memory and drawn again when the tab reloads.
// Runs the real guide tab in a headless DOM, as editor-imports.test.ts does.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { assert, test } from "orca/testing";
import { splitDiff } from "./diff";
import { fileDiffView, fileLinesView } from "./diff-model";
import { AGENT_GUIDE, DIFF, PR_VIEW } from "./fixtures";
import { emptyDraft } from "./review";
import { freshTour } from "./tour";

const commit = PR_VIEW.headRefOid;
const files = splitDiff(DIFF, { keepLockfiles: true });
const PATH = "src/SessionDataAccess.ts";
const [first, second] = AGENT_GUIDE.readingOrder;
const GUIDE = {
  schema: "prguide/v2",
  ...AGENT_GUIDE,
  readingOrder: [
    { ...first, files: [PATH, "src/SessionDataAccess.test.ts"] },
    { ...second, depth: "deep", files: ["src/CustomerService.ts", "README.md"] },
  ],
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
  sinceLastReview: null,
  coverage: null,
  commentable: Object.fromEntries(files.map((f) => [f.path, [[10, 13]]])),
  skipped: [],
};

// 60 lines; the diff's hunk is lines 10 to 13.
const TEXT = Array.from({ length: 60 }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\n");
// The tab was left with the top of the file opened (the 9 lines above the hunk).
const KEPT = {
  scroll: null,
  files: { [`stop:0|${PATH}`]: { expansions: [[0, { top: 9, bottom: 0 }]] } },
};

function fakeOrca(asked: { name: string; input: unknown }[]) {
  const answers: Record<string, (input: never) => unknown> = {
    "review.get": () => ({ draft: emptyDraft(commit), canApprove: true, head: commit }),
    "review.save": () => ({ saved: true }),
    "diff.get": (input: { path: string }) =>
      fileDiffView(files.find((f) => f.path === input.path) ?? null, input.path, commit),
    "file.lines": () => fileLinesView(TEXT),
    "tour.get": () => freshTour(commit),
    "tour.save": () => ({ saved: true }),
    "tab.get": () => ({ memory: KEPT }),
    "tab.save": () => ({ saved: true }),
    "viewed.get": () => ({ viewed: [] }),
    "file.open": () => ({ opened: true }),
  };
  Object.assign(globalThis, {
    orca: {
      plugin: {
        request: async (name: string, input: never) => {
          asked.push({ name, input });
          const answer = answers[name];
          if (!answer) throw new Error(`no answer for ${name}`);
          return structuredClone(await answer(input));
        },
      },
      host: { has: () => false },
      on: () => undefined,
      shell: { openExternal: () => undefined },
      settings: {
        get: async () => undefined,
        set: async () => undefined,
        onDidChange: () => ({ dispose: () => undefined }),
      },
      document: {
        session: () =>
          Promise.resolve({ value: JSON.stringify(GUIDE), onReplace: () => undefined }),
      },
    },
  });
  window.scrollTo = () => undefined;
}

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const click = async (el: Element | null | undefined, what: string) => {
  assert.ok(el, what);
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick(150);
};
const card = () => document.querySelector(`.group-file[data-path="${PATH}"]`);
const lineRow = (n: number) => card()?.querySelector<HTMLElement>(`.dl[data-line="${n}"]`);
const arrow = (dir: string) => card()?.querySelector(`button.expand[data-dir="${dir}"]`);

test("arrows open the lines between hunks, and the tab draws them again after a reload", async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  const asked: { name: string; input: unknown }[] = [];
  fakeOrca(asked);
  try {
    await import("../editor/main.ts");
    await tick(150);
    await click(
      Array.from(document.querySelectorAll("button")).find((b) =>
        (b.textContent ?? "").trim().startsWith("Start tour"),
      ),
      "Start tour",
    );
    await tick(200);
    // Kept from last time: lines 1 to 9 drawn, and the hunk header above them gone.
    assert.ok(lineRow(1)?.classList.contains("x-ctx"), "line 1 drawn from memory");
    assert.equal(lineRow(9)?.querySelector(".code")?.textContent, "const line9 = 9;");
    const headers = Array.from(card()?.querySelectorAll(".dl.hunk .code") ?? []);
    assert.ok(!headers.some((c) => c.textContent?.startsWith("@@")), "no header once top is open");
    assert.ok(!lineRow(5)?.querySelector("button.plus"), "an opened line takes no comment");
    assert.ok(lineRow(10)?.querySelector("button.plus"), "a diff line still does");

    // After the hunk: 47 lines left, so one press shows 20 of them.
    assert.ok(!lineRow(14), "line 14 hidden at first");
    await click(arrow("down"), "the down arrow after the last hunk");
    assert.ok(lineRow(14) && lineRow(33) && !lineRow(34), "20 lines opened");
    await click(arrow("down"), "down again");
    await click(arrow("all"), "the last 7 at once");
    assert.ok(lineRow(60), "the file's last line");
    assert.ok(!arrow("down") && !arrow("all"), "no arrows once all is shown");
    const lines = asked.filter((a) => a.name === "file.lines");
    assert.equal(lines.length, 1, "the file's text is asked for once");

    await tick(400);
    const saves = asked.filter((a) => a.name === "tab.save");
    assert.deepEqual(saves.at(-1)?.input, {
      key: "acme/api#7",
      memory: {
        scroll: null,
        files: {
          [`stop:0|${PATH}`]: {
            full: true,
            revealed: [],
            expansions: [
              [0, { top: 9, bottom: 0 }],
              [6, { top: 47, bottom: 0 }],
            ],
          },
        },
      },
    });
  } finally {
    await GlobalRegistrator.unregister();
  }
});
