import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, assert, test } from "orca/testing";
import { onPath, run, setRunner, runOk } from "./exec";

afterEach(() => setRunner(null));

test("an env given to a run replaces the worker's environment instead of adding to it", async () => {
  process.env.PR_TOUR_TEST_SECRET = "leaked";
  try {
    const out = await run(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify(process.env))"],
      { env: { PATH: process.env.PATH ?? "", ONLY_THIS: "1" } },
    );
    const env = JSON.parse(out.stdout) as Record<string, string>;
    assert.equal(env.ONLY_THIS, "1");
    assert.equal(env.PR_TOUR_TEST_SECRET, undefined);
  } finally {
    delete process.env.PR_TOUR_TEST_SECRET;
  }
});

test("a binary is on PATH only as an executable file in one of its folders", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pr-tour-path-"));
  try {
    await writeFile(join(dir, "agent"), "#!/bin/sh\n");
    await chmod(join(dir, "agent"), 0o755);
    await writeFile(join(dir, "notes"), "");
    await chmod(join(dir, "notes"), 0o644);
    await mkdir(join(dir, "folder"));
    const path = ["/nowhere", dir].join(delimiter);
    assert.equal(await onPath("agent", path), true);
    assert.equal(await onPath("missing", path), false);
    assert.equal(await onPath("folder", path), false);
    if (process.platform !== "win32") assert.equal(await onPath("notes", path), false);
    assert.equal(await onPath("agent", ""), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed command's error keeps the line that says what went wrong", async () => {
  setRunner(async () => ({
    stdout: "",
    stderr: [
      "git@github.com: Permission denied (publickey).",
      "fatal: Could not read from remote repository.",
      "",
      "Please make sure you have the correct access rights",
      "and the repository exists.",
    ].join("\n"),
    code: 128,
  }));
  await assert.rejects(runOk("git", ["-C", "/repo", "fetch"]), /Permission denied \(publickey\)/);
  setRunner(null);
});
