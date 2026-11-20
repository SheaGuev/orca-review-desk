// Running git, gh and the agent CLI from the worker. Tests swap the runner with setRunner.
import { spawn } from "node:child_process";
import { userInfo } from "node:os";

export type RunOptions = { cwd?: string; input?: string; timeoutMs?: number; signal?: AbortSignal };
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

const defaultRunner: Runner = (cmd, args, options = {}) =>
  new Promise((resolve, reject) => {
    const user = userName();
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: {
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
      finish(() => reject(Object.assign(new Error(`${cmd} was stopped`), { code: "cancelled" })));
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
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => resolve({ stdout, stderr, code: code ?? 1 })));
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });

let runner: Runner = defaultRunner;

export function setRunner(next: Runner | null): void {
  runner = next ?? defaultRunner;
}

export function run(cmd: string, args: string[], options?: RunOptions): Promise<RunResult> {
  return runner(cmd, args, options);
}

/** Runs and returns stdout, throwing with stderr when the command fails. */
export async function runOk(cmd: string, args: string[], options?: RunOptions): Promise<string> {
  const result = await run(cmd, args, options);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ");
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
