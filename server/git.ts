import { execFile } from "node:child_process";

export class GitError extends Error {
  constructor(
    message: string,
    public readonly args: string[],
    public readonly stderr: string,
    public readonly code: number | null,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface GitOptions {
  cwd: string;
  timeoutMs?: number;
  /** Extra environment variables merged over a minimal base (never the server's full env). */
  env?: Record<string, string>;
}

/** Runs git with an argument array; never a shell. Resolves with trimmed stdout. */
export function git(args: string[], opts: GitOptions): Promise<string> {
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: process.env["HOME"] ?? "/",
    LANG: "C",
    GIT_TERMINAL_PROMPT: "0",
    ...opts.env,
  };
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd: opts.cwd, env, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const code =
            typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : null;
          reject(
            new GitError(
              `git ${args[0] ?? ""} failed: ${stderr.trim() || error.message}`,
              args,
              stderr,
              code,
            ),
          );
          return;
        }
        resolve(stdout.replace(/\n$/, ""));
      },
    );
  });
}
