// Remembering answers that take a git or gh call to work out.

export type PromiseCache<T> = {
  /** The answer for `key`, worked out once; a failed one is forgotten so the next ask retries. */
  get(key: string, compute: () => Promise<T>): Promise<T>;
  clear(): void;
};

/** Answers by key, dropped all at once when a new key would take it past `limit`. */
export function promiseCache<T>(limit = Number.POSITIVE_INFINITY): PromiseCache<T> {
  const found = new Map<string, Promise<T>>();
  return {
    get(key, compute) {
      const known = found.get(key);
      if (known) return known;
      if (found.size >= limit) found.clear();
      const answer = compute();
      answer.catch(() => {
        if (found.get(key) === answer) found.delete(key);
      });
      found.set(key, answer);
      return answer;
    },
    clear: () => found.clear(),
  };
}

/**
 * `fn` over `items`, at most `limit` at a time, answers in the order of `items`. After the first
 * failure no further item is started, so a dead network costs `limit` calls, not one per item.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (next < items.length && !failed) {
      const i = next++;
      const item = items[i];
      if (item === undefined) continue;
      try {
        out[i] = await fn(item);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
