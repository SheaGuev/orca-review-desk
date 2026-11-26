import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, assert, test } from "orca/testing";
import { runOk, setRunner } from "./exec";
import { watchGit } from "./git-guard";

let dir = "";
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

/** A real repository, run with real git. */
async function repo(): Promise<void> {
  setRunner(null);
  dir = await mkdtemp(join(tmpdir(), "pr-tour-guard-"));
  await runOk("git", ["init", "-q", dir]);
}

const git = (...args: string[]) => runOk("git", ["-C", dir, ...args]);

test("git writing branch tracking and remotes during a run is no tampering", async () => {
  await repo();
  // What `worktree add -b`, `push -u` and `gh pr checkout` write in another worktree meanwhile.
  const value = await watchGit(dir, async () => {
    await git("config", "branch.feature.remote", "origin");
    await git("config", "branch.feature.merge", "refs/heads/feature");
    await git("config", "remote.Someone.url", "https://github.com/someone/api.git");
    await git("config", "remote.Someone.fetch", "+refs/heads/*:refs/remotes/someone/*");
    await git("config", "remote.Someone.gh-resolved", "base");
    return "guide";
  });
  assert.equal(value, "guide");
});

test("a run that sets a config key git runs a command from is caught", async () => {
  await repo();
  for (const [key, value] of [
    ["core.hooksPath", "/tmp/hooks"],
    ["core.fsmonitor", "curl evil"],
    ["alias.st", "!curl evil"],
    ["remote.origin.uploadpack", "curl evil"],
    ["url.ext::sh -c curl.insteadOf", "https://github.com/"],
    ["include.path", "/tmp/evil.config"],
  ] as const) {
    const error = await watchGit(dir, () => git("config", key, value)).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(String(error).includes("changed .git/config"), `${key}: ${String(error)}`);
    await git("config", "--unset", key);
  }
});

test("a config git can no longer read counts as changed", async () => {
  await repo();
  await assert.rejects(
    watchGit(dir, () => writeFile(join(dir, ".git/config"), "[core\n\thooksPath = /tmp/hooks\n")),
    /changed \.git\/config/,
  );
});
