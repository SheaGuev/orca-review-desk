// Running git, gh and the agent CLI from the worker. Tests swap the runner with setRunner.
import { spawn } from "node:child_process";
import { access, constants, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { delimiter, join } from "node:path";

export type RunOptions = {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** How stdout is decoded; "latin1" keeps one character per byte, for byte counts and raw files. */
  stdoutEncoding?: "utf8" | "latin1";
  /** The whole environment of the run, in place of the worker's own (see `cleanEnv`). */
  env?: Record<string, string>;
};
export type RunResult = { stdout: string; stderr: string; code: number };
export type Runner = (cmd: string, args: string[], options?: RunOptions) => Promise<RunResult>;

let pathValue: string | undefined;

/**
 * Orca gives workers a filtered environment without USER. Claude Code reads its subscription
 * login from the macOS keychain by user name, and reports "Not logged in" without it.
 */
function userName(): string | undefined {
  try {
    return process.env.USER || userInfo().username;
  } catch {
    return undefined;
  }
}

const stopped = (cmd: string): Error =>
  Object.assign(new Error(`${cmd} was stopped`), { code: "cancelled" });

const defaultRunner: Runner = (cmd, args, options = {}) =>
  new Promise((resolve, reject) => {
    // An already-aborted signal never fires "abort", so nothing is spawned for it.
    if (options.signal?.aborted) return reject(stopped(cmd));
    const user = userName();
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env ?? {
        ...process.env,
        ...(pathValue ? { PATH: pathValue } : {}),
        ...(user ? { USER: user } : {}),
        NO_COLOR: "1",
        GH_PROMPT_DISABLED: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(() => reject(stopped(cmd)));
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() =>
        reject(
          new Error(`${cmd} took longer than ${Math.round((options.timeoutMs ?? 0) / 1000)} s`),
        ),
      );
    }, options.timeoutMs ?? 120_000);
    options.signal?.addEventListener("abort", onAbort);
    child.stdout
      .setEncoding(options.stdoutEncoding ?? "utf8")
      .on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => resolve({ stdout, stderr, code: code ?? 1 })));
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });

/**
 * What every agent run keeps of the worker's environment: where things are, who runs them, how
 * text is shown, and how to reach the network (proxies, certificates). Windows' own variables are
 * here too; names compare without case, as Windows does. A trailing `*` matches a prefix.
 */
const BASE_ENV = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LANGUAGE",
  "LC_*",
  "TERM",
  "TZ",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
];

/**
 * Never passed on, whatever a harness asks for: they reach GitHub or npm as the person. (Cloud
 * credentials such as `AWS_*` are left out unless an agent's spec keeps them, as Claude on Bedrock.)
 */
const NEVER_ENV = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "NPM_TOKEN",
];

const matches = (name: string, patterns: readonly string[]): boolean => {
  const upper = name.toUpperCase();
  return patterns.some((p) => (p.endsWith("*") ? upper.startsWith(p.slice(0, -1)) : upper === p));
};

/**
 * The environment for an agent run: the login-shell PATH, the base variables above and the
 * harness's own (`keep`, such as `ANTHROPIC_*`); nothing else of the worker's, so a token in it
 * never reaches the agent.
 */
export function cleanEnv(keep: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || matches(name, NEVER_ENV)) continue;
    if (matches(name, BASE_ENV) || matches(name, keep)) env[name] = value;
  }
  const path = pathValue ?? process.env.PATH;
  if (path) env.PATH = path;
  const user = userName();
  if (user) env.USER = user;
  env.NO_COLOR = "1";
  return env;
}

/** Whether `file` is a file this user may run. */
async function runnable(file: string): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Whether `cmd` is an executable file in a folder of `path` (with Windows' PATHEXT endings). */
export async function onPath(cmd: string, path: string): Promise<boolean> {
  const endings =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)]
      : [""];
  for (const dir of path.split(delimiter).filter(Boolean))
    for (const ending of endings) if (await runnable(join(dir, cmd + ending))) return true;
  return false;
}

const lookUp = (cmd: string): Promise<boolean> => onPath(cmd, pathValue ?? process.env.PATH ?? "");

let runner: Runner = defaultRunner;
let installed = lookUp;

/**
 * Swaps how commands run, for tests. A test's runner stands in for every binary, so each counts as
 * installed unless `has` says otherwise.
 */
export function setRunner(next: Runner | null, has?: (cmd: string) => boolean): void {
  runner = next ?? defaultRunner;
  installed = next ? async (cmd) => has?.(cmd) ?? true : lookUp;
}

/** Whether `cmd` is on the PATH agent runs get (the login shell's, once `loadLoginPath` ran). */
export function isInstalled(cmd: string): Promise<boolean> {
  return installed(cmd);
}

export function run(cmd: string, args: string[], options?: RunOptions): Promise<RunResult> {
  return runner(cmd, args, options);
}

const DETAIL_LIMIT = 500;

/**
 * A failed command's output in one line: its first line (often the one that says what went wrong,
 * as git's "Permission denied (publickey)") and its last two, blank lines left out.
 */
function failureDetail(output: string): string {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const kept = lines.length > 3 ? [lines[0], "…", ...lines.slice(-2)] : lines;
  const detail = kept.join(" ");
  return detail.length > DETAIL_LIMIT ? `${detail.slice(0, DETAIL_LIMIT - 1)}…` : detail;
}

/** Runs and returns stdout, throwing with stderr when the command fails. */
export async function runOk(cmd: string, args: string[], options?: RunOptions): Promise<string> {
  const result = await run(cmd, args, options);
  if (result.code !== 0) {
    const detail = failureDetail(result.stderr || result.stdout);
    throw new Error(`${cmd} ${args[0] ?? ""} failed: ${detail || `exit ${result.code}`}`);
  }
  return result.stdout;
}

/**
 * Orca started from Finder has a short PATH, so tools in Homebrew or ~/.local/bin are missing.
 * Ask the login shell once for the PATH the person's terminal would have.
 */
export async function loadLoginPath(): Promise<void> {
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const { stdout } = await defaultRunner(shell, ["-lc", 'printf %s "$PATH"'], {
      timeoutMs: 10_000,
    });
    const extra = stdout.trim();
    if (extra) {
      const parts = [...extra.split(":"), ...(process.env.PATH ?? "").split(":")];
      pathValue = [...new Set(parts.filter(Boolean))].join(":");
    }
  } catch {
    // keep Orca's PATH
  }
}
