import { assert, test } from "orca/testing";
import {
  countOwnedFiles,
  isLockfileOnly,
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
