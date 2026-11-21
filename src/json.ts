// Reading JSON nobody has checked yet: `gh` output, the plugin's storage, requests from a frame.
// Pure and imports nothing, so the schema, the worker and the guide tab all share it.

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `v` when it is a string, else `fallback`. */
export const asString = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : fallback;

/** `v` when it is a finite number, else `fallback`. */
export const asNumber = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** `v` when it is a list, else an empty one. */
export const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** `v` when it is an object, else an empty one, so its fields read as missing. */
export const asObj = (v: unknown): Record<string, unknown> => (isObj(v) ? v : {});

/** `JSON.parse` typed as what it is: a value nobody has checked. */
export const parseJson = (text: string): unknown => JSON.parse(text);

/**
 * A plain-JSON copy: fields set to `undefined` are dropped, which Orca's storage refuses. The
 * value comes back as the type that went in, minus those fields.
 */
export function plainJson<T>(value: T): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a JSON round trip keeps the shape
  return JSON.parse(JSON.stringify(value)) as T;
}
