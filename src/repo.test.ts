import { assert, test } from "orca/testing";
import {
  countOwnedFiles,
  githubHost,
  isLockfileOnly,
  lockfileSource,
  ownersOf,
  parseCodeowners,
  parseTeams,
  repoSlugFromApiUrl,
  repoSlugFromRemote,
} from "./repo";

test("reads owner/repo from ssh and https remotes", () => {
  assert.equal(repoSlugFromRemote("git@github.com:Acme/API.git\n"), "acme/api");
  assert.equal(repoSlugFromRemote("https://github.com/acme/web-app"), "acme/web-app");
  assert.equal(repoSlugFromRemote("ssh://git@github.com/acme/web.app.git"), "acme/web.app");
  assert.equal(repoSlugFromRemote("https://gitlab.com/acme/api.git"), null);
  assert.equal(repoSlugFromApiUrl("https://api.github.com/repos/Acme/Api"), "acme/api");
});

test("reads the GitHub host from a remote, github.com when it names none", () => {
  assert.equal(githubHost("git@github.com:acme/api.git\n"), "github.com");
  assert.equal(githubHost("git@GHE.Example.com:acme/api.git"), "ghe.example.com");
  assert.equal(githubHost("ssh://git@ghe.example.com:2222/acme/api"), "ghe.example.com");
  assert.equal(githubHost("https://ghe.example.com/acme/api.git"), "ghe.example.com");
  assert.equal(githubHost("https://user@ghe.example.com/acme/api.git"), "ghe.example.com");
  assert.equal(githubHost("ssh://git@ssh.github.com:443/acme/api.git"), "github.com");
  assert.equal(githubHost("git@github-work:acme/api.git"), "github.com");
  assert.equal(githubHost(""), "github.com");
});

test("spots lockfile-only changes", () => {
  assert.equal(isLockfileOnly(["pnpm-lock.yaml", "apps/web/package-lock.json"]), true);
  assert.equal(isLockfileOnly(["pnpm-lock.yaml", "package.json"]), false);
  assert.equal(isLockfileOnly([]), false);
});

test("matches CODEOWNERS like GitHub: last rule wins, anchors and globs", () => {
  const rules = parseCodeowners(
    [
      "# comment",
      "*            @acme/everyone",
      "/src/auth/   @acme/identity",
      "docs/**/*.md @acme/docs",
      "*.sql        @acme/data # trailing",
    ].join("\n"),
  );
  assert.deepEqual(ownersOf(rules, "src/auth/session.ts"), ["@acme/identity"]);
  assert.deepEqual(ownersOf(rules, "lib/src/auth/x.ts"), ["@acme/everyone"]);
  assert.deepEqual(ownersOf(rules, "docs/guide/intro.md"), ["@acme/docs"]);
  assert.deepEqual(ownersOf(rules, "db/migrations/1.sql"), ["@acme/data"]);
  assert.equal(
    countOwnedFiles(rules, ["src/auth/a.ts", "src/auth/b.ts", "README.md"], ["acme/identity"]),
    2,
  );
  assert.equal(countOwnedFiles(rules, ["src/auth/a.ts"], ["@ACME/Identity"]), 1);
});

test("parses the teams setting", () => {
  assert.deepEqual(parseTeams(" acme/payments, @acme/identity  bad nope/ "), [
    "acme/payments",
    "acme/identity",
  ]);
  assert.deepEqual(parseTeams(undefined), []);
});

test("a lockfile's source is the changed manifest it follows, the nearest one first", () => {
  const changed = ["apps/web/package.json", "package.json", "Cargo.toml", "src/a.ts"];
  assert.equal(lockfileSource("bun.lock", changed), "package.json");
  assert.equal(lockfileSource("apps/web/package-lock.json", changed), "apps/web/package.json");
  assert.equal(lockfileSource("Cargo.lock", changed), "Cargo.toml");
  assert.equal(
    lockfileSource("libs/x/yarn.lock", changed),
    "apps/web/package.json",
    "no manifest beside it: any changed one of its kind",
  );
  assert.equal(lockfileSource("go.sum", changed), null, "its manifest did not change");
  assert.equal(lockfileSource("src/a.ts", changed), null, "not a lockfile");
});
