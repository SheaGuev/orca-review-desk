import { assert, test } from "orca/testing";
import { failureReason } from "./failure";

test("a failed run's error becomes a short reason a person can act on", () => {
  assert.equal(failureReason("claude exited with 1: rate limited"), "rate limited");
  assert.equal(failureReason("Claude Code: API Error: 429 Too Many Requests"), "rate limited");
  assert.equal(failureReason("Claude Code: Not logged in · Please run /login"), "not signed in");
  assert.equal(failureReason("codex exited with 1: 401 Unauthorized"), "not signed in");
  assert.equal(failureReason("claude took longer than 900 s"), "timed out");
  assert.equal(
    failureReason("The agent's guide did not match prguide v2: title: expected a string"),
    "didn't match the format",
  );
  assert.equal(failureReason("git diff failed: fatal: bad object"), "see logs");
  assert.equal(
    failureReason(
      "The agent's reply holds what looks like a GitHub token, so the guide was not stored.",
    ),
    "reply held a secret",
  );
  assert.equal(
    failureReason("The agent run changed .git/hooks/pre-commit in the clone. Nothing was stored"),
    "changed the clone's git files",
  );
  assert.equal(
    failureReason("Codex isn't installed: no codex on PATH · install it, then Generate"),
    "not installed",
  );
  assert.equal(failureReason(null), "see logs");
});
