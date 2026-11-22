// Runs the real worker against a mock Orca host, with git, gh and the agent CLI faked.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, assert, mockHost, mountWorker, test } from "orca/testing";
import { setRunner, type RunOptions } from "./exec";
import { AGENT_GUIDE, DIFF, PR_VIEW, nth } from "./fixtures";
import type { QueueState } from "./protocol";
import * as main from "./worker";
import type { Draft } from "./review";
import { localDay } from "./store";
import type { TourState } from "./tour";

type Call = { cmd: string; args: string[]; options?: RunOptions };

/** `git diff --numstat -z` of the PR: the four guide files, then ones the guide leaves out. */
const NUMSTAT = [
  "2\t1\tsrc/SessionDataAccess.ts",
  "1\t1\t",
  "src/Old.ts",
  "src/CustomerService.ts",
  "1\t0\tsrc/SessionDataAccess.test.ts",
  "1\t0\tREADME.md",
  "12\t0\tdb/migrations/0002_reason.sql",
  "40\t3\tpnpm-lock.yaml",
  "-\t-\tassets/logo.png",
  "",
].join("\0");

function fakeTools(opts: {
  agentReplies: string[];
  reviewRequested?: boolean;
  /** Claude events printed before the result, such as tool calls. */
  agentEvents?: unknown[];
  /** PR numbers the review-request search finds; #7 alone by default. */
  numbers?: number[];
  /** Review-request time per PR number, as GitHub's timeline would report it. */
  requested?: Record<number, string>;
  /** The PR's author; "me" makes it your own PR. */
  author?: string;
  /** File-comment paths GitHub refuses. */
  refuseFileComments?: string[];
  /** Whether the clone has the PR's commits; a fetch brings them. Present when left out. */
  objects?: { present: boolean };
  /** The repo's .orca/diff-breakdown.json at the PR head; none when left out. */
  overrides?: string;
  /** The agent CLI answers only once this settles, so a test can act while a run is under way. */
  agentGate?: Promise<void>;
  /** GitHub's author_association for every PR; null makes the call fail. MEMBER when left out. */
  association?: string | null;
  /** What the agent CLI does before it answers, such as writing into the clone. */
  agentDoes?: () => Promise<void>;
  /** Which binaries are on PATH; all of them when left out. */
  installed?: (cmd: string) => boolean;
  /** Every gh call fails with GitHub's rate limit. */
  ghDown?: boolean;
  /** The PR's diff; DIFF when left out. */
  diff?: string;
  /** Each PR's updated_at in search results, by number; a test may change it between checks. */
  updatedAt?: Record<number, string>;
  /** While on, every gh call but rate_limit fails with the rate limit; `reset` is epoch seconds. */
  limit?: { on: boolean; reset: number };
  /** gh calls answer after a short delay, and the most in flight at once is recorded. */
  inFlight?: { now: number; max: number };
}) {
  const calls: Call[] = [];
  const replies = [...opts.agentReplies];
  setRunner(async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const ok = (stdout: string) => ({ stdout, stderr: "", code: 0 });
    if (cmd === "gh" && opts.inFlight) {
      const f = opts.inFlight;
      f.now++;
      f.max = Math.max(f.max, f.now);
      await new Promise((r) => setTimeout(r, 15));
      f.now--;
    }
    if (cmd === "gh" && args[0] === "api" && args[1] === "rate_limit") {
      const reset = opts.limit?.reset ?? 0;
      return ok(
        JSON.stringify({
          resources: { core: { reset }, graphql: { reset }, search: { reset } },
        }),
      );
    }
    if (cmd === "gh" && opts.limit?.on)
      return {
        stdout: "",
        stderr: "gh: API rate limit exceeded for user ID 1. (HTTP 403)",
        code: 1,
      };
    if (cmd === "gh" && opts.ghDown)
      return {
        stdout: "",
        stderr: "gh: API rate limit exceeded for user ID 1. (HTTP 403)",
        code: 1,
      };
    if (cmd === "git" && args.includes("get-url")) return ok("git@github.com:old-owner/api.git\n");
    if (cmd === "git" && args.includes("--git-common-dir")) return ok(".git\n");
    if (cmd === "git" && args.includes("fetch") && opts.objects) opts.objects.present = true;
    // The PR's version of each file asked for, one per input line.
    if (cmd === "git" && args.includes("--batch"))
      return ok(
        (options?.input ?? "")
          .split("\n")
          .filter(Boolean)
          .map((spec) => {
            const blob = `PR version of ${spec.slice(spec.indexOf(":") + 1)}\n`;
            return `${"b".repeat(40)} blob ${blob.length}\n${blob}\n`;
          })
          .join(""),
      );
    if (cmd === "git" && args.includes("cat-file") && opts.objects?.present === false)
      return { stdout: "", stderr: "fatal: Not a valid object name", code: 128 };
    if (cmd === "git" && args.includes("--name-status"))
      return ok(
        "M\0src/SessionDataAccess.ts\0R090\0src/Old.ts\0src/CustomerService.ts\0A\0db/migrations/0002_reason.sql\0",
      );
    if (cmd === "git" && args.includes("--numstat")) return ok(NUMSTAT);
    if (cmd === "git" && args.includes("ls-tree")) return ok("package.json\0src/index.ts\0");
    if (
      cmd === "git" &&
      args.includes("show") &&
      args.at(-1)?.endsWith(":.orca/diff-breakdown.json")
    )
      return opts.overrides === undefined
        ? { stdout: "", stderr: "fatal: path does not exist", code: 128 }
        : ok(opts.overrides);
    if (cmd === "git" && args.includes("check-attr"))
      return ok("assets/logo.png\0linguist-generated\0set\0");
    if (cmd === "git" && args.includes("diff")) return ok(opts.diff ?? DIFF);
    if (cmd === "git") return ok("");
    if (cmd === "gh" && args[0] === "api" && args.includes("search/issues")) {
      const q = args.find((a) => a.startsWith("q=")) ?? "";
      const hits = (opts.numbers ?? [7]).map((number) => ({
        number,
        title: PR_VIEW.title,
        html_url: PR_VIEW.url,
        draft: false,
        updated_at: opts.updatedAt?.[number] ?? "2026-11-19T00:00:00Z",
        user: { login: "sam" },
        repository_url: "https://api.github.com/repos/acme/api",
        // GitHub's search results carry it; null leaves it out, as an older answer would.
        ...(opts.association === null ? {} : { author_association: opts.association ?? "MEMBER" }),
      }));
      return ok(
        JSON.stringify({
          items: q.includes("user-review-requested") && opts.reviewRequested !== false ? hits : [],
        }),
      );
    }
    if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
      const number = Number(args[2]);
      return ok(
        JSON.stringify(
          number === 7
            ? { ...PR_VIEW, author: { login: opts.author ?? "sam" } }
            : { ...PR_VIEW, number, headRefOid: `head${number}`, url: `${PR_VIEW.url}/${number}` },
        ),
      );
    }
    if (cmd === "gh" && args[0] === "api" && args[1] === "user") return ok("me\n");
    if (
      cmd === "gh" &&
      args[0] === "api" &&
      /^repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(args[1] ?? "")
    ) {
      const association = opts.association === undefined ? "MEMBER" : opts.association;
      return association === null
        ? { stdout: "", stderr: "gh: Not Found (HTTP 404)", code: 1 }
        : ok(`${association}\n`);
    }
    if (cmd === "gh" && args[0] === "api" && args.includes("POST")) {
      const path = args[args.indexOf("POST") + 1];
      if (path?.endsWith("/reviews"))
        return ok(JSON.stringify({ html_url: "https://github.com/acme/api/pull/7#review-1" }));
      const body = JSON.parse(options?.input ?? "{}") as { path?: string };
      if (opts.refuseFileComments?.includes(body.path ?? ""))
        return { stdout: "", stderr: "gh: Validation Failed (HTTP 422)", code: 1 };
      return ok("{}");
    }
    if (cmd === "gh" && args[0] === "api" && args[1] === "graphql") {
      const repository: Record<string, unknown> = {};
      for (const [n, at] of Object.entries(opts.requested ?? {}))
        repository[`pr${n}`] = {
          createdAt: "2026-11-01T00:00:00Z",
          timelineItems: {
            nodes: [
              {
                __typename: "ReviewRequestedEvent",
                createdAt: at,
                requestedReviewer: { __typename: "User", login: "me" },
              },
              {
                __typename: "ReviewRequestedEvent",
                createdAt: "2026-11-19T09:00:00Z",
                requestedReviewer: { __typename: "User", login: "someone-else" },
              },
            ],
          },
        };
      return ok(JSON.stringify({ data: { repository } }));
    }
    // The clone's remote names the repo's old owner; GitHub says where it lives now.
    if (cmd === "gh" && args[0] === "repo" && args[1] === "view")
      return ok(args[2] === "old-owner/api" ? "acme/api\n" : `${args[2]}\n`);
    if (cmd === "claude") await opts.agentGate;
    if (cmd === "claude") await opts.agentDoes?.();
    if (cmd === "claude")
      return ok(
        JSON.stringify([
          { type: "system", subtype: "init" },
          ...(opts.agentEvents ?? []),
          replies[0] === "NOT_LOGGED_IN"
            ? { type: "result", is_error: true, result: "Not logged in · Please run /login" }
            : { type: "result", is_error: false, result: replies.shift() ?? "" },
        ]),
      );
    return { stdout: "", stderr: `unexpected ${cmd} ${args.join(" ")}`, code: 1 };
  }, opts.installed);
  return calls;
}

let current: { logs: readonly string[]; deactivate(): Promise<void> } | null = null;

async function until(fn: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}; worker logs:\n${current?.logs.join("\n") ?? ""}`);
}

const SETTINGS = {
  harness: "claude",
  model: "claude-opus-5-5",
  autoRequested: true,
  teams: "",
  includeAuthored: false,
  dailyLimit: 20,
  skipDrafts: true,
};

/** The `pr` block of a stored guide for PR #7 at its head; a stored guide must pass `checkGuide`. */
const STORED_PR = {
  repo: "acme/api",
  number: 7,
  url: PR_VIEW.url,
  author: "sam",
  commit: PR_VIEW.headRefOid,
  baseRef: "main",
  headRef: PR_VIEW.headRefName,
  additions: 120,
  deletions: 30,
  fileCount: 4,
};

let dir = "";
afterEach(async () => {
  await current?.deactivate();
  current = null;
  setRunner(null);
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function setup(
  agentReplies: string[],
  storage: Record<string, unknown> = {},
  agentEvents?: unknown[],
  more: {
    numbers?: number[];
    requested?: Record<number, string>;
    author?: string;
    refuseFileComments?: string[];
    objects?: { present: boolean };
    overrides?: string;
    agentGate?: Promise<void>;
    association?: string | null;
    agentDoes?: () => Promise<void>;
    installed?: (cmd: string) => boolean;
    /** Runs on the clone's folder before the worker starts. */
    before?: (dir: string) => Promise<void>;
    ghDown?: boolean;
    diff?: string;
    updatedAt?: Record<number, string>;
    limit?: { on: boolean; reset: number };
    inFlight?: { now: number; max: number };
  } = {},
) {
  dir = await mkdtemp(join(tmpdir(), "prguide-test-"));
  await more.before?.(dir);
  const calls = fakeTools({ agentReplies, agentEvents, ...more });
  const host = mockHost({
    settings: SETTINGS,
    storage: storage as never,
    results: {
      "project.list": {
        projects: [{ id: "p1", name: "api", kind: "git", hostId: "local", path: dir }],
        truncated: false,
      },
      "workspace.list": {
        workspaces: [
          {
            id: "w1",
            kind: "worktree",
            name: "api",
            projectId: "p1",
            path: dir,
            branch: "main",
            hostId: "local",
          },
        ],
        truncated: false,
      },
      "workspace.open": { opened: true },
      "editor.open": { opened: true },
      "statusBar.update": { ok: true },
      "notifications.show": { delivered: true },
    },
  });
  const worker = await mountWorker(main, { host });
  current = worker;
  const latest = () =>
    [...worker.posts].reverse().find((p) => p.event === "queue.changed")?.payload as
      | QueueState
      | undefined;
  const all = () => {
    const s = latest();
    return s ? [...s.queue, ...s.notQueued, ...s.authored] : [];
  };
  return { host, worker, calls, latest, all };
}

test("lists a requested review and waits for the repository to be turned on", async () => {
  const { calls, latest } = await setup([JSON.stringify(AGENT_GUIDE)]);
  await until(() => latest()?.checkedAt != null && latest()?.checking === false, "the first check");
  const state = latest() as QueueState;
  assert.equal(state.queue.length, 0, "no guide coming, so not in the queue");
  assert.equal(state.notQueued.length, 1);
  assert.equal(state.notQueued[0]?.key, "acme/api#7");
  assert.equal(state.notQueued[0]?.status, "none");
  assert.equal(state.notQueued[0]?.manualReason, "Repository not turned on yet");
  assert.equal(state.notQueued[0]?.repoLabel, "api");
  assert.deepEqual(state.repos, [{ repo: "acme/api", optIn: null, hasClone: true, pending: 1 }]);
  assert.equal(calls.filter((c) => c.cmd === "claude").length, 0, "no agent run before opt-in");
});

test("turning a repository on writes the guide with worker-filled facts", async () => {
  const { host, worker, calls, latest, all } = await setup([JSON.stringify(AGENT_GUIDE)]);
  await until(() => latest()?.checkedAt != null && latest()?.checking === false, "the first check");
  await worker.request("repo.setOptIn", { repo: "acme/api", optIn: true });
  await until(() => all()[0]?.status === "ready", "the guide");

  const guide = host.data().storage["guide:acme/api#7"] as Record<string, any>;
  assert.equal(guide.schema, "prguide/v2");
  assert.equal(guide.pr.hasDescription, true);
  assert.deepEqual(guide.commentable["src/SessionDataAccess.ts"], [[10, 13]]);
  assert.equal(guide.pr.commit, PR_VIEW.headRefOid);
  assert.equal(guide.reviewRequest, "user");
  assert.equal(guide.generatedBy.model, "claude-opus-5-5");
  // README.md was not grouped by the agent, so the worker adds it under Other with counts from the diff.
  assert.deepEqual(
    guide.areas.map((a: any) => [a.label, a.files.length, a.additions, a.deletions]),
    [
      ["Runtime", 2, 3, 2],
      ["Tests", 1, 1, 0],
      ["Other", 1, 1, 0],
    ],
  );
  assert.equal(all()[0]?.risk, "high");
  assert.deepEqual(host.data().storage.runs, { day: localDay(), count: 1 });

  const agent = calls.find((c) => c.cmd === "claude") as Call;
  assert.ok(agent.args.includes("--model") && agent.args.includes("claude-opus-5-5"));
  const flag = (name: string) => agent.args[agent.args.indexOf(name) + 1];
  assert.equal(flag("--tools"), "Read,Grep,Glob", "no shell and no write tools exist in the run");
  assert.equal(flag("--allowedTools"), "Read,Grep,Glob");
  assert.ok(!agent.args.join(" ").includes("Bash"), "no shell, not even for git");
  assert.equal(flag("--permission-mode"), "dontAsk");
  assert.equal(flag("--settings"), '{"disableAllHooks":true}', "the person's hooks don't run");
  assert.ok(
    agent.args.includes("--strict-mcp-config") && agent.args.includes("--no-session-persistence"),
  );
  assert.ok(agent.options?.input?.includes("<diff>"), "diff goes in the prompt");
  assert.ok(
    calls.some((c) => c.cmd === "git" && c.args.includes("+refs/pull/7/head:refs/pr-tour/pr-7")),
  );
  assert.equal(host.callsOf("notifications.show").length, 1);
});

test("asks the agent once more when its reply does not match the schema", async () => {
  const bad = JSON.stringify({ ...AGENT_GUIDE, risk: { ...AGENT_GUIDE.risk, level: "severe" } });
  const { host, calls, all } = await setup([bad, JSON.stringify(AGENT_GUIDE)], {
    "optin:acme/api": true,
  });
  await until(() => all()[0]?.status === "ready", "the repaired guide");
  const runs = calls.filter((c) => c.cmd === "claude");
  assert.equal(runs.length, 2);
  assert.ok(runs[1]?.options?.input?.includes("risk.level: expected one of low, medium, high"));
  assert.ok(host.data().storage["guide:acme/api#7"]);
});

test("a reply that stays wrong marks the PR failed instead of storing it", async () => {
  const { host, all } = await setup(["not json", "still not json"], {
    "optin:acme/api": true,
  });
  await until(() => all()[0]?.status === "failed", "the failure");
  assert.equal(host.data().storage["guide:acme/api#7"], undefined);
  assert.ok(all()[0]?.error?.includes("JSON"));
});

test("Review opens the guide file in the repo workspace and remembers what you saw", async () => {
  const { host, worker, all } = await setup([JSON.stringify(AGENT_GUIDE)], {
    "optin:acme/api": true,
  });
  await until(() => all()[0]?.status === "ready", "the guide");
  // Guides written where older versions put them are replaced, not left beside the new one.
  await mkdir(join(dir, ".pr-tour"), { recursive: true });
  await writeFile(join(dir, ".pr-tour/7.prtour.json"), "{}");
  await writeFile(join(dir, ".pr-tour/pr-7.prtour.json"), "{}");
  assert.deepEqual(await worker.request("guide.open", { key: "acme/api#7" }), { opened: true });

  // Under .orca/, which Orca's dev watcher skips, so opening a guide of PR Tour's own repo
  // does not reload the dev plugin. "pr-7": the tab is named after the file.
  assert.deepEqual(host.callsOf("editor.open").at(-1), {
    workspaceId: "w1",
    path: ".orca/pr-tour/pr-7.prtour.json",
  });
  assert.ok(!(await readdir(dir)).includes(".pr-tour"), "the old folder and its guides are gone");
  const written = JSON.parse(await readFile(join(dir, ".orca/pr-tour/pr-7.prtour.json"), "utf8"));
  assert.equal(written.pr.number, 7);
  const exclude = await readFile(join(dir, ".git/info/exclude"), "utf8");
  assert.ok(exclude.includes(".orca/pr-tour/"), "the guide folder stays out of git status");
  assert.ok(exclude.includes(".orca/pr-tour-runs/"), "run files stay out of git status");
  assert.equal(
    (host.data().storage["meta:acme/api#7"] as { lastViewedCommit?: string }).lastViewedCommit,
    PR_VIEW.headRefOid,
  );
});

test("respects the daily limit for automatic runs", async () => {
  const day = localDay();
  const { calls, latest, all } = await setup([JSON.stringify(AGENT_GUIDE)], {
    "optin:acme/api": true,
    runs: { day, count: 20 },
  });
  await until(() => latest()?.checkedAt != null && latest()?.checking === false, "the first check");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(calls.filter((c) => c.cmd === "claude").length, 0);
  assert.equal(all()[0]?.status, "none");
  assert.deepEqual(latest()?.notice, {
    tone: "warning",
    text: "Automatic guides paused until tomorrow · Generate still works",
  });
});

test("the daily count starts again on a new local day", async () => {
  const { calls, all } = await setup([JSON.stringify(AGENT_GUIDE)], {
    "optin:acme/api": true,
    runs: { day: "2000-01-01", count: 20 },
  });
  await until(() => all()[0]?.status === "ready", "the guide");
  assert.equal(calls.filter((c) => c.cmd === "claude").length, 1);
  assert.equal(localDay(new Date(2026, 10, 19, 23, 59)), "2026-11-19");
});

test("the status bar command opens the focused branch guide, writing one first when needed", async () => {
  const { host, worker, calls, latest } = await setup([JSON.stringify(AGENT_GUIDE)]);
  await until(() => latest()?.checkedAt != null && latest()?.checking === false, "the first check");
  await worker.emit("workspace.changed", {
    context: { workspaceId: "w1", branch: PR_VIEW.headRefName, displayName: "api", terminals: [] },
  });
  // Repository not turned on, so no guide yet: the command writes one and opens it when ready.
  const answer = await worker.command("openCurrent");
  assert.ok(String(answer).includes("writing one now"));
  await until(() => host.callsOf("editor.open").length === 1, "the guide to open");
  assert.deepEqual(host.callsOf("editor.open")[0], {
    workspaceId: "w1",
    path: ".orca/pr-tour/pr-7.prtour.json",
  });
  assert.equal(calls.filter((c) => c.cmd === "claude").length, 1);
  assert.equal(
    host.data().storage.runs,
    undefined,
    "a run you asked for does not count toward the daily limit",
  );
  const bar = host.callsOf("statusBar.update").at(-1) as { text?: string; tone?: string };
  assert.equal(bar.text, "PR tour: High risk");
  assert.equal(bar.tone, "danger");
  // With the guide stored, the same command just opens it.
  assert.equal(await worker.command("openCurrent"), "Opened the review guide");
});

test("coverage records the files the agent opened with its tools", async () => {
  const events = [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Read",
            input: { file_path: ".orca/pr-tour-runs/7/head/0002.txt" },
          },
        ],
      },
    },
  ];
  const { host, all } = await setup(
    [JSON.stringify(AGENT_GUIDE)],
    { "optin:acme/api": true },
    events,
  );
  await until(() => all()[0]?.status === "ready", "the guide");
  const guide = host.data().storage["guide:acme/api#7"] as Record<string, any>;
  assert.deepEqual(guide.coverage, {
    inPrompt: [
      "src/SessionDataAccess.ts",
      "src/CustomerService.ts",
      "src/SessionDataAccess.test.ts",
      "README.md",
    ],
    readByAgent: ["src/CustomerService.ts"],
    notRead: [],
  });
});

test("the agent reads the PR's files from the run folder, removed once the run ends", async () => {
  let release = (): void => undefined;
  const agentGate = new Promise<void>((resolve) => (release = resolve));
  const { calls, all } = await setup(
    [JSON.stringify(AGENT_GUIDE)],
    { "optin:acme/api": true },
    undefined,
    {
      agentGate,
    },
  );
  await until(() => calls.some((c) => c.cmd === "claude"), "the agent run");
  const run = join(dir, ".orca/pr-tour-runs/7");
  try {
    assert.equal(
      await readFile(join(run, "index.txt"), "utf8"),
      [
        "0001  head  src/SessionDataAccess.ts",
        "0002  head  src/CustomerService.ts",
        "0003  head  src/SessionDataAccess.test.ts",
        "0004  head  README.md",
        "",
      ].join("\n"),
    );
    assert.equal(
      await readFile(join(run, "head/0002.txt"), "utf8"),
      "PR version of src/CustomerService.ts\n",
    );
    const batch = calls.filter((c) => c.cmd === "git" && c.args.includes("--batch"));
    assert.equal(batch.length, 1, "one git process for every PR version");
    assert.ok(batch[0]?.options?.input?.startsWith("refs/pr-tour/pr-7:src/SessionDataAccess.ts\n"));
    const prompt = calls.find((c) => c.cmd === "claude")?.options?.input ?? "";
    assert.ok(prompt.includes("`.orca/pr-tour-runs/7/head/`"));
    // The PR's own diff says "diff --git"; nothing else may name git.
    const ours = prompt.replace(/<diff>[\s\S]*<\/diff>/, "");
    assert.ok(!/\bgit /.test(ours), "no git command in the prompt");
  } finally {
    release();
  }
  await until(() => all()[0]?.status === "ready", "the guide");
  assert.deepEqual(await readdir(join(dir, ".orca")), [], "removed after success");
});

test("the run folder is removed when the run fails or is stopped", async () => {
  const failed = await setup(["NOT_LOGGED_IN"], { "optin:acme/api": true });
  await until(() => failed.all()[0]?.status === "failed", "the failed run");
  assert.deepEqual(await readdir(join(dir, ".orca")), [], "removed after a failure");
  await current?.deactivate();
  current = null;
  await rm(dir, { recursive: true, force: true });

  const stoppedGate = Promise.reject(
    Object.assign(new Error("claude was stopped"), { code: "cancelled" }),
  );
  stoppedGate.catch(() => undefined);
  const stopped = await setup(
    [JSON.stringify(AGENT_GUIDE)],
    { "optin:acme/api": true },
    undefined,
    {
      agentGate: stoppedGate,
    },
  );
  await until(() => stopped.all()[0]?.status === "failed", "the stopped run");
  assert.deepEqual(await readdir(join(dir, ".orca")), [], "removed after a stop");
});

test("run folders left by a crash are removed when the worker starts; guides stay", async () => {
  const { latest } = await setup([JSON.stringify(AGENT_GUIDE)], {}, undefined, {
    before: async (clone) => {
      await mkdir(join(clone, ".orca/pr-tour-runs/3/head"), { recursive: true });
      await writeFile(join(clone, ".orca/pr-tour-runs/3/head/0001.txt"), "left by a crash");
      await writeFile(join(clone, ".orca/drops"), "Orca's own");
      // Where runs were written before they moved under .orca/.
      await mkdir(join(clone, ".pr-tour/runs/2/head"), { recursive: true });
      await writeFile(join(clone, ".pr-tour/runs/2/head/0001.txt"), "left by a crash");
      await writeFile(join(clone, ".pr-tour/pr-3.prtour.json"), "{}");
    },
  });
  await until(() => latest()?.checkedAt != null && latest()?.checking === false, "the first check");
  assert.deepEqual(await readdir(join(dir, ".pr-tour")), ["pr-3.prtour.json"]);
  assert.deepEqual(await readdir(join(dir, ".orca")), ["drops"], "the rest of .orca/ stays");
});

test("after the repair round, stray lines and missing notes are settled instead of failing", async () => {
  const sloppy = JSON.stringify({
    ...AGENT_GUIDE,
    findings: [{ ...nth(AGENT_GUIDE.findings, 0), line: 400 }],
    files: AGENT_GUIDE.files.slice(1),
  });
  const { host, calls, all } = await setup([sloppy, sloppy], { "optin:acme/api": true });
  await until(() => all()[0]?.status === "ready", "the settled guide");
  assert.equal(calls.filter((c) => c.cmd === "claude").length, 2);
  const guide = host.data().storage["guide:acme/api#7"] as Record<string, any>;
  assert.equal(guide.findings[0].line, null);
  assert.equal(guide.files.length, 4);
});

test("a guide from the older version counts as stale and is replaced", async () => {
  const v1 = {
    schema: "prguide/v1",
    title: "Record session end reasons",
    pr: STORED_PR,
    risk: { level: "low", summary: "Old summary.", beforeMerge: [] },
    summary: { what: "w", why: "y", impact: "i" },
    areas: [],
    readingOrder: [],
    flows: [],
    claimsCheck: [],
    sinceLastReview: null,
    generatedBy: { harness: "claude", model: null, at: new Date().toISOString() },
    reviewRequest: "user",
  };
  const { latest, all } = await setup([JSON.stringify(AGENT_GUIDE)], {
    "guide:acme/api#7": v1,
  });
  await until(() => latest()?.checkedAt != null && latest()?.checking === false, "the first check");
  assert.equal(all()[0]?.status, "stale");
  assert.equal(all()[0]?.riskSummary, "Old summary.");
});

test("the queue orders by when your review was asked for, and the guide records it", async () => {
  const { host, latest } = await setup(
    [JSON.stringify(AGENT_GUIDE), JSON.stringify(AGENT_GUIDE)],
    { "optin:acme/api": true },
    undefined,
    { numbers: [7, 8], requested: { 7: "2026-11-18T10:00:00Z", 8: "2026-11-18T08:00:00Z" } },
  );
  await until(
    () =>
      latest()?.queue.length === 2 && latest()?.queue.every((i) => i.status === "ready") === true,
    "both guides",
  );
  const queue = latest()?.queue ?? [];
  // Same risk and no new commits, so whoever asked first is first.
  assert.deepEqual(
    queue.map((i) => [i.number, i.position]),
    [
      [8, 1],
      [7, 2],
    ],
  );
  assert.equal(queue[0]?.requestedAt, Date.parse("2026-11-18T08:00:00Z"));
  const guide = host.data().storage["guide:acme/api#8"] as Record<string, any>;
  assert.equal(guide.pr.requestedAt, "2026-11-18T08:00:00.000Z");
});

test("a GitHub failure shows as the notice, with the last check time", async () => {
  const { worker, latest } = await setup([JSON.stringify(AGENT_GUIDE)]);
  await until(() => latest()?.checkedAt != null && latest()?.checking === false, "the first check");
  setRunner(async () => ({ stdout: "", stderr: "connect: network is unreachable", code: 1 }));
  await worker.request("queue.refresh");
  const notice = latest()?.notice;
  assert.equal(notice?.tone, "warning");
  assert.ok(notice?.text.startsWith("Couldn't reach GitHub · last checked "), notice?.text);
});

test("GitHub's rate limit is named as such, not as GitHub being unreachable", async () => {
  const { worker, latest } = await setup([JSON.stringify(AGENT_GUIDE)]);
  await until(() => latest()?.checkedAt != null && latest()?.checking === false, "the first check");
  setRunner(async () => ({
    stdout: "",
    stderr: "gh: API rate limit exceeded for user ID 1. (HTTP 403)",
    code: 1,
  }));
  await worker.request("queue.refresh");
  const notice = latest()?.notice;
  assert.equal(notice?.tone, "warning");
  assert.ok(notice?.text.startsWith("GitHub rate limit reached · last checked "), notice?.text);
});

test("after a restart, a failed first check still shows the last list, with when it was checked", async () => {
  const first = await setup([JSON.stringify(AGENT_GUIDE)]);
  await until(
    () => first.latest()?.checkedAt != null && first.latest()?.checking === false,
    "the first check",
  );
  assert.equal(first.all()[0]?.key, "acme/api#7");
  const storage = structuredClone<Record<string, unknown>>(first.host.data().storage);
  // Long enough ago that the restart checks at once.
  (storage.lastCheck as { checkedAt: number }).checkedAt = Date.now() - 3 * 60_000;
  await first.worker.deactivate();

  // A new worker (Orca restarted, or the plugin reloaded) whose first check hits the rate limit.
  const second = await setup([JSON.stringify(AGENT_GUIDE)], storage, undefined, { ghDown: true });
  await until(() => second.latest()?.notice != null, "the failed check's notice");
  const state = second.latest() as QueueState;
  assert.deepEqual(
    second.all().map((i) => i.key),
    ["acme/api#7"],
    "the PRs from before the restart are still listed",
  );
  assert.notEqual(state.checkedAt, null, "the saved list says when it was checked");
  assert.ok(
    state.notice?.text.startsWith("GitHub rate limit reached · last checked "),
    state.notice?.text,
  );
});

test("restored PRs start no automatic run until a check works; run state is not restored", async () => {
  // The first worker's run never finishes, so its saved list has a PR due an automatic guide.
  const first = await setup([JSON.stringify(AGENT_GUIDE)], { "optin:acme/api": true }, undefined, {
    agentGate: new Promise(() => undefined),
  });
  await until(() => first.all()[0]?.status === "generating", "the automatic run");
  const storage = structuredClone<Record<string, unknown>>(first.host.data().storage);
  // Long enough ago that the restart checks at once.
  (storage.lastCheck as { checkedAt: number }).checkedAt = Date.now() - 3 * 60_000;
  await first.worker.deactivate();

  const second = await setup([JSON.stringify(AGENT_GUIDE)], storage, undefined, { ghDown: true });
  await until(() => second.latest()?.notice != null, "the failed check's notice");
  await new Promise((r) => setTimeout(r, 100));
  const row = second.all()[0];
  assert.equal(row?.key, "acme/api#7");
  assert.equal(row?.manualReason, null, "still due an automatic guide");
  assert.equal(row?.status, "none", "the old worker's run is not shown as under way");
  assert.equal(second.calls.filter((c) => c.cmd === "claude").length, 0, "no run before a check");
});

const ghCalls = (calls: { cmd: string; args: string[] }[]) => calls.filter((c) => c.cmd === "gh");
const prViews = (calls: { cmd: string; args: string[] }[]) =>
  calls.filter((c) => c.cmd === "gh" && c.args[0] === "pr" && c.args[1] === "view");
const associationCalls = (calls: { cmd: string; args: string[] }[]) =>
  calls.filter((c) => c.cmd === "gh" && /^repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(c.args[1] ?? ""));

test("a restart within 2 minutes of the last check asks GitHub nothing; later it checks", async () => {
  const first = await setup([JSON.stringify(AGENT_GUIDE)]);
  await until(
    () => first.latest()?.checkedAt != null && first.latest()?.checking === false,
    "check",
  );
  const storage = structuredClone<Record<string, unknown>>(first.host.data().storage);
  await first.worker.deactivate();

  const soon = await setup([JSON.stringify(AGENT_GUIDE)], storage);
  await until(() => soon.all().length > 0, "the saved list");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(ghCalls(soon.calls).length, 0, "no GitHub call on a quick restart");
  assert.deepEqual(
    soon.all().map((i) => i.key),
    ["acme/api#7"],
  );
  await soon.worker.deactivate();

  const old = structuredClone<Record<string, unknown>>(storage);
  const saved = old.lastCheck as { checkedAt: number };
  saved.checkedAt = Date.now() - 3 * 60_000;
  const later = await setup([JSON.stringify(AGENT_GUIDE)], old);
  await until(() => ghCalls(later.calls).length > 0, "a check after 2 minutes");
});

test("a check asks GitHub for details only of PRs that changed", async () => {
  const updatedAt: Record<number, string> = {};
  const { worker, calls, latest } = await setup([JSON.stringify(AGENT_GUIDE)], {}, undefined, {
    numbers: [7, 8, 9],
    updatedAt,
  });
  await until(() => latest()?.checkedAt != null && latest()?.checking === false, "the first check");
  assert.equal(prViews(calls).length, 3);
  await worker.request("queue.refresh");
  assert.equal(prViews(calls).length, 3, "nothing changed, so no details asked again");
  updatedAt[8] = "2026-11-22T12:00:00Z";
  await worker.request("queue.refresh");
  assert.deepEqual(
    prViews(calls)
      .slice(3)
      .map((c) => c.args[2]),
    ["8"],
    "only the PR that changed",
  );
});

test("a rate limit holds checks until GitHub's reset; refresh still tries", async () => {
  const limit = { on: false, reset: Math.floor(Date.now() / 1000) + 40 * 60 };
  const { worker, calls, latest } = await setup([JSON.stringify(AGENT_GUIDE)], {}, undefined, {
    limit,
  });
  await until(() => latest()?.checkedAt != null && latest()?.checking === false, "the first check");
  limit.on = true;
  await worker.request("queue.refresh");
  const resume = new Date(limit.reset * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  assert.ok(
    latest()?.notice?.text.startsWith(`GitHub rate limit reached · checks resume at ${resume}`),
    latest()?.notice?.text,
  );
  const before = ghCalls(calls).length;
  await worker.request("queue.refresh");
  assert.ok(ghCalls(calls).length > before, "a refresh you asked for still tries");
});

test("after a restart, author lookups are not asked again", async () => {
  const first = await setup([JSON.stringify(AGENT_GUIDE)]);
  await until(
    () => first.latest()?.checkedAt != null && first.latest()?.checking === false,
    "check",
  );
  assert.equal(associationCalls(first.calls).length, 0, "the search carries it");
  const storage = structuredClone<Record<string, unknown>>(first.host.data().storage);
  (storage.lastCheck as { checkedAt: number }).checkedAt = Date.now() - 3 * 60_000;
  await first.worker.deactivate();

  // This search lacks it, so only the saved answer spares the lookup.
  const second = await setup([JSON.stringify(AGENT_GUIDE)], storage, undefined, {
    association: null,
  });
  await until(
    () => second.latest()?.checking === false && prViews(second.calls).length > 0,
    "the check after the restart",
  );
  assert.equal(associationCalls(second.calls).length, 0, "the saved answer is used");
});

test("the author's association comes with the search; no lookup per PR", async () => {
  const { calls, latest } = await setup([JSON.stringify(AGENT_GUIDE)], {}, undefined, {
    numbers: [7, 8, 9],
  });
  await until(() => latest()?.checkedAt != null && latest()?.checking === false, "the first check");
  assert.equal(associationCalls(calls).length, 0);
  assert.ok(
    latest()
      ?.queue.concat(latest()?.notQueued ?? [])
      .every((i) => i.manualReason !== "Couldn't check the author's access"),
  );
});

test("at most 3 GitHub calls are in flight at once", async () => {
  const inFlight = { now: 0, max: 0 };
  const { latest } = await setup([JSON.stringify(AGENT_GUIDE)], {}, undefined, {
    numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    inFlight,
  });
  await until(() => latest()?.checkedAt != null && latest()?.checking === false, "the first check");
  assert.ok(inFlight.max <= 3, `${inFlight.max} at once`);
});

test("an agent with no sign-in shows as the notice", async () => {
  const { latest, all } = await setup(["NOT_LOGGED_IN"], { "optin:acme/api": true });
  await until(() => all()[0]?.status === "failed", "the failed run");
  assert.deepEqual(latest()?.notice, {
    tone: "danger",
    text: "Claude Code is not signed in · sign in from a terminal, then Generate",
  });
});

test("an agent CLI that is not installed shows as the notice and the row's reason", async () => {
  const { latest, all, calls } = await setup(
    [JSON.stringify(AGENT_GUIDE)],
    { "optin:acme/api": true },
    undefined,
    {
      installed: (cmd) => cmd !== "claude",
    },
  );
  await until(() => all()[0]?.status === "failed", "the failed run");
  assert.deepEqual(latest()?.notice, {
    tone: "danger",
    text: "Claude Code isn't installed · install it, then Generate",
  });
  assert.match(all()[0]?.error ?? "", /^Claude Code isn't installed/);
  assert.equal(calls.filter((c) => c.cmd === "claude").length, 0, "the agent never ran");
});

const posts = (calls: Call[]) => calls.filter((c) => c.cmd === "gh" && c.args.includes("POST"));

async function readyGuide(more: Parameters<typeof setup>[3] = {}) {
  const ctx = await setup(
    [JSON.stringify(AGENT_GUIDE)],
    { "optin:acme/api": true },
    undefined,
    more,
  );
  await until(() => ctx.all()[0]?.status === "ready", "the guide");
  return ctx;
}

const DRAFT: Draft = {
  commitId: PR_VIEW.headRefOid,
  body: "",
  comments: [
    {
      id: "c1",
      path: "src/SessionDataAccess.ts",
      line: 11,
      body: "Emit here too?",
      source: "finding:f1",
    },
    { id: "c2", path: "README.md", line: null, body: "Mention the event.", source: "manual" },
  ],
  dismissedFindings: ["f2"],
};

test("review.submit posts one review with the line comments, then each file comment", async () => {
  const { worker, calls, host } = await readyGuide();
  await worker.request("review.save", { key: "acme/api#7", draft: DRAFT });
  const info = await worker.request("review.get", { key: "acme/api#7" });
  assert.equal(info.canApprove, true);
  assert.deepEqual(info.draft.dismissedFindings, ["f2"]);
  const result = await worker.request("review.submit", {
    key: "acme/api#7",
    event: "COMMENT",
    body: "Looks good apart from one thing.",
  });
  assert.deepEqual(result, {
    outcome: "posted",
    event: "COMMENT",
    url: "https://github.com/acme/api/pull/7#review-1",
    notPosted: [],
  });
  const sent = posts(calls);
  assert.equal(sent.length, 2, "one review, then one file comment");
  assert.deepEqual(sent[0]?.args, [
    "api",
    "-X",
    "POST",
    "repos/acme/api/pulls/7/reviews",
    "--input",
    "-",
  ]);
  assert.deepEqual(JSON.parse(sent[0]?.options?.input ?? ""), {
    commit_id: PR_VIEW.headRefOid,
    event: "COMMENT",
    body: "Looks good apart from one thing.",
    comments: [
      { path: "src/SessionDataAccess.ts", line: 11, side: "RIGHT", body: "Emit here too?" },
    ],
  });
  assert.equal(sent[1]?.args[3], "repos/acme/api/pulls/7/comments");
  assert.deepEqual(JSON.parse(sent[1]?.options?.input ?? ""), {
    commit_id: PR_VIEW.headRefOid,
    path: "README.md",
    body: "Mention the event.",
    subject_type: "file",
  });
  assert.equal(host.data().storage["draft:acme/api#7"], undefined, "the draft is cleared");
});

test("the queue row counts the draft's pending comments, from storage too", async () => {
  const { worker, latest } = await readyGuide();
  const key = "acme/api#7";
  assert.equal(latest()?.queue[0]?.pendingComments, 0);
  await worker.request("review.save", { key, draft: DRAFT });
  await until(() => latest()?.queue[0]?.pendingComments === 2, "the count after a save");
  await worker.request("queue.refresh");
  assert.equal(latest()?.queue[0]?.pendingComments, 2, "read back from draft:<key> on a check");
  await worker.request("review.submit", { key, event: "COMMENT", body: "Thanks." });
  await until(() => latest()?.queue[0]?.pendingComments === 0, "no pending comments once posted");
});

test("the guide last moved through in a tab is the panel's current row", async () => {
  const { worker, latest } = await readyGuide();
  assert.equal(latest()?.openKey, null);
  await worker.request("tour.save", {
    key: "acme/api#7",
    state: { commit: PR_VIEW.headRefOid, view: "overview", visited: [], collapsed: [], last: null },
  });
  await until(() => latest()?.openKey === "acme/api#7", "the open guide");
});

test("review.submit refuses comments off the diff and posts nothing", async () => {
  const { worker, calls, host } = await readyGuide();
  const draft = {
    ...DRAFT,
    comments: [{ ...nth(DRAFT.comments, 0), line: 99 }, nth(DRAFT.comments, 1)],
  };
  await worker.request("review.save", { key: "acme/api#7", draft });
  const result = await worker.request("review.submit", {
    key: "acme/api#7",
    event: "COMMENT",
    body: "x",
  });
  assert.equal(result.outcome, "conflict");
  assert.deepEqual(result.outcome === "conflict" ? result.stale.map((c) => c.id) : [], ["c1"]);
  assert.equal(posts(calls).length, 0);
  const kept = host.data().storage["draft:acme/api#7"] as { body: string; comments: unknown[] };
  assert.equal(kept.comments.length, 2, "the draft is kept for fixing");
  assert.equal(kept.body, "x");
});

test("Approve is refused on your own PR, before GitHub is asked", async () => {
  const { worker, calls } = await readyGuide({ author: "me" });
  assert.equal((await worker.request("review.get", { key: "acme/api#7" })).canApprove, false);
  const result = await worker.request("review.submit", {
    key: "acme/api#7",
    event: "APPROVE",
    body: "",
  });
  assert.deepEqual(result, {
    outcome: "refused",
    message: "GitHub does not let you approve or request changes on your own PR.",
  });
  assert.equal(posts(calls).length, 0);
});

test("a file comment GitHub refuses stays in the draft; the review still stands", async () => {
  const { worker, host } = await readyGuide({ refuseFileComments: ["README.md"] });
  await worker.request("review.save", { key: "acme/api#7", draft: DRAFT });
  const result = await worker.request("review.submit", {
    key: "acme/api#7",
    event: "COMMENT",
    body: "",
  });
  assert.equal(result.outcome, "posted");
  assert.deepEqual(result.outcome === "posted" ? result.notPosted.map((c) => c.id) : [], ["c2"]);
  const kept = host.data().storage["draft:acme/api#7"] as { comments: { id: string }[] };
  assert.deepEqual(
    kept.comments.map((c) => c.id),
    ["c2"],
  );
});

const diffCalls = (calls: Call[], path: string) =>
  calls.filter((c) => c.cmd === "git" && c.args.includes("diff") && c.args.at(-1) === path);

test("diff.get answers one file's diff at the guide's commit, and caches it", async () => {
  const { worker, calls } = await readyGuide();
  const diff = await worker.request("diff.get", {
    key: "acme/api#7",
    path: "src/SessionDataAccess.ts",
  });
  assert.equal(diff.commit, PR_VIEW.headRefOid);
  assert.equal(diff.status, "modified");
  assert.deepEqual(diff.lines, [
    "@@ -10,3 +10,4 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
    " const d = 5;",
  ]);
  assert.deepEqual([diff.additions, diff.deletions, diff.truncated], [2, 1, false]);
  const [call] = diffCalls(calls, "src/SessionDataAccess.ts");
  assert.ok(
    call?.args.includes(`refs/pr-tour/base-7...${PR_VIEW.headRefOid}`),
    call?.args.join(" "),
  );
  assert.ok(call?.args.includes("--literal-pathspecs"));
  await worker.request("diff.get", { key: "acme/api#7", path: "src/SessionDataAccess.ts" });
  assert.equal(
    diffCalls(calls, "src/SessionDataAccess.ts").length,
    1,
    "the second answer is cached",
  );
  const renamed = diffCalls(calls, "src/CustomerService.ts");
  assert.equal(renamed.length, 0);
  await worker.request("diff.get", { key: "acme/api#7", path: "src/CustomerService.ts" });
  const [r] = diffCalls(calls, "src/CustomerService.ts");
  assert.deepEqual(
    r?.args.slice(-3),
    ["--", "src/Old.ts", "src/CustomerService.ts"],
    "a rename diffs against its old path",
  );
});

test("diff.get fetches the PR first when the clone lacks the guide's commit", async () => {
  const objects = { present: true };
  const { worker, calls } = await readyGuide({ objects });
  objects.present = false;
  const fetchesBefore = calls.filter((c) => c.cmd === "git" && c.args.includes("fetch")).length;
  const diff = await worker.request("diff.get", { key: "acme/api#7", path: "README.md" });
  const fetches = calls.filter((c) => c.cmd === "git" && c.args.includes("fetch"));
  assert.equal(fetches.length, fetchesBefore + 1);
  assert.ok(fetches.at(-1)?.args.includes("+refs/pull/7/head:refs/pr-tour/pr-7"));
  assert.deepEqual(diff.lines, ["@@ -1 +1,2 @@", " # api", "+notes"]);
});

test("PRs are fetched over HTTPS with gh's credentials, never through origin's SSH", async () => {
  const { calls } = await readyGuide();
  const fetches = calls.filter((c) => c.cmd === "git" && c.args.includes("fetch"));
  assert.ok(fetches.length > 0);
  for (const f of fetches) {
    // The clone's origin is git@github.com:old-owner/api.git; the PR lives at acme/api.
    assert.ok(f.args.includes("https://github.com/acme/api.git"), f.args.join(" "));
    assert.ok(!f.args.includes("origin"), "no SSH key or agent prompt in a background run");
    const helpers = f.args.filter(
      (a, i) => f.args[i - 1] === "-c" && a.startsWith("credential.helper="),
    );
    assert.deepEqual(helpers, ["credential.helper=", "credential.helper=!gh auth git-credential"]);
  }
});

test("diff.get refuses a commit that is not a commit id", async () => {
  const { worker } = await readyGuide();
  await assert.rejects(
    worker.request("diff.get", { key: "acme/api#7", path: "README.md", commit: "--output=x" }),
  );
});

test("after the repair round, focus ranges outside the diff are dropped, not fatal", async () => {
  const first = nth(AGENT_GUIDE.readingOrder, 0);
  const second = nth(AGENT_GUIDE.readingOrder, 1);
  const sloppy = JSON.stringify({
    ...AGENT_GUIDE,
    readingOrder: [
      { ...first, focus: [{ start: 400, end: 410 }] },
      {
        ...second,
        focus: [
          { start: 1, end: 1 },
          { start: 300, end: 301 },
        ],
      },
    ],
  });
  const { host, calls, all } = await setup([sloppy, sloppy], { "optin:acme/api": true });
  await until(() => all()[0]?.status === "ready", "the settled guide");
  assert.equal(calls.filter((c) => c.cmd === "claude").length, 2, "one repair round first");
  assert.ok(
    calls
      .filter((c) => c.cmd === "claude")[1]
      ?.options?.input?.includes("readingOrder[0].focus[0]: lines 400-410 are not in the diff"),
  );
  const guide = host.data().storage["guide:acme/api#7"] as Record<string, any>;
  assert.equal(guide.readingOrder[0].focus, undefined, "whole file");
  assert.deepEqual(guide.readingOrder[1].focus, [{ start: 1, end: 1 }]);
  assert.equal(guide.readingOrder[0].check, first?.check);
  assert.ok(
    current?.logs.some((l) => l.includes("kept 0 of 1 focus ranges, shows the whole file")),
  );
});

test("tour progress is stored per PR and commit, and shows on the queue row", async () => {
  const { worker, host, latest } = await readyGuide();
  const key = "acme/api#7";
  // Three stops, then the skipped files' stop (the lockfile and the generated logo).
  assert.deepEqual(await worker.request("tour.get", { key, stops: 4 }), {
    commit: PR_VIEW.headRefOid,
    view: "overview",
    visited: [],
    collapsed: [],
    last: null,
  });
  assert.equal(latest()?.queue[0]?.tour, null, "not started");
  const state: TourState = {
    commit: PR_VIEW.headRefOid,
    view: "stop:0",
    visited: [0],
    collapsed: [0],
    last: 0,
  };
  await worker.request("tour.save", { key, state });
  assert.deepEqual(host.data().storage["tour:acme/api#7"], state);
  assert.deepEqual(await worker.request("tour.get", { key, stops: 4 }), state);
  // Progress counts files: stop 1 holds one of the four guide files, plus two skipped.
  await until(() => latest()?.queue[0]?.tour === "1 of 6 files", "the queue row's progress");
  await worker.request("tour.save", { key, state: { ...state, view: "stop:3", visited: [0, 3] } });
  await until(() => latest()?.queue[0]?.tour === "3 of 6 files", "the skipped files counted");
  await worker.request("tour.save", {
    key,
    state: { ...state, view: "wrapup", visited: [0, 1, 2, 3] },
  });
  await until(() => latest()?.queue[0]?.tour === "Reviewed tour", "the finished tour");
  // A tab on another commit starts again; progress made there does not count for this guide.
  assert.deepEqual(await worker.request("tour.get", { key, commit: "0000000", stops: 4 }), {
    commit: "0000000",
    view: "overview",
    visited: [],
    collapsed: [],
    last: null,
  });
  await worker.request("tour.save", {
    key,
    state: { commit: "0000000", view: "stop:1", visited: [1], collapsed: [], last: 1 },
  });
  await until(() => latest()?.queue[0]?.tour === null, "progress from another commit to clear");
  await assert.rejects(worker.request("tour.save", { key, state: { commit: "--x" } as never }));
});

test("progress on an older guide's commit is not shown after a refresh", async () => {
  const { worker, latest } = await setup([JSON.stringify(AGENT_GUIDE)], {
    "optin:acme/api": true,
    "tour:acme/api#7": { commit: "0000000", view: "stop:1", visited: [0, 1] },
  });
  await until(() => latest()?.queue[0]?.status === "ready", "the guide");
  await worker.request("queue.refresh");
  assert.equal(latest()?.queue[0]?.tour, null);
});

test("breakdown.get groups the PR's files by kind at the guide's commit, and caches it", async () => {
  const { worker, calls } = await readyGuide();
  const b = await worker.request("breakdown.get", { key: "acme/api#7" });
  assert.deepEqual([b.headRef, b.baseRef], [PR_VIEW.headRefName, PR_VIEW.baseRefName]);
  assert.deepEqual(
    b.categories.map((c) => [c.id, c.files.map((f) => `${f.status} ${f.path}`)]),
    [
      ["runtime", ["R src/CustomerService.ts", "M src/SessionDataAccess.ts"]],
      ["tests", ["M src/SessionDataAccess.test.ts"]],
      ["migrations", ["A db/migrations/0002_reason.sql"]],
      ["dependencies", ["M pnpm-lock.yaml"]],
      ["docs", ["M README.md"]],
      ["generated", ["M assets/logo.png"]],
    ],
    "package.json in the tree turns the TypeScript preset on; check-attr marks the logo generated",
  );
  const renamed = b.categories[0]?.files[0];
  assert.equal(renamed?.oldPath, "src/Old.ts");
  assert.equal(b.categories.at(-1)?.files[0]?.binary, true);
  assert.deepEqual([b.additions, b.deletions, b.fileCount], [57, 5, 7]);
  await worker.request("breakdown.get", { key: "acme/api#7" });
  const git = (word: string) =>
    calls.filter((c) => c.cmd === "git" && c.args.includes(word) && !c.args.includes("-w"));
  assert.equal(
    git("--numstat").length,
    1,
    "computed once (when the guide was written), then cached",
  );
  assert.equal(git("ls-tree").length, 1);
  const range = `refs/pr-tour/base-7...${PR_VIEW.headRefOid}`;
  assert.ok(git("--numstat")[0]?.args.includes(range));
  assert.ok(git("ls-tree")[0]?.args.includes(PR_VIEW.headRefOid));
  assert.ok(git("check-attr")[0]?.args.includes(`--source=${PR_VIEW.headRefOid}`));
  assert.equal(
    git("check-attr")[0]?.options?.input?.split("\0").length,
    8,
    "seven paths, NUL-ended",
  );
});

test("breakdown.get applies the repo's overrides file at the PR head first", async () => {
  const { worker } = await readyGuide({
    overrides: JSON.stringify({ rules: [{ category: "contracts", paths: ["src/Customer*.ts"] }] }),
  });
  const b = await worker.request("breakdown.get", { key: "acme/api#7" });
  const contracts = b.categories.find((c) => c.id === "contracts");
  assert.deepEqual(
    contracts?.files.map((f) => f.path),
    ["src/CustomerService.ts"],
  );
});

test("breakdown.get fetches the PR first when the clone lacks the commit", async () => {
  const objects = { present: true };
  const { worker, calls } = await readyGuide({ objects });
  objects.present = false;
  const fetches = () => calls.filter((c) => c.cmd === "git" && c.args.includes("fetch")).length;
  const before = fetches();
  const b = await worker.request("breakdown.get", { key: "acme/api#7", commit: "abcdef1234567" });
  assert.equal(fetches(), before + 1);
  assert.equal(b.fileCount, 7);
  await assert.rejects(worker.request("breakdown.get", { key: "acme/api#7", commit: "HEAD~1" }));
});

test("the tour covers every file: skipped files are stored, coverage is repaired, then enforced", async () => {
  const [first, second, skim] = AGENT_GUIDE.readingOrder;
  // CustomerService.ts is a contract here (the repo's overrides), skimmed by the agent; README.md
  // is in no stop; the lockfile is in one although it is skipped by design.
  const sloppy = JSON.stringify({
    ...AGENT_GUIDE,
    readingOrder: [
      first,
      {
        ...skim,
        files: ["src/SessionDataAccess.test.ts", "src/CustomerService.ts", "pnpm-lock.yaml"],
      },
    ],
  });
  const { host, calls, all } = await setup(
    [sloppy, sloppy],
    { "optin:acme/api": true },
    undefined,
    {
      overrides: JSON.stringify({
        rules: [{ category: "contracts", paths: ["src/Customer*.ts"] }],
      }),
    },
  );
  await until(() => all()[0]?.status === "ready", "the enforced guide");
  const runs = calls.filter((c) => c.cmd === "claude");
  assert.equal(runs.length, 2, "one repair round first");
  const prompt = runs[0]?.options?.input ?? "";
  assert.ok(
    prompt.includes(
      "<skipped_by_design>\nassets/logo.png  (generated)\npnpm-lock.yaml  (lockfile)\n</skipped_by_design>",
    ),
  );
  assert.ok(
    prompt.includes("<must_be_deep>\nsrc/CustomerService.ts  (contract file)\n</must_be_deep>"),
  );
  const repair = runs[1]?.options?.input ?? "";
  for (const problem of [
    '"pnpm-lock.yaml" is skipped by design (lockfile)',
    '"src/CustomerService.ts" is a contract file; give it a deep stop of its own',
    '"README.md" is in no stop',
  ])
    assert.ok(repair.includes(problem), problem);
  const guide = host.data().storage["guide:acme/api#7"] as Record<string, any>;
  assert.deepEqual(guide.skipped, [
    { path: "assets/logo.png", reason: "generated" },
    { path: "pnpm-lock.yaml", reason: "lockfile" },
  ]);
  assert.deepEqual(
    guide.readingOrder.map((r: any) => [r.depth, r.files, r.why]),
    [
      ["deep", ["src/SessionDataAccess.ts"], "finding"],
      ["skim", ["src/SessionDataAccess.test.ts"], "tests"],
      ["deep", ["src/CustomerService.ts"], "risky"],
      ["skim", ["README.md"], "routine"],
    ],
  );
  assert.ok(current?.logs.some((l) => l.includes("moved from a skim stop to its own deep stop")));
  assert.ok(current?.logs.some((l) => l.includes('added to "Other changes": README.md')));
  assert.ok(current?.logs.some((l) => l.includes("2 deep, 2 skim; 2 skipped")));
  void second;
});

test("skipped.get answers a guide's skipped files, from git for a guide stored without them", async () => {
  // Written before guides stored their skipped files, with an old single-file stop.
  const older = {
    schema: "prguide/v2",
    title: "Record session end reasons",
    pr: { ...STORED_PR, headRef: "f", requestedAt: null, hasDescription: true },
    risk: { level: "low", headline: "x", beforeMerge: [] },
    summary: { what: { headline: "w" }, why: { headline: "y" }, impact: { headline: "i" } },
    readingOrder: [{ file: "src/SessionDataAccess.ts", areaId: "runtime", headline: "h" }],
    files: [],
    findings: [],
    areas: [],
    flows: [],
    claimsCheck: [],
    sinceLastReview: null,
    coverage: null,
    commentable: { "src/SessionDataAccess.ts": [], "README.md": [] },
    generatedBy: { harness: "claude", model: null, at: new Date().toISOString() },
    reviewRequest: "user",
  };
  const { worker, latest } = await setup([], {
    "guide:acme/api#7": older,
    "tour:acme/api#7": { commit: PR_VIEW.headRefOid, view: "stop:0", visited: [0] },
  });
  await until(() => latest()?.checkedAt != null && latest()?.checking === false, "the first check");
  const key = "acme/api#7";
  assert.deepEqual(await worker.request("skipped.get", { key }), [
    { path: "assets/logo.png", reason: "generated" },
    { path: "pnpm-lock.yaml", reason: "lockfile" },
  ]);
  // The queue counts the old stop, README.md in "Other changes", and the two skipped files.
  const row = [...(latest()?.queue ?? []), ...(latest()?.notQueued ?? [])][0];
  assert.equal(row?.tour, "1 of 4 files");
  await assert.rejects(worker.request("skipped.get", { key, commit: "HEAD~1" }));
});

test("a run counts against the daily limit by how it was started, not by what else is running", async () => {
  let release = () => {};
  const agentGate = new Promise<void>((resolve) => (release = resolve));
  const { host, worker, latest, all } = await setup(
    [JSON.stringify(AGENT_GUIDE), JSON.stringify(AGENT_GUIDE)],
    {},
    undefined,
    { numbers: [7, 8], agentGate },
  );
  await until(() => latest()?.checkedAt != null && latest()?.checking === false, "the first check");
  // Generate by hand for #7; while its agent run is held, turning the repo on queues #8 automatically.
  await worker.request("guide.generate", { key: "acme/api#7" });
  await worker.request("repo.setOptIn", { repo: "acme/api", optIn: true });
  release();
  await until(() => all().length === 2 && all().every((i) => i.status === "ready"), "both guides");
  assert.deepEqual(
    host.data().storage.runs,
    { day: localDay(), count: 1 },
    "only the automatic run for #8 is counted",
  );
  assert.equal(host.callsOf("notifications.show").length, 1, "and only it notifies");
});

test("the agent run never sees the worker's GitHub token; git and gh keep their environment", async () => {
  const saved = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "gh-secret-of-the-worker";
  try {
    const { calls, all } = await setup([JSON.stringify(AGENT_GUIDE)], { "optin:acme/api": true });
    await until(() => all()[0]?.status === "ready", "the guide");
    const agent = calls.find((c) => c.cmd === "claude");
    assert.ok(agent?.options?.env, "the agent is given an environment of its own");
    assert.equal(agent.options.env.GH_TOKEN, undefined);
    assert.ok(
      calls.filter((c) => c.cmd !== "claude").every((c) => c.options?.env === undefined),
      "git and gh run as before",
    );
  } finally {
    if (saved === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = saved;
  }
});

const TOKEN = `ghp_${"a1".repeat(18)}`;

test("a reply holding a token is not stored; the PR is marked failed", async () => {
  const leaky = JSON.stringify({
    ...AGENT_GUIDE,
    risk: { ...AGENT_GUIDE.risk, headline: `Uses ${TOKEN} to call GitHub` },
  });
  const { host, all } = await setup([leaky], { "optin:acme/api": true });
  await until(() => all()[0]?.status === "failed", "the refused guide");
  assert.equal(host.data().storage["guide:acme/api#7"], undefined);
  const error = all()[0]?.error ?? "";
  assert.ok(error.includes("a GitHub token"), error);
  assert.ok(!error.includes(TOKEN), "the error never repeats the token");
});

test("review.submit refuses a comment holding a token and posts nothing", async () => {
  const { worker, calls, host } = await readyGuide();
  const draft = {
    ...DRAFT,
    comments: [nth(DRAFT.comments, 0), { ...nth(DRAFT.comments, 1), body: `Use ${TOKEN}` }],
  };
  await worker.request("review.save", { key: "acme/api#7", draft });
  const result = await worker.request("review.submit", {
    key: "acme/api#7",
    event: "COMMENT",
    body: "Fine.",
  });
  assert.equal(result.outcome, "refused");
  assert.ok(
    result.outcome === "refused" && result.message.includes("README.md"),
    JSON.stringify(result),
  );
  assert.equal(posts(calls).length, 0);
  const kept = host.data().storage["draft:acme/api#7"] as { comments: unknown[] };
  assert.equal(kept.comments.length, 2, "the draft is kept for fixing");

  await worker.request("review.save", { key: "acme/api#7", draft: DRAFT });
  const summary = await worker.request("review.submit", {
    key: "acme/api#7",
    event: "COMMENT",
    body: `Token: ${TOKEN}`,
  });
  assert.equal(summary.outcome, "refused", "the summary is checked too");
  assert.equal(posts(calls).length, 0);
});

/** The PR adds a test fixture shaped like an AWS key: quoting it leaks nothing. */
const FIXTURE_KEY = "AKIAABCDEFGHIJKLMNOP";
const DIFF_WITH_FIXTURE = DIFF.replace("+const c = 4;", `+const c = "${FIXTURE_KEY}";`);

test("a guide quoting a secret-shaped string from the PR itself is stored", async () => {
  const quoting = JSON.stringify({
    ...AGENT_GUIDE,
    risk: { ...AGENT_GUIDE.risk, headline: `The test fixture ${FIXTURE_KEY} looks like a key` },
  });
  const { host, all } = await setup([quoting], { "optin:acme/api": true }, undefined, {
    diff: DIFF_WITH_FIXTURE,
  });
  await until(
    () => all()[0]?.status === "ready" || all()[0]?.status === "failed",
    "the run to finish",
  );
  assert.equal(all()[0]?.status, "ready", all()[0]?.error ?? "");
  assert.ok(host.data().storage["guide:acme/api#7"], "the guide is stored");
});

test("review.submit posts a comment quoting a secret-shaped string from the PR itself", async () => {
  const { worker, calls } = await readyGuide({ diff: DIFF_WITH_FIXTURE });
  const draft = {
    ...DRAFT,
    comments: [{ ...nth(DRAFT.comments, 0), body: `Is ${FIXTURE_KEY} a real key?` }],
  };
  await worker.request("review.save", { key: "acme/api#7", draft });
  const result = await worker.request("review.submit", {
    key: "acme/api#7",
    event: "COMMENT",
    body: "One question.",
  });
  assert.notEqual(result.outcome, "refused", JSON.stringify(result));
  assert.ok(posts(calls).length > 0, "the review is posted");
});

test("a PR from outside the repository is not run automatically; a member's is", async () => {
  const outside = await setup(
    [JSON.stringify(AGENT_GUIDE)],
    { "optin:acme/api": true },
    undefined,
    {
      association: "CONTRIBUTOR",
    },
  );
  await until(
    () => outside.latest()?.checkedAt != null && outside.latest()?.checking === false,
    "the first check",
  );
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(outside.calls.filter((c) => c.cmd === "claude").length, 0);
  assert.equal(outside.latest()?.notQueued[0]?.manualReason, "Author is not a collaborator");
  assert.ok(
    !outside.calls.some((c) => c.cmd === "gh" && c.args[1] === "repos/acme/api/pulls/7"),
    "author_association comes with the search",
  );
  // Generate still works by hand.
  await outside.worker.request("guide.generate", { key: "acme/api#7" });
  await until(() => outside.all()[0]?.status === "ready", "the guide asked for by hand");
  await outside.worker.request("queue.refresh");
  assert.equal(
    outside.calls.filter((c) => c.cmd === "gh" && c.args[1] === "repos/acme/api/pulls/7").length,
    0,
    "never asked per PR",
  );
  await current?.deactivate();
  current = null;
  await rm(dir, { recursive: true, force: true });

  const member = await setup([JSON.stringify(AGENT_GUIDE)], { "optin:acme/api": true }, undefined, {
    association: "MEMBER",
  });
  await until(() => member.all()[0]?.status === "ready", "the automatic guide");
});

test("an unknown author association counts as untrusted for automatic runs", async () => {
  const { calls, latest } = await setup(
    [JSON.stringify(AGENT_GUIDE)],
    { "optin:acme/api": true },
    undefined,
    {
      association: null,
    },
  );
  await until(() => latest()?.checkedAt != null && latest()?.checking === false, "the first check");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(calls.filter((c) => c.cmd === "claude").length, 0);
  assert.equal(latest()?.notQueued[0]?.manualReason, "Couldn't check the author's access");
});

test("a run that changes .git/hooks stores nothing and turns the repository's automatic runs off", async () => {
  const { host, latest, all, calls } = await setup(
    [JSON.stringify(AGENT_GUIDE), JSON.stringify(AGENT_GUIDE)],
    { "optin:acme/api": true },
    undefined,
    {
      before: async (clone) => {
        await mkdir(join(clone, ".git/hooks"), { recursive: true });
        await writeFile(join(clone, ".git/config"), "[core]\n");
        await writeFile(join(clone, ".git/hooks/pre-commit.sample"), "#!/bin/sh\n");
      },
      agentDoes: async () => {
        await writeFile(join(dir, ".git/hooks/pre-commit"), "#!/bin/sh\ncurl evil\n");
      },
    },
  );
  await until(() => all()[0]?.status === "failed", "the failed run");
  assert.equal(host.data().storage["guide:acme/api#7"], undefined, "nothing stored");
  const error = all()[0]?.error ?? "";
  assert.ok(error.includes(".git/hooks/pre-commit"), error);
  assert.equal(host.data().storage["optin:acme/api"], false, "automatic runs are off");
  const notice = latest()?.notice;
  assert.equal(notice?.tone, "danger");
  assert.ok(notice?.text.includes("#7"), notice?.text);
  assert.equal(latest()?.repos[0]?.optIn, false);
  const runs = calls.filter((c) => c.cmd === "claude").length;
  assert.equal(runs, 1);
  // The notice is the only way back: it names the repo once and carries the control to turn it on.
  assert.equal(notice?.turnOn, "acme/api", "the notice offers turning automatic guides back on");
  assert.equal(
    notice?.text.split("acme/api").length,
    2,
    `the repository is named once: ${notice?.text}`,
  );
});
