// Errors the worker answers a request with. Orca passes `code` on to the panel or the guide tab.

export type FailCode = "unavailable" | "invalid" | "conflict" | "cancelled";

/** An error carrying one of the codes a request can fail with. */
export const fail = (code: FailCode, text: string): Error =>
  Object.assign(new Error(text), { code });

export const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const COMMIT = /^[0-9a-f]{7,64}$/i;

export const isCommit = (v: unknown): v is string => typeof v === "string" && COMMIT.test(v);

/** A request's optional commit id: undefined when left out, `invalid` for anything else. */
export function optionalCommit(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (!isCommit(v)) throw fail("invalid", "Expected a commit id");
  return v;
}
