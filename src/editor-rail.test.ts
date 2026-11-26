// The guide tab's rail layout and file headers: showing and hiding the rail, dragging it wider,
// the Viewed box beside the header's buttons, and names that stay apart when shortened.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { assert, test } from "orca/testing";
import { splitName, splitPath } from "../editor/dom";
import { clampWidth, RAIL_MIN_PX } from "../editor/rail-layout";

test("a shortened name keeps the suffix that tells a test from its source", () => {
  assert.deepEqual(splitName("resolveCoachingCheckIn.test.ts"), [
    "resolveCoachingCheckIn",
    ".test.ts",
  ]);
  assert.deepEqual(splitName("resolveCoachingCheckIn.ts"), ["resolveCoachingCheckIn", ".ts"]);
  assert.deepEqual(splitName("journey.e2e.test.ts"), ["journey", ".e2e.test.ts"]);
  assert.deepEqual(splitName("Dockerfile"), ["Dockerfile", ""]);
  assert.deepEqual(splitName(".env"), [".env", ""]);
  assert.deepEqual(splitName("a.very.long.dotted.config.name.js"), [
    "a.very.long.dotted.config.name",
    ".js",
  ]);
  assert.deepEqual(splitPath("packages/a/b.ts"), ["packages/a/", "b.ts"]);
  assert.deepEqual(splitPath("b.ts"), ["", "b.ts"]);
});

test("the rail is never narrower than its minimum nor wider than half the tab", () => {
  assert.equal(clampWidth(50, 1200), RAIL_MIN_PX);
  assert.equal(clampWidth(400, 1200), 400);
  assert.equal(clampWidth(900, 1200), 600);
  assert.equal(clampWidth(900, 300), RAIL_MIN_PX, "a tiny tab still gets the minimum");
});

const tabWidth = (px: number) =>
  Object.defineProperty(document.documentElement, "clientWidth", { value: px, configurable: true });

test("the toggle hides and shows the rail, and the choice survives a reload", async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  try {
    tabWidth(1200);
    localStorage.clear();
    const layout = await import("../editor/rail-layout");
    layout.resetRailState();
    const button = layout.railToggle();
    document.body.append(button);
    layout.fitRail();
    const html = document.documentElement;
    assert.ok(html.classList.contains("w-rail"), "open by default on a wide tab");
    assert.equal(button.getAttribute("aria-expanded"), "true");
    button.click();
    assert.ok(!html.classList.contains("w-rail"));
    assert.equal(button.getAttribute("aria-expanded"), "false");
    layout.resetRailState();
    layout.fitRail();
    assert.ok(!html.classList.contains("w-rail"), "still hidden after a reload");
  } finally {
    await GlobalRegistrator.unregister();
  }
});

test("dragging the rail's edge resizes it within bounds and remembers the width", async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  try {
    tabWidth(1200);
    localStorage.clear();
    const layout = await import("../editor/rail-layout");
    layout.resetRailState();
    const nav = document.createElement("nav");
    const handle = layout.railResizer(nav);
    handle.setPointerCapture = () => undefined;
    nav.append(handle);
    document.body.append(nav);
    const html = document.documentElement;
    const at = (type: string, x: number) =>
      handle.dispatchEvent(new PointerEvent(type, { pointerId: 1, clientX: x, bubbles: true }));
    at("pointerdown", 290);
    at("pointermove", 420);
    assert.equal(html.style.getPropertyValue("--rail-w"), "420px");
    at("pointermove", 1100);
    assert.equal(html.style.getPropertyValue("--rail-w"), "600px", "at most half the tab");
    at("pointerup", 1100);
    assert.equal(JSON.parse(localStorage.getItem("review-desk:rail") ?? "{}").width, 600);
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    assert.equal(html.style.getPropertyValue("--rail-w"), "584px", "← narrows it a step");
  } finally {
    await GlobalRegistrator.unregister();
  }
});

test("a file header keeps Viewed in the row with its buttons, and the path on one line", async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  try {
    const { buildFrame } = await import("../editor/diff-frame");
    const frame = buildFrame({
      variant: "card",
      expanded: true,
      focused: false,
      reviewing: true,
      viewed: true,
      lead: [],
      tags: [],
    });
    const actions = frame.el.querySelector(".dv-actions");
    const names = Array.from(actions?.children ?? []).map((c) => c.textContent);
    assert.deepEqual(names, ["Viewed", "Comment on file", "Open in Orca"]);
    assert.ok(actions?.querySelector(".dv-viewed input.cbox"), "the box sits in the actions");
    assert.equal(frame.el.querySelector(".dv-name input"), null, "not beside the path any more");
  } finally {
    await GlobalRegistrator.unregister();
  }
});
