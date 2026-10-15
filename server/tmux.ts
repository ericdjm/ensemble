import { execFile } from "node:child_process";
import path from "node:path";
import { TMUX_SOCKET_NAME } from "../shared/brand.js";
import { packageRoot } from "./paths.js";

export const STRIPPED_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
] as const;

export interface TmuxOptions {
  socketName?: string;
  confPath?: string;
  binary?: string;
  /** Variables removed from the environment of every tmux client we spawn (and thus from a server we start). */
  stripVars?: readonly string[];
}

export interface PaneInfo {
  session: string;
  dead: boolean;
  deadStatus: number | null;
  pid: number | null;
  activity: number | null;
}

export interface NewSessionInput {
  name: string;
  cwd: string;
  env: Record<string, string>;
  command: string[];
  width?: number;
  height?: number;
  /** When set, pane output is appended to this file via pipe-pane from the first command batch. */
  logFile?: string;
}

export class TmuxError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "TmuxError";
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Client for the dedicated Ensemble tmux server (`tmux -L ensemble -f helpers/tmux.conf`). */
export class Tmux {
  readonly socketName: string;
  readonly confPath: string;
  private readonly binary: string;
  private readonly stripVars: readonly string[];

  constructor(opts: TmuxOptions = {}) {
    this.socketName = opts.socketName ?? TMUX_SOCKET_NAME;
    this.confPath = opts.confPath ?? path.join(packageRoot(), "helpers", "tmux.conf");
    this.binary = opts.binary ?? "tmux";
    this.stripVars = opts.stripVars ?? STRIPPED_ENV_VARS;
  }

  /** Arguments to attach from a terminal; also used by the PTY bridge. */
  attachArgs(sessionName: string): string[] {
    return ["-L", this.socketName, "-f", this.confPath, "attach-session", "-t", sessionName];
  }

  clientEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !this.stripVars.includes(k)) env[k] = v;
    }
    return env;
  }

  run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.binary,
        ["-L", this.socketName, "-f", this.confPath, ...args],
        { env: this.clientEnv(), timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new TmuxError(
                `tmux ${args[0] ?? ""} failed: ${stderr.trim() || error.message}`,
                stderr,
              ),
            );
            return;
          }
          resolve(stdout.replace(/\n$/, ""));
        },
      );
    });
  }

  async version(): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.binary, ["-V"], { env: this.clientEnv(), timeout: 10_000 }, (error, stdout) => {
        if (error) reject(new TmuxError(`tmux -V failed: ${error.message}`, ""));
        else resolve(stdout.trim());
      });
    });
  }

  async newSession(input: NewSessionInput): Promise<void> {
    const args = ["new-session", "-d", "-s", input.name, "-c", input.cwd];
    args.push("-x", String(input.width ?? 200), "-y", String(input.height ?? 50));
    for (const [k, v] of Object.entries(input.env)) {
      if (!/^[A-Z_][A-Z0-9_]*$/i.test(k))
        throw new Error(`invalid environment variable name: ${k}`);
      args.push("-e", `${k}=${v}`);
    }
    args.push("--", ...input.command);
    if (input.logFile) {
      args.push(
        ";",
        "pipe-pane",
        "-t",
        `=${input.name}:`,
        "-o",
        `cat >> ${shellQuote(input.logFile)}`,
      );
    }
    await this.run(args);
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      await this.run(["has-session", "-t", `=${name}:`]);
      return true;
    } catch {
      return false;
    }
  }

  async killSession(name: string): Promise<void> {
    if (await this.hasSession(name)) await this.run(["kill-session", "-t", `=${name}:`]);
  }

  async killServer(): Promise<void> {
    try {
      await this.run(["kill-server"]);
    } catch {
      /* no server */
    }
  }

  async listPanes(): Promise<PaneInfo[]> {
    let out: string;
    try {
      out = await this.run([
        "list-panes",
        "-a",
        "-F",
        "#{session_name}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_pid}\t#{window_activity}",
      ]);
    } catch (e) {
      if (e instanceof TmuxError && /no server running|No such file/i.test(e.stderr)) return [];
      throw e;
    }
    if (!out) return [];
    return out.split("\n").map((line) => {
      const [session = "", dead = "0", deadStatus = "", pid = "", activity = ""] = line.split("\t");
      return {
        session,
        dead: dead === "1",
        deadStatus: dead === "1" && deadStatus !== "" ? Number(deadStatus) : null,
        pid: pid !== "" ? Number(pid) : null,
        activity: activity !== "" ? Number(activity) : null,
      };
    });
  }

  async pane(name: string): Promise<PaneInfo | undefined> {
    return (await this.listPanes()).find((p) => p.session === name);
  }

  /** Types literal text then Enter (quick reply). */
  async sendLine(name: string, text: string): Promise<void> {
    await this.run(["send-keys", "-t", `=${name}:`, "-l", "--", text]);
    await this.run(["send-keys", "-t", `=${name}:`, "Enter"]);
  }

  async sendKeys(name: string, keys: string[]): Promise<void> {
    await this.run(["send-keys", "-t", `=${name}:`, ...keys]);
  }

  /** Polls until the pane has exited; resolves with its exit status (null if the session vanished). */
  async waitForExit(
    name: string,
    opts: { intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<number | null> {
    const started = Date.now();
    const interval = opts.intervalMs ?? 500;
    for (;;) {
      const pane = await this.pane(name);
      if (!pane) return null;
      if (pane.dead) return pane.deadStatus;
      if (opts.timeoutMs !== undefined && Date.now() - started > opts.timeoutMs) {
        throw new TmuxError(`timed out waiting for ${name}`, "");
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  }
}
