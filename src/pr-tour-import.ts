// Guides PR Tour wrote, before this plugin was made from it. Read and never changed (PR Tour may
// still be installed and using them), and taken into this plugin's storage the first time a PR
// with no guide of its own is opened.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Clones } from "./clones";
import { parsePrKey } from "./repo";
import { isRealFolder } from "./run-files";
import { parseGuide, SCHEMA_ID } from "./schema";
import type { Store, StoredGuide } from "./store";

/** Where PR Tour wrote a PR's guide, newest layout first, as folders and the file name. */
const LOCATIONS = (pr: number): { folders: string[]; file: string }[] => [
  { folders: [".orca", ".orca/pr-tour"], file: `pr-${pr}.prtour.json` },
  { folders: [".pr-tour"], file: `pr-${pr}.prtour.json` },
  { folders: [".pr-tour"], file: `${pr}.prtour.json` },
];

/** The file's JSON, or null when it is missing, unreadable, or behind a link. */
async function readJson(cwd: string, folders: string[], file: string): Promise<unknown> {
  for (const folder of folders) if (!(await isRealFolder(cwd, folder))) return null;
  const text = await readFile(join(cwd, folders.at(-1) ?? "", file), "utf8").catch(() => null);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return null;
  }
}

/** PR Tour's guide of the PR `key` names, stored as this plugin's own; null when there is none. */
export async function importPrTourGuide(
  store: Store,
  clones: Pick<Clones, "find">,
  key: string,
): Promise<StoredGuide | null> {
  const pr = parsePrKey(key);
  const clone = pr ? await clones.find(pr.repo) : null;
  if (!pr || !clone) return null;
  for (const { folders, file } of LOCATIONS(pr.number)) {
    const parsed = parseGuide(await readJson(clone.path, folders, file));
    if (!parsed.ok || parsed.guide.schema !== SCHEMA_ID) continue;
    if (parsed.guide.pr.repo !== pr.repo || parsed.guide.pr.number !== pr.number) continue;
    await store.setGuide(key, parsed.guide);
    return store.guide(key);
  }
  return null;
}
