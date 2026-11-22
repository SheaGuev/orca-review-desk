import { assert, test } from "orca/testing";
import { findSecret } from "./secrets";

test("names the kind of secret a text holds, never the secret itself", () => {
  const cases: [string, string][] = [
    [`token ghp_${"a".repeat(36)} here`, "a GitHub token"],
    [`gho_${"B1".repeat(18)}`, "a GitHub token"],
    [`github_pat_${"x".repeat(22)}`, "a GitHub token"],
    ["AKIAABCDEFGHIJKLMNOP", "an AWS access key"],
    ["xoxb-123-456-abc", "a Slack token"],
    ["-----BEGIN RSA PRIVATE KEY-----", "a private key"],
    ["-----BEGIN PRIVATE KEY-----", "a private key"],
  ];
  for (const [text, kind] of cases) assert.equal(findSecret(text), kind, text);
});

test("ordinary text and near misses are not secrets", () => {
  for (const text of [
    "Uses GH_TOKEN from the environment",
    `ghp_${"a".repeat(20)}`,
    "AKIA lowercase akiaabcdefghijklmnop",
    "-----BEGIN PUBLIC KEY-----",
    "",
  ])
    assert.equal(findSecret(text), null, text);
});

test("a secret-shaped string the PR itself contains is not a leak", () => {
  const fixture = "AKIAABCDEFGHIJKLMNOP";
  const pr = `+const key = "${fixture}"; // a test fixture`;
  assert.equal(findSecret(`The test uses ${fixture}.`, pr), null);
  // Anything not in the PR is still caught, even beside a string that is.
  const leaked = `ghp_${"z9".repeat(18)}`;
  assert.equal(findSecret(`${fixture} and ${leaked}`, pr), "a GitHub token");
  assert.equal(findSecret(`The test uses ${fixture}.`, "unrelated text"), "an AWS access key");
  assert.equal(findSecret(`The test uses ${fixture}.`), "an AWS access key");
});
