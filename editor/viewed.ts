// GitHub's Viewed checkbox per file, shared by every diff view in the tab. A tick shows at once
// and is sent to GitHub; if GitHub refuses it, the box goes back and the tab says why.
import { message } from "../src/errors";

export type Viewed = {
  /** Whether `path` is ticked on GitHub; null until read, or when it couldn't be read. */
  has: (path: string) => boolean | null;
  set: (path: string, on: boolean) => void;
  /** Called after any change, including the first read; returns the unsubscribe. */
  onChange: (listener: () => void) => () => void;
};

export type ViewedIo = {
  load: () => Promise<readonly string[]>;
  save: (path: string, on: boolean) => Promise<unknown>;
  say: (text: string) => void;
};

export function createViewed(io: ViewedIo): Viewed {
  let known: Set<string> | null = null;
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((l) => l());
  // A refusal only rolls back the latest press on that file, never one made after it.
  const presses = new Map<string, number>();
  const mark = (path: string, on: boolean) => {
    if (on) known?.add(path);
    else known?.delete(path);
    changed();
  };
  const read = async () => {
    try {
      known = new Set(await io.load());
      changed();
    } catch (e) {
      io.say(`Couldn’t read which files you’ve viewed: ${message(e)}`);
    }
  };
  void read();
  return {
    has: (path) => (known ? known.has(path) : null),
    set: (path, on) => {
      if (!known || known.has(path) === on) return;
      const press = (presses.get(path) ?? 0) + 1;
      presses.set(path, press);
      mark(path, on);
      io.save(path, on).catch((e: unknown) => {
        if (presses.get(path) !== press) return;
        mark(path, !on);
        io.say(`Couldn’t mark ${path} as ${on ? "viewed" : "not viewed"}: ${message(e)}`);
      });
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
