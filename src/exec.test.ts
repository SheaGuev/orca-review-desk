import { afterEach, assert, test } from "orca/testing";
import { run, setRunner } from "./exec";

afterEach(() => setRunner(null));

test("an env given to a run replaces the worker's environment instead of adding to it", async () => {
  process.env.PR_TOUR_TEST_SECRET = "leaked";
  try {
    const out = await run(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify(process.env))"],
      { env: { PATH: process.env.PATH ?? "", ONLY_THIS: "1" } },
    );
    const env = JSON.parse(out.stdout) as Record<string, string>;
    assert.equal(env.ONLY_THIS, "1");
    assert.equal(env.PR_TOUR_TEST_SECRET, undefined);
  } finally {
    delete process.env.PR_TOUR_TEST_SECRET;
  }
});
