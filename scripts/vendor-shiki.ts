/// <reference types="bun" />
// Rebuilds editor/vendor/shiki/ from the installed shiki package. Run after changing its version
// or the grammar list in scripts/shiki/entry.ts:
//
//   bun scripts/vendor-shiki.ts
import { rm } from "node:fs/promises";

const outdir = new URL("../editor/vendor/shiki/", import.meta.url).pathname;
await rm(outdir, { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: [new URL("./shiki/entry.ts", import.meta.url).pathname],
  outdir,
  format: "esm",
  splitting: true,
  minify: true,
  target: "browser",
  naming: { entry: "shiki.js", chunk: "[name]-[hash].js" },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
for (const out of result.outputs)
  console.log(`${(out.size / 1024).toFixed(0)} KiB  ${out.path.slice(outdir.length)}`);
