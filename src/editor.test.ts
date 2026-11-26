// Runs the real guide tab (editor/main.ts) in a headless DOM, with the worker stood in by a
// table of answers, and walks one review through it: overview, a stop, a comment on a line, the
// wrap-up, posting. It checks what a reviewer would see and what the worker is asked.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { assert, test } from "orca/testing";
import { splitDiff } from "./diff";
import { fileDiffView } from "./diff-model";
import { AGENT_GUIDE, DIFF, nth, PR_VIEW } from "./fixtures";
import { emptyDraft, type Draft } from "./review";
import { freshTour } from "./tour";

const commit = PR_VIEW.headRefOid;
const files = splitDiff(DIFF, { keepLockfiles: true });
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

test("a review goes from the overview through a stop to a posted review", async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  let draft: Draft = emptyDraft(commit);
  const asked: { name: string; input: unknown }[] = [];
  let replace: (text: string) => void = () => undefined;
  const answers: Record<string, (input: never) => unknown> = {
    "review.get": () => ({ draft, canApprove: true, head: commit }),
    "review.save": (input: { draft: Draft }) => {
      draft = input.draft;
      return { saved: true };
    },
    "review.submit": (input: { event: string }) => {
      draft = emptyDraft(commit);
      return { outcome: "posted", event: input.event, url: null, notPosted: [] };
    },
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
          Promise.resolve({
            value: JSON.stringify(GUIDE),
            onReplace: (listener: (text: string) => void) => {
              replace = listener;
            },
          }),
      },
    },
  });
  window.scrollTo = () => undefined;

  const press = async (text: string, within = "body") => {
    const button = Array.from(document.querySelectorAll(`${within} button`)).find((b) =>
      (b.textContent ?? "").trim().startsWith(text),
    );
    assert.ok(button, `a "${text}" button in ${within}`);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await tick();
  };
  const heading = () => document.querySelector(".view-heading")?.textContent ?? "";

  try {
    await import("../editor/main.ts");
    await tick(150);
    assert.equal(heading(), AGENT_GUIDE.title, "the overview opens on the guide's title");

    // The overview's tour: one step per stop, and the step the tour starts at marked as such.
    const steps = Array.from(document.querySelectorAll<HTMLElement>(".tour-step"));
    assert.equal(steps.length, AGENT_GUIDE.readingOrder.length, "one step per stop");
    // Short names only: a stop's title, else its file; the sentence waits for the stop itself.
    assert.deepEqual(
      steps.map((el) => el.querySelector(".tour-step-text")?.textContent),
      ["SessionDataAccess.ts", "CustomerService.ts", "SessionDataAccess.test.ts +1"],
      "each step is named by its file when the guide has no titles",
    );
    assert.ok(nth(steps).textContent?.includes("Start here"), "the first step is where it starts");
    assert.equal(document.querySelector(".route-caption"), null, "no hover-only caption");

    await press("Start tour");
    assert.equal(heading(), nth(AGENT_GUIDE.readingOrder).headline, "stop 1");
    /** Comments on the first commentable line of the stop shown, and waits for the save. */
    const addComment = async (): Promise<number> => {
      const plus = document.querySelector<HTMLElement>(".dl[data-line] button.plus");
      assert.ok(plus, "a line of the diff takes a comment");
      const at = Number(plus.closest(".dl")?.getAttribute("data-line"));
      plus.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await tick();
      const text = document.querySelector<HTMLTextAreaElement>(".composer textarea");
      assert.ok(text, "the composer opens under the line");
      text.value = "Why this value?";
      text.dispatchEvent(new Event("input", { bubbles: true }));
      await press("Add to review", ".composer");
      assert.ok(document.querySelector(".draft-card"), "the comment sits under its line as a card");
      await tick(400);
      return at;
    };
    const line = await addComment();
    assert.deepEqual(
      draft.comments.map((c) => [c.path, c.line, c.body, c.source]),
      [[nth(nth(AGENT_GUIDE.readingOrder).files), line, "Why this value?", "manual"]],
      "the draft is saved through the worker",
    );

    // Restart starts the review over too, but asks first while the review holds anything.
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    await press("Restart");
    assert.ok(
      document.querySelector(".restart-confirm")?.textContent?.includes("1 comment"),
      "it says what would be discarded",
    );
    await press("Cancel", ".restart-confirm");
    await tick(400);
    assert.equal(draft.comments.length, 1, "Cancel keeps the review");
    await press("Restart");
    await press("Restart and discard", ".restart-confirm");
    await tick(400);
    assert.equal(heading(), nth(AGENT_GUIDE.readingOrder).headline, "back at stop 1");
    assert.deepEqual(draft.comments, [], "with the review emptied");
    // Comment again, so the rest of the walk has a comment to post.
    await addComment();

    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    await tick();
    assert.equal(heading(), nth(AGENT_GUIDE.readingOrder, 1).headline, "j steps to stop 2");

    await press("Finish review");
    assert.equal(
      heading(),
      "Finish review",
      "one name for the last step, as the bar's button says",
    );
    assert.equal(document.querySelectorAll(".review-comments .rc.pending").length, 1);
    // In the order of the work: the open major finding comes before the review, and deciding on
    // it takes it off the list.
    const work = document.querySelector(".wrap-main")?.textContent ?? "";
    assert.ok(
      work.indexOf("Findings to handle") < work.indexOf("Your review"),
      "findings come first",
    );
    assert.equal(document.querySelectorAll(".wrap-main .finding-row").length, 1, "one open major");
    await press("Dismiss", ".wrap-main .finding-row");
    assert.equal(document.querySelectorAll(".wrap-main .finding-row").length, 0, "dismissed");
    assert.ok(document.querySelector(".handled"), "and the list says they are all handled");
    // The verdict is a choice; only Post to GitHub sends anything.
    const approve = document.querySelector<HTMLInputElement>(
      'input[name="verdict"][value="APPROVE"]',
    );
    assert.ok(approve, "Approve can be chosen");
    approve.checked = true;
    approve.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    assert.equal(
      document.querySelector(".post-what")?.textContent,
      "Posts to acme/api #7 as Approve, with 1 line comment.",
      "the line above the button says what a press will send",
    );
    assert.equal(
      asked.some((a) => a.name === "review.submit"),
      false,
      "choosing a verdict posts nothing",
    );
    await press("Post to GitHub");
    await tick(150);
    const submit = asked.find((a) => a.name === "review.submit");
    assert.deepEqual(submit?.input, { key: "acme/api#7", event: "APPROVE", body: "" });
    assert.equal(
      document.querySelector(".posted-title")?.textContent,
      "✓ Review posted",
      "the composer gives way to what was posted",
    );
    assert.equal(document.querySelector("#verdict-body"), null, "with nothing left to post again");

    replace("{ not json");
    await tick(100);
    assert.ok(
      document.querySelector('[role="alert"]')?.textContent?.includes("doesn’t match the prguide"),
      "a file that is not a guide says so",
    );
  } finally {
    await GlobalRegistrator.unregister();
  }
});
