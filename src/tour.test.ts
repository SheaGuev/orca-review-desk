import { assert, test } from "orca/testing";
import type { Stop } from "./schema";
import {
  filesCovered,
  freshTour,
  parseView,
  resumeStop,
  setCollapsed,
  showView,
  skipIndex,
  stopCount,
  stopLines,
  stopView,
  tourLabel,
  tourMinutes,
  tourState,
} from "./tour";

test("stored progress is kept for the same commit and cleaned up", () => {
  const stored = { commit: "abc", view: "stop:2", visited: [2, 0, 0, 9, -1, "x", 1.5] };
  assert.deepEqual(tourState(stored, "abc", 4), {
    commit: "abc",
    view: "stop:2",
    visited: [0, 2],
    collapsed: [],
    last: null,
  });
  // A stop that no longer exists falls back to the overview.
  assert.equal(tourState({ ...stored, view: "stop:7" }, "abc", 4).view, "overview");
  assert.equal(tourState({ ...stored, view: "wrapup" }, "abc", 4).view, "wrapup");
  assert.equal(tourState({ ...stored, view: "elsewhere" }, "abc", 4).view, "overview");
});

test("a new commit starts the tour again at the overview", () => {
  const stored = { commit: "abc", view: "stop:2", visited: [0, 1, 2] };
  assert.deepEqual(tourState(stored, "def", 4), freshTour("def"));
  assert.deepEqual(tourState(null, "def", 4), {
    commit: "def",
    view: "overview",
    visited: [],
    collapsed: [],
    last: null,
  });
  assert.deepEqual(tourState([1, 2], "def", 4), freshTour("def"));
});

test("showing a stop visits it; the overview and wrap-up do not", () => {
  let s = freshTour("abc");
  s = showView(s, "stop:1", 3);
  s = showView(s, "stop:0", 3);
  s = showView(s, "stop:1", 3);
  assert.deepEqual(s, { commit: "abc", view: "stop:1", visited: [0, 1], collapsed: [], last: 1 });
  s = showView(s, "wrapup", 3);
  assert.deepEqual(s.visited, [0, 1]);
  assert.equal(s.view, "wrapup");
  assert.deepEqual(parseView("stop:3", 3), { kind: "overview" });
  // Stored state is plain JSON: nothing undefined to refuse.
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});

test("collapsed files are remembered per stop, cleaned up, and reset with the tour", () => {
  let s = setCollapsed(freshTour("abc"), 2, true);
  s = setCollapsed(s, 0, true);
  s = setCollapsed(s, 2, true);
  assert.deepEqual(s.collapsed, [0, 2]);
  s = setCollapsed(s, 2, false);
  assert.deepEqual(s.collapsed, [0]);
  // Moving through the tour keeps them; the state stays plain JSON.
  s = showView(s, "stop:1", 3);
  assert.deepEqual(s.collapsed, [0]);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  // Stored values are cleaned like visited ones; state saved before collapsing existed loads open.
  const stored = { commit: "abc", view: "stop:1", visited: [1], collapsed: [2, 2, 7, "x", 0] };
  assert.deepEqual(tourState(stored, "abc", 3).collapsed, [0, 2]);
  assert.deepEqual(tourState({ ...stored, collapsed: undefined }, "abc", 3).collapsed, []);
  // A new commit (or Restart, which is a fresh tour) opens every file again.
  assert.deepEqual(tourState(stored, "def", 3).collapsed, []);
});

test("resume goes to the stop on screen, else the first one not seen", () => {
  assert.equal(resumeStop(freshTour("a"), 3), null);
  assert.equal(resumeStop({ ...freshTour("a"), view: "stop:2", visited: [2] }, 3), 2);
  assert.equal(resumeStop({ ...freshTour("a"), visited: [0, 2] }, 3), 1);
  assert.equal(resumeStop({ ...freshTour("a"), view: "wrapup", visited: [0, 1, 2] }, 3), 0);
});

/** Three stops (one a skim stop over three files) and two skipped files: 7 files in all. */
const SHAPE = {
  stops: [{ files: ["a.ts"] }, { files: ["b.ts", "c.ts", "d.ts"] }, { files: ["e.ts"] }],
  skipped: ["bun.lock", "gen.ts"],
};

test("the skipped files are the last stop, counted with the others", () => {
  assert.equal(stopCount(SHAPE), 4);
  assert.equal(skipIndex(SHAPE), 3);
  assert.equal(stopCount({ ...SHAPE, skipped: [] }), 3);
  assert.equal(skipIndex({ ...SHAPE, skipped: [] }), null);
});

test("progress counts files: a stop's files once it was shown, skipped ones with their stop", () => {
  assert.deepEqual(filesCovered([], SHAPE), { covered: 0, total: 7, skipped: 2 });
  assert.deepEqual(filesCovered([1], SHAPE), { covered: 3, total: 7, skipped: 2 });
  assert.deepEqual(filesCovered([0, 3], SHAPE), { covered: 3, total: 7, skipped: 2 });
  assert.deepEqual(filesCovered([0, 1, 2, 3], SHAPE), { covered: 7, total: 7, skipped: 2 });
  // Out-of-range indices (a state from a guide with more stops) count nothing.
  assert.deepEqual(filesCovered([9], SHAPE).covered, 0);
});

test("the queue label says how many files the tour covered, for this commit only", () => {
  assert.equal(tourLabel(null, "a", SHAPE), null);
  assert.equal(tourLabel({ commit: "a", view: "overview", visited: [] }, "a", SHAPE), null);
  assert.equal(
    tourLabel({ commit: "a", view: "stop:1", visited: [0, 1] }, "a", SHAPE),
    "4 of 7 files",
  );
  assert.equal(
    tourLabel({ commit: "a", view: "wrapup", visited: [0, 1, 2] }, "a", SHAPE),
    "5 of 7 files",
    "the skipped files' stop not shown yet",
  );
  assert.equal(
    tourLabel({ commit: "a", view: "wrapup", visited: [0, 1, 2, 3] }, "a", SHAPE),
    "Reviewed tour",
  );
  assert.equal(tourLabel({ commit: "a", view: "stop:1", visited: [0, 1] }, "b", SHAPE), null);
  assert.equal(
    tourLabel({ commit: "a", view: "overview", visited: [] }, "a", { stops: [], skipped: [] }),
    null,
  );
});

test("the estimate: deep stops by focused lines, skim stops add a minute per 5 more files, skipped files nothing", () => {
  const commentable: Record<string, [number, number][]> = {
    "a.ts": [
      [1, 50],
      [100, 129],
    ],
    "b.ts": [[1, 10]],
  };
  const stop = (over: Partial<Stop>): Stop => ({
    depth: "deep",
    files: ["a.ts"],
    why: "core",
    areaId: "x",
    headline: "h",
    ...over,
  });
  const focused = stop({ focus: [{ start: 41, end: 110 }] });
  const whole = stop({});
  // 41-50 and 100-110 are diff lines: 21 of them.
  assert.equal(stopLines(focused, commentable), 21);
  assert.equal(stopLines(whole, commentable), 80);
  assert.equal(stopLines(stop({ files: ["gone.ts"] }), commentable), 0);
  // (21/40 + 1) + (80/40 + 1) + (10/40 + 1) = 1.525 + 3 + 1.25 = 5.775 → 6
  assert.equal(
    tourMinutes({ readingOrder: [focused, whole, stop({ files: ["b.ts"] })], commentable }),
    6,
  );
  // A skim stop: its representative's lines (b.ts, 10) + 1, plus 10 more files / 5 = 3.25 → 4.
  const others = Array.from({ length: 10 }, (_, i) => `s${i}.ts`);
  assert.equal(
    tourMinutes({
      readingOrder: [stop({ depth: "skim", why: "repeated", files: ["b.ts", ...others] })],
      commentable,
    }),
    4,
  );
  assert.equal(tourMinutes({ readingOrder: [], commentable }), 0);
});

// Bug: after Restart (progress cleared, stop 1 shown) and Exit tour, the overview offered
// "Resume at stop 2" because Resume picked the first unseen stop, not where the reviewer left off.
test("Resume returns to the stop the reviewer left, including right after a restart", () => {
  const stops = 9;
  let s = freshTour("abc");
  s = showView(s, stopView(0), stops); // Restart opens stop 1
  s = showView(s, "overview", stops); // Exit tour
  assert.equal(resumeStop(s, stops), 0, "Resume at stop 1 after restarting");

  s = showView(s, stopView(1), stops);
  s = showView(s, stopView(2), stops);
  s = showView(s, stopView(1), stops); // went back a stop
  s = showView(s, "overview", stops);
  assert.equal(
    resumeStop(s, stops),
    1,
    "Resume where the reviewer left, not at the first unseen stop",
  );
});

test("a state stored before the last stop was tracked still loads and resumes at the first unseen stop", () => {
  const old = { commit: "abc", view: "overview", visited: [0, 1, 3], collapsed: [] };
  const s = tourState(old, "abc", 5);
  assert.equal(s.last, null);
  assert.equal(resumeStop(s, 5), 2);
  const five = { stops: [0, 1, 2, 3, 4].map((i) => ({ files: [`f${i}.ts`] })), skipped: [] };
  assert.equal(tourLabel(old, "abc", five), "3 of 5 files");
  // A stored last stop out of range (the guide has fewer stops now) is dropped the same way.
  assert.equal(tourState({ ...old, last: 7 }, "abc", 5).last, null);
  assert.equal(tourState({ ...old, last: 1 }, "abc", 5).last, 1);
  assert.equal(tourLabel({ ...old, last: 1 }, "abc", five), "3 of 5 files");
});
