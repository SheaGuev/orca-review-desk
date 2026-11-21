import { assert, test } from "orca/testing";
import { mapLimit, promiseCache } from "./cache";

test("promiseCache works an answer out once, and again after it failed", async () => {
  const cache = promiseCache<number>();
  let runs = 0;
  const ok = () => Promise.resolve(++runs);
  assert.equal(await cache.get("a", ok), 1);
  assert.equal(await cache.get("a", ok), 1, "the second ask is the first answer");
  await assert.rejects(cache.get("b", () => Promise.reject(new Error("no"))));
  assert.equal(await cache.get("b", ok), 2, "a failure is not remembered");
});

test("promiseCache drops everything when it is full", async () => {
  const cache = promiseCache<string>(2);
  let runs = 0;
  const make = (v: string) => () => {
    runs++;
    return Promise.resolve(v);
  };
  await cache.get("a", make("a"));
  await cache.get("b", make("b"));
  await cache.get("c", make("c"));
  await cache.get("a", make("a"));
  assert.equal(runs, 4, "a was dropped when c went in");
});

test("mapLimit keeps the order and never runs more than the limit at once", async () => {
  let running = 0;
  let most = 0;
  const out = await mapLimit([30, 10, 20, 5], 2, async (ms) => {
    most = Math.max(most, ++running);
    await new Promise((r) => setTimeout(r, ms));
    running--;
    return ms * 2;
  });
  assert.deepEqual(out, [60, 20, 40, 10]);
  assert.equal(most, 2);
});

test("mapLimit starts nothing more once a call has failed", async () => {
  let started = 0;
  await assert.rejects(
    mapLimit([1, 2, 3, 4, 5, 6], 2, async () => {
      started++;
      await new Promise((r) => setTimeout(r, 5));
      throw new Error("offline");
    }),
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(started, 2, "only the calls already under way");
});
