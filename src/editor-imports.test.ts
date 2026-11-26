// Imports in the guide's diffs are links: a changed file goes to its card, any other file opens
// in Orca, a package says so, and a drag that selects text doesn't navigate. Runs the real guide
// tab in a headless DOM, as editor-groups.test.ts does.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { assert, test } from "orca/testing";
import { importSpans, linksImports } from "../editor/imports";
import { splitDiff } from "./diff";
import { fileDiffView } from "./diff-model";
import { AGENT_GUIDE, DIFF, PR_VIEW } from "./fixtures";
import { emptyDraft } from "./review";
import { freshTour } from "./tour";

const specs = (line: string) => importSpans(line).map((s) => line.slice(s.start, s.end));

test("specifiers are found in each import form, and only there", () => {
  assert.deepEqual(specs(`import { a } from './a'`), ["./a"]);
  assert.deepEqual(specs(`import type { B } from "rb-gql-types"`), ["rb-gql-types"]);
  assert.deepEqual(specs(`export * from '../index'`), ["../index"]);
  assert.deepEqual(specs(`} from '@aws-sdk/client-dynamodb'`), ["@aws-sdk/client-dynamodb"]);
  assert.deepEqual(specs(`import './polyfill'`), ["./polyfill"]);
  assert.deepEqual(specs(`const m = await import('./lazy')`), ["./lazy"]);
  assert.deepEqual(specs(`const fs = require("node:fs")`), ["node:fs"]);
  assert.deepEqual(specs(`logger.info('moved from "a" to b')`), [], "a string mentioning from");
  assert.deepEqual(specs(`const from = 'x'`), []);
  assert.deepEqual(specs(`// import a from './a'`), [], "a commented-out import");
  assert.ok(linksImports("src/a.tsx") && linksImports("lib/b.mjs"));
  assert.ok(!linksImports("schema.graphql") && !linksImports("README.md"));
});

const commit = PR_VIEW.headRefOid;
// The fixture's first file, with three of its lines turned into imports (same line counts).
const IMPORT_DIFF = DIFF.replace(" const a = 1;", " import { x } from './CustomerService';")
  .replace("+const b = 3;", "+import _ from 'lodash';")
  .replace("+const c = 4;", '+const u = require("./util");');
const files = splitDiff(IMPORT_DIFF, { keepLockfiles: true });
const [first, second] = AGENT_GUIDE.readingOrder;
const GUIDE = {
  schema: "prguide/v2",
  ...AGENT_GUIDE,
  readingOrder: [
    { ...first, files: ["src/SessionDataAccess.ts", "src/SessionDataAccess.test.ts"] },
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
  commentable: Object.fromEntries(files.map((f) => [f.path, [[1, 40]]])),
  skipped: [],
};

const TARGETS: Record<string, unknown> = {
  "./CustomerService": { path: "src/CustomerService.ts" },
  lodash: { reason: "external" },
  "./util": { path: "src/util.ts" },
};

function fakeOrca(asked: { name: string; input: unknown }[]) {
  const answers: Record<string, (input: never) => unknown> = {
    "review.get": () => ({ draft: emptyDraft(commit), canApprove: true, head: commit }),
    "review.save": () => ({ saved: true }),
    "diff.get": (input: { path: string }) =>
      fileDiffView(files.find((f) => f.path === input.path) ?? null, input.path, commit),
    "tour.get": () => freshTour(commit),
    "tour.save": () => ({ saved: true }),
    "viewed.get": () => ({ viewed: [] }),
    "import.resolve": (input: { specifier: string }) => TARGETS[input.specifier],
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
  await tick(120);
};
const heading = () => document.querySelector(".view-heading")?.textContent ?? "";
const link = (specifier: string) =>
  Array.from(document.querySelectorAll<HTMLElement>(".group-file .imp")).find(
    (l) => l.dataset.import === specifier,
  );
const notice = () => document.querySelector(".notice")?.textContent ?? "";
const resolved = (asked: { name: string; input: unknown }[]) =>
  asked.filter((a) => a.name === "import.resolve").length;

test("an import goes to a changed file's card, opens any other file, and names a package", async () => {
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
    const toChanged = link("./CustomerService");
    assert.ok(toChanged, "the specifier is a link");
    assert.equal(toChanged.textContent, "./CustomerService", "just the text inside the quotes");
    assert.equal(toChanged.title, "Open ./CustomerService");
    const added = link("lodash");
    assert.ok(added, "the lodash import is a link");
    assert.ok(added.closest(".dl.k-add"), "links sit in added rows too");

    const range = document.createRange();
    range.selectNodeContents(added);
    window.getSelection()?.addRange(range);
    await click(added, "a link with text selected over it");
    assert.equal(resolved(asked), 0, "a drag that selected text doesn't navigate");
    window.getSelection()?.removeAllRanges();

    await click(added, "the lodash import");
    assert.match(notice(), /lodash is a package from node_modules/);

    await click(link("./util"), "an import of a file the PR doesn't change");
    const open = asked.find((a) => a.name === "file.open");
    assert.deepEqual(open?.input, { repo: "acme/api", number: 7, path: "src/util.ts" });
    assert.match(notice(), /at the top of the file/);

    await click(link("./CustomerService"), "an import of a changed file");
    assert.equal(heading(), second?.title ?? second?.headline, "goes to that file's group");
    const from = asked.find((a) => a.name === "import.resolve")?.input;
    assert.deepEqual(from, {
      key: "acme/api#7",
      from: "src/SessionDataAccess.ts",
      specifier: "lodash",
    });
  } finally {
    await GlobalRegistrator.unregister();
  }
});

test("a row's specifier keeps its colour run and changed-word mark inside the link", async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  try {
    const { rowNode } = await import("../editor/diff-rows");
    const text = "import _ from 'lodash';";
    const el = rowNode({ kind: "add", old: null, new: 3, text }, () => false, {
      marks: [[15, 21]],
      toks: [
        { start: 0, end: 14, styles: {} },
        {
          start: 14,
          end: 22,
          styles: { "cursor-dark": { color: "#e394dc", italic: false, bold: false } },
        },
        { start: 22, end: 23, styles: {} },
      ],
      links: importSpans(text),
    });
    assert.equal(el.querySelector(".code")?.textContent, text, "the text is unchanged");
    const links = Array.from(el.querySelectorAll<HTMLElement>(".imp"));
    assert.equal(links.map((l) => l.textContent).join(""), "lodash");
    assert.ok(
      links.every((l) => l.querySelector(".word .tok")),
      "word mark and colour inside",
    );
  } finally {
    await GlobalRegistrator.unregister();
  }
});
