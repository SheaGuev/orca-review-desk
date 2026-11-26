// The rail's Viewed boxes: each file row has its own, pressed apart from the row, and in the Files
// tree a folder of several files has one that ticks or unticks everything beneath it.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { assert, test } from "orca/testing";
import type { RailInput } from "../editor/rail";
import type { Viewed } from "../editor/viewed";

const GROUPS = [
  { title: "Core", files: ["src/a/x.ts", "src/a/y.ts"], flagged: false },
  { title: "Docs", files: ["docs/only.md", "README.md"], flagged: false },
];

function fakeViewed(start: string[]): { viewed: Viewed; sent: string[] } {
  const on = new Set(start);
  const listeners = new Set<() => void>();
  const sent: string[] = [];
  const viewed: Viewed = {
    has: (path) => on.has(path),
    set: (path, value) => {
      if (on.has(path) === value) return;
      sent.push(`${value ? "+" : "-"}${path}`);
      if (value) on.add(path);
      else on.delete(path);
      listeners.forEach((l) => l());
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { viewed, sent };
}

async function mountRail(start: string[]) {
  const { rail } = await import("../editor/rail");
  const { viewed, sent } = fakeViewed(start);
  const went: string[] = [];
  const input: RailInput = {
    groups: GROUPS,
    current: 0,
    seen: [],
    atWrapUp: false,
    finishLabel: "Finish review",
    skipped: new Map(),
    viewed,
    counts: Promise.resolve(new Map()),
    pending: () => [0, 0],
    onPendingChange: () => () => undefined,
    goGroup: () => undefined,
    goFile: (_group, path) => went.push(path),
    goOverview: () => undefined,
    goWrapUp: () => undefined,
    track: () => undefined,
  };
  const el = rail(input);
  document.body.replaceChildren(el);
  return { el, sent, went };
}

const fileBox = (el: HTMLElement, path: string) =>
  el.querySelector<HTMLInputElement>(`.rf[data-path="${path}"] input.cbox`);
const folder = (el: HTMLElement, name: string) =>
  Array.from(el.querySelectorAll<HTMLElement>(".ft-row")).find(
    (r) => r.querySelector(".ft-dir")?.textContent === name,
  );
const press = (box: HTMLInputElement | null | undefined) => {
  assert.ok(box);
  box.checked = !box.checked;
  box.dispatchEvent(new Event("change", { bubbles: true }));
};
const toFiles = (el: HTMLElement) =>
  Array.from(el.querySelectorAll<HTMLButtonElement>(".rail-mode button"))
    .find((b) => b.textContent === "Files")
    ?.click();

test("a file row's box marks it viewed without moving, and the rest of the row moves", async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  try {
    const { el, sent, went } = await mountRail([]);
    const box = fileBox(el, "src/a/x.ts");
    assert.equal(box?.getAttribute("aria-label"), "Viewed: src/a/x.ts");
    press(box);
    assert.deepEqual(sent, ["+src/a/x.ts"]);
    assert.deepEqual(went, [], "ticking the box doesn't go to the file");
    assert.ok(el.querySelector('.rf[data-path="src/a/x.ts"]')?.classList.contains("viewed"));
    el.querySelector<HTMLButtonElement>('.rf[data-path="src/a/y.ts"] .rf-go')?.click();
    assert.deepEqual(went, ["src/a/y.ts"], "pressing the name goes to it");
  } finally {
    await GlobalRegistrator.unregister();
  }
});

test("a folder's box is half-ticked for some, ticked for all, and ticks everything beneath", async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  try {
    const { el, sent } = await mountRail(["src/a/x.ts"]);
    toFiles(el);
    const box = folder(el, "src/a")?.querySelector<HTMLInputElement>("input.cbox");
    assert.ok(box, "a folder of two files has a box");
    assert.equal(box.disabled, false);
    assert.equal(box.indeterminate, true, "one of two viewed");
    press(box);
    assert.deepEqual(sent, ["+src/a/y.ts"], "ticks the rest");
    assert.equal(box.checked, true);
    assert.equal(box.indeterminate, false);
    press(box);
    assert.deepEqual(sent, ["+src/a/y.ts", "-src/a/x.ts", "-src/a/y.ts"], "and unticks all");
    assert.equal(fileBox(el, "src/a/x.ts")?.checked, false, "the file rows follow");
  } finally {
    await GlobalRegistrator.unregister();
  }
});

test("a folder holding one file has no box of its own, but keeps the space for one", async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  try {
    const { el } = await mountRail([]);
    toFiles(el);
    const row = folder(el, "docs");
    assert.ok(row, "the docs folder is listed");
    assert.equal(row.querySelector("input"), null);
    assert.ok(row.querySelector(".cbox-space"), "the box's space is kept so names line up");
    assert.ok(fileBox(el, "docs/only.md"), "its file still has its own box");
  } finally {
    await GlobalRegistrator.unregister();
  }
});
