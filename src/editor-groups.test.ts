// A group shows every one of its files as a diff card, test files closed, and the rail lists the
// groups with their files (or a folder tree) and a Reviewed box per group. Runs the real guide tab
// in a headless DOM, as editor.test.ts does.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { assert, test } from "orca/testing";
import { isTestPath } from "../editor/group";
import { folderTree } from "../editor/file-tree";
import { splitDiff } from "./diff";
import { fileDiffView } from "./diff-model";
import { AGENT_GUIDE, DIFF, nth, PR_VIEW } from "./fixtures";
import { emptyDraft } from "./review";
import { freshTour } from "./tour";

const commit = PR_VIEW.headRefOid;
const files = splitDiff(DIFF, { keepLockfiles: true });
const [first, second] = AGENT_GUIDE.readingOrder;
const GROUPS = [
  { ...first, files: ["src/SessionDataAccess.ts", "src/SessionDataAccess.test.ts"] },
  { ...second, depth: "deep", files: ["src/CustomerService.ts", "README.md"] },
];
const GUIDE = {
  schema: "prguide/v2",
  ...AGENT_GUIDE,
  readingOrder: GROUPS,
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
  commentable: Object.fromEntries(files.map((f) => [f.path, [[1, 40]]])),
  skipped: [],
};

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeOrca(sent: { path: string; viewed: boolean }[]) {
  const answers: Record<string, (input: never) => unknown> = {
    "review.get": () => ({ draft: emptyDraft(commit), canApprove: true, head: commit }),
    "review.save": () => ({ saved: true }),
    "diff.get": (input: { path: string }) =>
      fileDiffView(files.find((f) => f.path === input.path) ?? null, input.path, commit),
    "tour.get": () => freshTour(commit),
    "tour.save": () => ({ saved: true }),
    "viewed.get": () => ({ viewed: [] }),
    "viewed.set": (input: { path: string; viewed: boolean }) => {
      sent.push({ path: input.path, viewed: input.viewed });
      return { viewed: input.viewed };
    },
  };
  Object.assign(globalThis, {
    orca: {
      plugin: {
        request: async (name: string, input: never) => {
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

const click = async (el: Element | null | undefined, what: string) => {
  assert.ok(el, what);
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick(120);
};
const heading = () => document.querySelector(".view-heading")?.textContent ?? "";
const cards = () => Array.from(document.querySelectorAll<HTMLElement>(".stop .group-file"));
const card = (path: string) => cards().find((c) => c.dataset.path === path);
const isOpen = (path: string) =>
  card(path)?.querySelector(".dv-toggle")?.getAttribute("aria-expanded") === "true";
const railFile = (path: string) =>
  Array.from(document.querySelectorAll<HTMLElement>(".rail .rf")).find(
    (b) => b.dataset.path === path,
  );
const railGo = (path: string) => railFile(path)?.querySelector(".rf-go");

test("test files are known by their name or folder", () => {
  assert.ok(isTestPath("src/SessionDataAccess.test.ts"));
  assert.ok(isTestPath("a/__tests__/x.ts"));
  assert.ok(isTestPath("test-e2e/user-journey-v2/check-in.e2e.test.ts"));
  assert.ok(isTestPath("web/login.spec.tsx"));
  assert.ok(!isTestPath("src/testing-utils/contest.ts"));
});

test("the Files tree puts folders first and folds a chain of single folders", () => {
  const tree = folderTree(["README.md", "packages/a/src/x.ts", "packages/a/src/y.ts", "b.ts"]);
  assert.deepEqual(
    tree.map((n) => `${n.kind}:${n.name}`),
    ["dir:packages/a/src", "file:b.ts", "file:README.md"],
  );
  const dir = nth(tree);
  assert.ok(dir.kind === "dir");
  assert.deepEqual(
    dir.children.map((n) => n.path),
    ["packages/a/src/x.ts", "packages/a/src/y.ts"],
  );
});

test("a group stacks its files, the rail moves between them, and Reviewed ticks a whole group", async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  const sent: { path: string; viewed: boolean }[] = [];
  fakeOrca(sent);
  try {
    await import("../editor/main.ts");
    await tick(150);
    await click(
      Array.from(document.querySelectorAll("button")).find((b) =>
        (b.textContent ?? "").trim().startsWith("Start tour"),
      ),
      "Start tour",
    );
    assert.deepEqual(
      cards().map((c) => c.dataset.path),
      ["src/SessionDataAccess.ts", "src/SessionDataAccess.test.ts"],
      "every file of the group is a card, in the group's order",
    );
    assert.ok(isOpen("src/SessionDataAccess.ts"), "the code file is open");
    assert.ok(!isOpen("src/SessionDataAccess.test.ts"), "the test file starts closed");
    assert.ok(
      card("src/SessionDataAccess.test.ts")?.querySelector(".test-hint"),
      "with a Show diff hint",
    );
    const marked = Array.from(
      card("src/SessionDataAccess.ts")?.querySelectorAll(".dl.focus-line") ?? [],
    ).map((r) => r.getAttribute("data-line"));
    assert.deepEqual(marked, ["11", "12"], "the focus lines are marked, not filtered");

    assert.equal(document.querySelectorAll(".rail .rg").length, 2, "one rail section per group");
    await click(railGo("src/SessionDataAccess.test.ts"), "the test file in the rail");
    assert.equal(heading(), first?.title ?? first?.headline, "a file in this group stays here");
    assert.ok(isOpen("src/SessionDataAccess.test.ts"), "and its card opens");

    await click(railGo("src/CustomerService.ts"), "a file of the next group in the rail");
    assert.equal(heading(), second?.title ?? second?.headline, "goes to that file's group");
    assert.ok(card("src/CustomerService.ts")?.classList.contains("is-target"));

    const box = document.querySelector<HTMLInputElement>(
      '.rail .rg-reviewed input[data-group="1"]',
    );
    assert.ok(box, "the group has a Reviewed box");
    assert.equal(box.disabled, false, "ready once GitHub's state is read");
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    assert.deepEqual(
      sent.map((s) => s.path).sort(),
      ["README.md", "src/CustomerService.ts"],
      "Reviewed marks every file of the group viewed",
    );
    assert.ok(railFile("README.md")?.classList.contains("viewed"), "the rail ticks them");

    await click(
      Array.from(document.querySelectorAll(".rail-mode button")).find(
        (b) => b.textContent === "Files",
      ),
      "the Files toggle",
    );
    const dirs = Array.from(document.querySelectorAll(".rail .ft-dir")).map((d) => d.textContent);
    assert.deepEqual(dirs, ["src"], "files sit under their folder");
    await click(railGo("src/SessionDataAccess.ts"), "a file in the tree");
    assert.equal(heading(), first?.title ?? first?.headline, "the tree goes to the file's group");
  } finally {
    await GlobalRegistrator.unregister();
  }
});
