// A failed guide run in the panel: the worker keeps the full error (often a long agent or gh
// message), the row shows a short reason a person can act on. Pure and tested.

const REASONS: [RegExp, string][] = [
  // write-guide.ts and git-guard.ts: refusals that protect the person, checked first.
  [/^The agent run changed .* in the clone/, "changed the clone's git files"],
  [/^The agent's reply holds what looks like/, "reply held a secret"],
  [/rate.?limit|\b429\b|too many requests|overloaded|usage limit/i, "rate limited"],
  [
    /not logged in|log ?in required|please (run )?\/?login|not signed in|invalid api key|authenticat|unauthori[sz]ed|\b401\b/i,
    "not signed in",
  ],
  // exec.ts says "<cmd> took longer than N s" when it stops a run.
  [/took longer than|timed? ?out|ETIMEDOUT/i, "timed out"],
  [
    /did not match prguide|not valid JSON|unexpected token|didn['’]t match/i,
    "didn't match the format",
  ],
];

/** "rate limited", "not signed in", "timed out", "didn't match the format", a refusal, else "see logs". */
export function failureReason(error: string | null | undefined): string {
  if (!error) return "see logs";
  return REASONS.find(([re]) => re.test(error))?.[1] ?? "see logs";
}
