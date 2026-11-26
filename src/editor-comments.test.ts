// Commenting from the guide tab: Comment posts one comment now and it stays drawn as posted,
// outside the review; the wrap-up lists every comment of the review, pending then posted, each
// with its file line opening a snippet of the diff the first time. Runs the real guide tab in a
// headless DOM, as editor.test.ts does.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { assert, test } from "orca/testing";
import { splitDiff } from "./diff";
import { fileDiffView } from "./diff-model";
import { AGENT_GUIDE, DIFF, PR_VIEW } from "./fixtures";
import type { CommentRequest } from "./protocol";
import type { Draft, PostedComment } from "./review";
import { parseGuide } from "./schema";
import { freshTour } from "./tour";

const commit = PR_VIEW.headRefOid;
const files = splitDiff(DIFF, { keepLockfiles: true });
const PATH = "src/SessionDataAccess.ts";
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
const DRAFT: Draft = {
  commitId: commit,
  body: "",
  comments: [{ id: "p1", path: PATH, line: 12, body: "Pending one.", source: "manual" }],
  dismissedFindings: [],
};
const URL = "https://github.com/acme/api/pull/7#discussion_r101";

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

type Asked = { comments: CommentRequest[]; diffs: string[]; saved: Draft[] };

function fakeOrca(asked: Asked) {
  const answers: Record<string, (input: never) => unknown> = {
    "review.get": () => ({ draft: DRAFT, canApprove: true, head: commit, posted: [] }),
    "review.save": (input: { draft: Draft }) => {
      asked.saved.push(input.draft);
      return { saved: true };
    },
    "review.comment": (input: { comment: CommentRequest }) => {
      asked.comments.push(input.comment);
      const posted: PostedComment = {
        id: "101",
        path: input.comment.path,
        line: input.comment.line,
        body: input.comment.body,
        url: URL,
        at: 1,
      };
      return { outcome: "posted", comment: posted };
    },
    "diff.get": (input: { path: string }) => {
      asked.diffs.push(input.path);
      return fileDiffView(files.find((f) => f.path === input.path) ?? null, input.path, commit);
    },
    "tour.get": () => freshTour(commit),
    "tour.save": () => ({ saved: true }),
    "viewed.get": () => ({ viewed: [] }),
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

const button = (text: string, within: ParentNode = document): HTMLButtonElement | undefined =>
  Array.from(within.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").trim().startsWith(text),
  );

async function press(b: HTMLElement | null | undefined, what: string): Promise<void> {
  assert.ok(b, what);
  b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick(120);
}

/** Opens the composer on the first line, types, and presses Comment. */
async function commentNow(asked: Asked): Promise<void> {
  await press(document.querySelector<HTMLElement>(".stop .dl button.plus"), "a line's +");
  const box = document.querySelector<HTMLElement>(".composer");
  assert.ok(box && button("Add to review", box), "the composer still offers Add to review");
  const text = box.querySelector("textarea");
  assert.ok(text, "the composer has a text field");
  text.value = "Posted now.";
  text.dispatchEvent(new Event("input", { bubbles: true }));
  await press(button("Comment", box), "the composer offers Comment");
  assert.deepEqual(asked.comments, [{ path: PATH, line: 10, body: "Posted now." }]);
  assert.equal(document.querySelector(".composer"), null, "the composer closes once posted");
  const card = document.querySelector(".stop .posted-card");
  assert.ok(card?.textContent?.includes("Posted now."), "the posted comment shows in place");
  assert.ok(card && button("View on GitHub", card), "with the way to it on GitHub");
  assert.ok(
    asked.saved.every((d) => d.comments.every((c) => c.body !== "Posted now.")),
    "never saved into the review draft",
  );
}

/** The wrap-up's list: the pending comment, its snippet on demand, then the posted one. */
async function checkList(asked: Asked): Promise<void> {
  const pending = document.querySelector<HTMLElement>(".review-comments .rc.pending");
  const where = pending?.querySelector<HTMLElement>("button.rc-where");
  assert.equal(where?.title, PATH, "the full path is the toggle's title");
  assert.equal(where?.querySelector(".rc-dir")?.textContent, "src/");
  assert.equal(where?.querySelector(".rc-file")?.textContent, "SessionDataAccess.ts");
  assert.equal(where?.querySelector(".rc-line")?.textContent, "line 12");
  assert.ok(pending?.querySelector(".rc-body")?.textContent?.includes("Pending one."));
  const snippet = pending?.querySelector<HTMLElement>(".rc-snippet");
  assert.equal(snippet?.hidden, true, "the snippet starts closed");
  assert.equal(where?.getAttribute("aria-expanded"), "false");
  const before = asked.diffs.length;
  await press(where, "the file line opens the snippet");
  assert.equal(snippet?.hidden, false);
  assert.equal(asked.diffs.length, before + 1, "the diff is loaded on first open");
  assert.equal(snippet?.querySelector(".dl.target")?.getAttribute("data-line"), "12");
  assert.ok((snippet?.querySelectorAll(".dl").length ?? 0) > 1, "with rows above the line");
  await press(where, "closes again");
  await press(where, "and opens again");
  assert.equal(asked.diffs.length, before + 1, "without loading it twice");

  const posted = document.querySelector<HTMLElement>(".review-comments .rc.posted");
  assert.ok(posted && pending, "both comments are listed");
  assert.ok(posted.querySelector(".tag.posted"), "posted comments are marked Posted");
  assert.equal(posted.querySelector("textarea"), null, "and are not editable");
  const all = Array.from(document.querySelectorAll(".review-comments > .rc"));
  assert.ok(all.indexOf(posted) > all.indexOf(pending), "after the pending ones");
  assert.ok(document.querySelector(".eyebrow")?.textContent?.includes("1 pending · 1 posted"));
}

const menuOf = (rc: HTMLElement | null) => ({
  more: rc?.querySelector<HTMLButtonElement>(".rc-more") ?? null,
  items: () =>
    Array.from(rc?.querySelectorAll<HTMLElement>(".rc-menu [role=menuitem]") ?? []).map((b) =>
      (b.textContent ?? "").trim(),
    ),
  open: () => rc?.querySelector<HTMLElement>(".rc-menu")?.hidden === false,
});

/** The header row holds only where, the badge and ⋯; the actions live in the ⋯ menu. */
async function checkMenus(asked: Asked): Promise<void> {
  const rc = () => document.querySelector<HTMLElement>(".rc.pending");
  const head = rc()?.querySelector(".rc-head");
  assert.deepEqual(
    Array.from(head?.children ?? []).map((c) => c.className),
    ["rc-where", "tag pending", "rc-more-wrap"],
  );
  const m = menuOf(rc());
  assert.equal(m.more?.getAttribute("aria-haspopup"), "menu");
  await press(m.more, "⋯ opens the menu");
  assert.ok(m.open() && m.more?.getAttribute("aria-expanded") === "true");
  assert.deepEqual(m.items(), ["Show in diff", "Edit", "Delete"]);
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  assert.ok(!m.open() && document.activeElement === m.more, "Esc closes it, focus back on ⋯");

  await press(m.more, "⋯ again");
  await press(button("Edit", rc() ?? document), "Edit");
  const text = rc()?.querySelector<HTMLTextAreaElement>(".rc-text textarea");
  assert.equal(text?.value, "Pending one.", "the comment turns into its text field, in place");
  if (text) {
    text.value = "Edited.";
    text.dispatchEvent(new Event("input", { bubbles: true }));
  }
  await press(button("Save", rc() ?? document), "Save");
  await tick(400);
  assert.equal(rc()?.querySelector(".rc-text .rc-body")?.textContent, "Edited.");
  assert.equal(asked.saved.at(-1)?.comments[0]?.body, "Edited.", "saved into the draft");

  const posted = menuOf(document.querySelector<HTMLElement>(".rc.posted"));
  await press(posted.more, "the posted comment's ⋯");
  assert.deepEqual(posted.items(), ["Show in diff", "Open on GitHub ↗"]);
  await press(posted.more, "closes");

  await press(menuOf(rc()).more, "⋯ on the pending comment");
  await press(button("Delete", rc() ?? document), "Delete");
  await tick(400);
  assert.equal(rc(), null, "the pending comment is gone");
  assert.deepEqual(asked.saved.at(-1)?.comments, [], "and out of the draft");
}

test("Comment posts at once and stays posted; the wrap-up lists pending then posted", async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  const asked: Asked = { comments: [], diffs: [], saved: [] };
  fakeOrca(asked);
  try {
    await import("../editor/main.ts");
    await tick(150);
    await press(button("Start tour"), "Start tour");
    await commentNow(asked);
    await press(button("Finish review"), "Finish review");
    await checkList(asked);
    await checkMenus(asked);
  } finally {
    await GlobalRegistrator.unregister();
  }
});

test("a claims row keeps its badge and its text in cells of their own", async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  try {
    const { claims } = await import("../editor/parts");
    const checked = parseGuide(GUIDE);
    assert.ok(checked.ok && checked.guide.schema === "prguide/v2", "the fixture is a valid guide");
    const row = claims(checked.guide)?.querySelector("li.claim");
    const cells = Array.from(row?.children ?? []);
    assert.deepEqual(
      cells.map((c) => c.className),
      ["tag ok", "measure"],
      "two grid cells, so text never runs under the badge",
    );
  } finally {
    await GlobalRegistrator.unregister();
  }
});
