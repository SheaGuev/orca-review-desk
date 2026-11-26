// Where an import points at the PR's commit: relative paths with Node's and TypeScript's
// extension and index rules, the repo's own workspace packages by name, and nothing else.
import { assert, test } from "orca/testing";
import {
  normalize,
  packageFiles,
  packagePart,
  resolveImport,
  workspacePackage,
  type RepoIndex,
} from "./import-resolve";

const FILES = [
  "package.json",
  "packages/rb-data-models/package.json",
  "packages/rb-data-models/src/models/cci/helpers/resolveCoachingCheckIn.ts",
  "packages/rb-data-models/src/models/cci/helpers/getCoachingCheckInOutcome.ts",
  "packages/rb-data-models/src/index.ts",
  "packages/ui/package.json",
  "packages/ui/dist/main.js",
  "packages/ui/src/Button/index.tsx",
  "packages/scoped/package.json",
  "packages/scoped/lib/entry.ts",
  "packages/plain/package.json",
  "packages/plain/index.ts",
  "services/app/src/mutations/updateHoliday.ts",
  "services/app/src/util.js",
  "services/app/src/data.json",
  "node_modules/lodash/package.json",
];

const index: RepoIndex = {
  files: new Set(FILES),
  packages: [
    { dir: "", name: "rb-root", entries: [] },
    { dir: "packages/rb-data-models", name: "rb-data-models", entries: [] },
    { dir: "packages/ui", name: "ui", entries: ["dist/main.js"] },
    { dir: "packages/scoped", name: "@acme/scoped", entries: ["./lib/entry.ts"] },
    { dir: "packages/plain", name: "plain", entries: [] },
  ],
};
const from = "services/app/src/mutations/updateHoliday.ts";
const helpers = "packages/rb-data-models/src/models/cci/helpers/resolveCoachingCheckIn.ts";

test("a relative import finds the file with an extension, an index or a JS name for TS", () => {
  assert.deepEqual(resolveImport(index, helpers, "./getCoachingCheckInOutcome"), {
    path: "packages/rb-data-models/src/models/cci/helpers/getCoachingCheckInOutcome.ts",
  });
  assert.deepEqual(resolveImport(index, from, "../util"), { path: "services/app/src/util.js" });
  assert.deepEqual(resolveImport(index, from, "../data.json"), {
    path: "services/app/src/data.json",
  });
  assert.deepEqual(resolveImport(index, helpers, "./getCoachingCheckInOutcome.js"), {
    path: "packages/rb-data-models/src/models/cci/helpers/getCoachingCheckInOutcome.ts",
  });
  assert.deepEqual(resolveImport(index, "packages/ui/src/App.tsx", "./Button"), {
    path: "packages/ui/src/Button/index.tsx",
  });
});

test("a workspace package resolves by name, with a subpath, its entry or its index", () => {
  assert.deepEqual(
    resolveImport(index, from, "rb-data-models/src/models/cci/helpers/resolveCoachingCheckIn"),
    { path: helpers },
  );
  assert.deepEqual(resolveImport(index, from, "plain"), { path: "packages/plain/index.ts" });
  assert.deepEqual(
    resolveImport(index, from, "rb-data-models"),
    { reason: "not-found" },
    "no entry point and no index at the package's root",
  );
  assert.deepEqual(resolveImport(index, from, "ui"), { path: "packages/ui/dist/main.js" });
  assert.deepEqual(resolveImport(index, from, "@acme/scoped"), {
    path: "packages/scoped/lib/entry.ts",
  });
});

test("a package from node_modules is external; a missing file is not found", () => {
  assert.deepEqual(resolveImport(index, from, "lodash"), { reason: "external" });
  assert.deepEqual(resolveImport(index, from, "@aws-sdk/client-dynamodb"), { reason: "external" });
  assert.deepEqual(resolveImport(index, from, "node:fs"), { reason: "external" });
  assert.deepEqual(resolveImport(index, from, "./nope"), { reason: "not-found" });
  assert.deepEqual(resolveImport(index, from, "rb-data-models/src/nope"), {
    reason: "not-found",
  });
  assert.deepEqual(resolveImport(index, "a.ts", "../../outside"), { reason: "not-found" });
});

test("package names split from their subpath; paths normalize without leaving the repo", () => {
  assert.deepEqual(packagePart("@acme/scoped/lib/x"), { name: "@acme/scoped", sub: "lib/x" });
  assert.deepEqual(packagePart("ui"), { name: "ui", sub: "" });
  assert.equal(normalize("a/./b/../c"), "a/c");
  assert.equal(normalize("../a"), null);
});

test("package.json files become packages with their entries; node_modules is never read", () => {
  assert.deepEqual(packageFiles(FILES), [
    "package.json",
    "packages/rb-data-models/package.json",
    "packages/ui/package.json",
    "packages/scoped/package.json",
    "packages/plain/package.json",
  ]);
  assert.deepEqual(
    workspacePackage("packages/ui/package.json", {
      name: "ui",
      main: "dist/main.js",
      types: "dist/index.d.ts",
      exports: { ".": { import: "./dist/esm.js", default: "./dist/main.js" } },
    }),
    {
      dir: "packages/ui",
      name: "ui",
      entries: ["dist/index.d.ts", "dist/main.js", "./dist/esm.js", "./dist/main.js"],
    },
  );
  assert.equal(workspacePackage("package.json", { private: true }), null, "no name, no package");
  assert.equal(workspacePackage("package.json", "not json"), null);
});
