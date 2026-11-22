// Credentials that must never leave the machine in a guide or a posted review. Pure: the worker
// checks an agent's reply before storing it, and a review before posting it.

const PATTERNS: [RegExp, string][] = [
  [/gh[pousr]_[A-Za-z0-9]{36,}/, "a GitHub token"],
  [/github_pat_\w{20,}/, "a GitHub token"],
  [/AKIA[0-9A-Z]{16}/, "an AWS access key"],
  [/xox[abprs]-[\w-]+/, "a Slack token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
];

/** What kind of secret `text` holds ("a GitHub token"), or null; never the secret itself. */
export function findSecret(text: string): string | null {
  return PATTERNS.find(([re]) => re.test(text))?.[1] ?? null;
}
