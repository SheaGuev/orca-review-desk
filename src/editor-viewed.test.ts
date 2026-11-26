// GitHub's Viewed checkbox in each file's header: it shows what GitHub has, a press is sent to
// GitHub at once, and a refusal puts the box back and says why. Runs the real guide tab in a
// headless DOM, as editor.test.ts does.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { assert, test } from "orca/testing";
import { splitDiff } from "./diff";
import { fileDiffView } from "./diff-model";
import { AGENT_GUIDE, DIFF, nth, PR_VIEW } from "./fixtures";
import { emptyDraft } from "./review";
import { freshTour } from "./tour";

const commit = PR_VIEW.headRefOid;
const files = splitDiff(DIFF, { keepLockfiles: true });
const primary = nth(nth(AGENT_GUIDE.readingOrder).files);
const GUIDE = {
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
  sinceLastReview: null,
  coverage: null,
  commentable: Object.fromEntries(files.map((f) => [f.path, [[1, 40]]])),
  skipped: [],
};

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeOrca(answers: Record<string, (input: never) => unknown>) {
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

test("the Viewed box follows GitHub, sends each press, and goes back when GitHub refuses", async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  const sent: { path: string; viewed: boolean }[] = [];
  let refuse = false;
  fakeOrca({
    "review.get": () => ({ draft: emptyDraft(commit), canApprove: true, head: commit }),
    "review.save": () => ({ saved: true }),
    "diff.get": (input: { path: string }) =>
      fileDiffView(files.find((f) => f.path === input.path) ?? null, input.path, commit),
    "tour.get": () => freshTour(commit),
    "tour.save": () => ({ saved: true }),
    "viewed.get": () => ({ viewed: [primary] }),
    "viewed.set": (input: { path: string; viewed: boolean }) => {
      if (refuse) throw new Error("GitHub: Resource not accessible by integration");
      sent.push({ path: input.path, viewed: input.viewed });
      return { viewed: input.viewed };
    },
  });
  const view = () => document.querySelector<HTMLElement>(".stop .diff-view");
  const box = () => view()?.querySelector<HTMLInputElement>(".dv-viewed input");
  const press = async (checked: boolean) => {
    const b = box();
    assert.ok(b, "the file has a Viewed box");
    b.checked = checked;
    b.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
  };

  try {
    await import("../editor/main.ts");
    await tick(150);
    const start = Array.from(document.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").trim().startsWith("Start tour"),
    );
    start?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await tick(150);
    assert.equal(view()?.querySelector(".dv-path-text")?.textContent, primary);
    assert.equal(box()?.checked, true, "ticked, as on GitHub");
    assert.equal(box()?.disabled, false);

    await press(false);
    assert.deepEqual(sent, [{ path: primary, viewed: false }]);
    assert.equal(view()?.classList.contains("collapsed"), false, "unticking leaves the file open");

    await press(true);
    assert.deepEqual(nth(sent, 1), { path: primary, viewed: true });
    assert.equal(view()?.classList.contains("collapsed"), true, "ticking closes the file");

    refuse = true;
    await press(false);
    assert.equal(box()?.checked, true, "a refused press goes back");
    const notice = document.querySelector(".notice")?.textContent ?? "";
    assert.ok(
      notice.includes("Couldn’t mark") && notice.includes("Resource not accessible"),
      notice,
    );
  } finally {
    await GlobalRegistrator.unregister();
  }
});
