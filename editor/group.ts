// What a group's stacked file cards need besides the diff views: which files are tests (they start
// closed), opening a card once it scrolls near, and which card is on screen for the rail to mark.

const TEST_PATH = /(^|\/)(__tests__|e2e|test-e2e)\/|\.(test|spec|e2e)\.[^/]+$/;

/** Whether `path` is a test file by its name or folder. */
export const isTestPath = (path: string): boolean => TEST_PATH.test(path);

/** Runs `fn` once `el` comes within a screen or so of view; at once where that can't be seen. */
export function whenNear(el: Element, fn: () => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    fn();
    return () => undefined;
  }
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      fn();
    },
    { rootMargin: "800px 0px" },
  );
  io.observe(el);
  return () => io.disconnect();
}

/**
 * Tells `onCurrent` the path of the first card of `list` in the upper part of the screen, as the
 * reviewer scrolls; null when none is.
 */
export function spyOnCards(
  list: HTMLElement,
  onCurrent: (path: string | null) => void,
): () => void {
  if (typeof IntersectionObserver === "undefined") return () => undefined;
  const visible = new Set<Element>();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target);
        else visible.delete(e.target);
      }
      const first = Array.from(list.children).find((c) => visible.has(c));
      onCurrent(first instanceof HTMLElement ? (first.dataset.path ?? null) : null);
    },
    // Why the margins: the sticky top bar covers the top, and a card counts once it reaches the
    // upper part of the screen rather than its bottom edge.
    { rootMargin: "-80px 0px -45% 0px" },
  );
  Array.from(list.children).forEach((card) => io.observe(card));
  return () => io.disconnect();
}
