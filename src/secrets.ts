// Credentials that must never leave the machine in a guide or a posted review. Pure: the worker
// checks an agent's reply before storing it, and a review before posting it.

const PATTERNS: [RegExp, string][] = [
  [/gh[pousr]_[A-Za-z0-9]{36,}/g, "a GitHub token"],
  [/github_pat_\w{20,}/g, "a GitHub token"],
  [/AKIA[0-9A-Z]{16}/g, "an AWS access key"],
  [/xox[abprs]-[\w-]+/g, "a Slack token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "a private key"],
];

/**
 * What kind of secret `text` holds ("a GitHub token"), or null; never the secret itself. A match
 * found word for word in `known` (the PR's own diff and description, already public on GitHub)
 * leaks nothing and is passed over.
 */
export function findSecret(text: string, known?: string): string | null {
  for (const [re, kind] of PATTERNS)
    for (const [match] of text.matchAll(re)) if (!known?.includes(match)) return kind;
  return null;
}
