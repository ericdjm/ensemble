// `ensemble claude [args...]` / `ensemble codex [args...]` (docs/plan-v2.md Phase 1).
// Launches an agent in the current checkout through the running Ensemble server (tmux, launcher,
// preflight, hooks: the same path as the browser) and attaches this terminal to the tmux session.
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import type { Agent, Session, Workspace } from "../shared/types.js";
import {
  DEFAULT_UI_HOST,
  DEFAULT_UI_PORT,
  PRODUCT_NAME,
  TMUX_SOCKET_NAME,
} from "../shared/brand.js";
import { readConfigIfPresent, readServerInfo, type Config } from "./config.js";
import { loginShellWhich } from "./sessions.js";
import { Tmux } from "./tmux.js";

/** Arguments that mean "just run the real binary"; they never need a session. */
const PASSTHROUGH_ARGS = new Set(["--help", "-h", "--version", "-v", "-V"]);

export interface AgentCommandOptions {
  agent: Agent;
  args: string[];
  stateDir: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Test-only: replaces the terminal attach (returns the attach client's exit code). */
  attach?: (tmuxName: string, tmuxSocket: string) => Promise<number>;
  /** Test-only: replaces the direct exec of the real binary. */
  passthrough?: (cliPath: string, args: string[]) => Promise<number>;
  /** Test-only: skips the interactive-terminal requirement. */
  requireTty?: boolean;
}

export class CliExit extends Error {
  constructor(
    message: string,
    public readonly code: number,
  ) {
    super(message);
    this.name = "CliExit";
  }
}

function serverUrl(stateDir: string): { base: string; tmuxSocket: string } {
  const info = readServerInfo(stateDir);
  const host = info?.host ?? DEFAULT_UI_HOST;
  const port = info?.port ?? DEFAULT_UI_PORT;
  const h =
    host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  return { base: `http://${h}:${port}`, tmuxSocket: info?.tmuxSocket ?? TMUX_SOCKET_NAME };
}

async function request<T>(
  base: string,
  token: string,
  method: string,
  url: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const message =
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { error?: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : `${res.status} ${res.statusText}`;
    throw new CliExit(message, res.status === 401 ? 2 : 1);
  }
  return parsed as T;
}

async function resolveBinary(agent: Agent, config: Config | null): Promise<string> {
  const override = config?.cliPaths[agent];
  if (override) return override;
  const found = await loginShellWhich(agent);
  if (!found) throw new CliExit(`${agent} was not found on your login-shell PATH`, 127);
  return found;
}

function waitExit(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve) => {
    child.on("error", () => resolve(127));
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function execPassthrough(cliPath: string, args: string[]): Promise<number> {
  return waitExit(spawn(cliPath, args, { stdio: "inherit" }));
}

/** Name of the controlling terminal (tmux's client name), or null when stdin is not a terminal. */
export function ttyName(): string | null {
  if (!process.stdin.isTTY) return null;
  try {
    const out = execFileSync("tty", {
      stdio: ["inherit", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    return out.startsWith("/dev/") ? out : null;
  } catch {
    return null;
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Attaches this terminal to the session. A session-level `pane-died` hook detaches this client
 * (and only this client) as soon as the agent exits, so the user is not left in a dead pane.
 */
async function attachTerminal(
  tmuxName: string,
  tmuxSocket: string,
  tty: string,
  stderr: (line: string) => void,
): Promise<number> {
  const tmux = new Tmux({ socketName: tmuxSocket });
  const target = `=${tmuxName}:`;
  await tmux.run(["set-hook", "-t", target, "pane-died", `detach-client -t ${shellQuote(tty)}`]);
  try {
    const before = await tmux.pane(tmuxName);
    if (!before) return 1;
    if (!before.dead) {
      const child = spawn("tmux", tmux.attachArgs(tmuxName), {
        stdio: "inherit",
        env: { ...tmux.clientEnv(), TERM: process.env["TERM"] ?? "xterm-256color" },
      });
      await waitExit(child);
    }
    const after = await tmux.pane(tmuxName);
    if (after?.dead) {
      const code = after.deadStatus ?? 1;
      if (code !== 0) {
        try {
          const tail = (await tmux.run(["capture-pane", "-p", "-t", target, "-S", "-8"]))
            .split("\n")
            .filter((l) => l.trim().length > 0)
            .slice(-4);
          for (const line of tail) stderr(`  ${line}`);
        } catch {
          /* pane already gone */
        }
      }
      stderr(`${PRODUCT_NAME}: session ended (exit ${code}). Its log stays in the browser.`);
      return code;
    }
    stderr(
      `${PRODUCT_NAME}: detached; the session keeps running. Reattach with: tmux -L ${tmuxSocket} attach -t ${tmuxName}`,
    );
    return 0;
  } finally {
    await tmux.run(["set-hook", "-u", "-t", target, "pane-died"]).catch(() => undefined);
  }
}

/** Runs the command and resolves with the process exit code. Never throws for expected failures. */
export async function runAgentCommand(opts: AgentCommandOptions): Promise<number> {
  const { agent, args } = opts;
  const passthrough = opts.passthrough ?? execPassthrough;
  const config = readConfigSafe(opts.stateDir, opts.stderr);

  // Inside an Ensemble session (or for --help/--version) run the real binary untouched: this keeps
  // `alias claude='ensemble claude'` from recursing and makes `claude --version` behave normally.
  const first = args[0];
  if (opts.env["ENSEMBLE_INSIDE"] === "1" || (first !== undefined && PASSTHROUGH_ARGS.has(first))) {
    try {
      return await passthrough(await resolveBinary(agent, config), args);
    } catch (e) {
      return fail(e, opts.stderr);
    }
  }

  const tty = opts.requireTty === false ? "/dev/null" : ttyName();
  if (!tty) {
    opts.stderr(`ensemble ${agent} needs an interactive terminal (stdin is not a TTY).`);
    return 1;
  }
  if (!config) {
    opts.stderr(
      `${PRODUCT_NAME} has not been started on this machine yet. Run \`ensemble start\` in another terminal first.`,
    );
    return 1;
  }

  const { base, tmuxSocket } = serverUrl(opts.stateDir);
  try {
    await request(base, config.uiToken, "GET", "/api/health");
  } catch (e) {
    if (e instanceof CliExit && e.code === 2) {
      opts.stderr(
        `${PRODUCT_NAME} at ${base} rejected the token in ${opts.stateDir}/config.json; restart the server.`,
      );
      return 1;
    }
    opts.stderr(`${PRODUCT_NAME} is not running at ${base}.`);
    opts.stderr(
      "Start it with `ensemble start` (or `pnpm start` in the Ensemble checkout) in another terminal, then retry.",
    );
    return 1;
  }

  let ws: Workspace;
  let session: Session;
  try {
    ws = await request<Workspace>(base, config.uiToken, "POST", "/api/workspaces/inplace", {
      path: opts.cwd,
      agent,
    });
    session = await request<Session>(base, config.uiToken, "POST", "/api/sessions", {
      workspaceId: ws.id,
      agent,
      cliArgs: args,
      remoteControl: agent === "claude" && config.remoteControlDefault,
    });
  } catch (e) {
    return fail(e, opts.stderr);
  }
  if (session.processState !== "running") {
    opts.stderr(
      `${PRODUCT_NAME} could not start the session: ${session.refusalReason ?? "unknown error"}`,
    );
    return 1;
  }

  const where =
    ws.kind === "inplace" ? `in place at ${ws.path}` : `in worktree ${ws.name} (${ws.path})`;
  opts.stdout(`${PRODUCT_NAME}: ${agent} session ${session.id.slice(0, 8)} ${where}`);
  opts.stdout(`  browser:  ${base}/#/ws/${ws.id}`);
  opts.stdout(`  detach:   Ctrl-b d (the session keeps running)`);
  if (ws.kind === "inplace")
    opts.stdout(
      `  note:     this is your checkout, not an isolated worktree; one agent at a time here.`,
    );

  const attach = opts.attach ?? ((name, socket) => attachTerminal(name, socket, tty, opts.stderr));
  try {
    return await attach(session.tmuxName, tmuxSocket);
  } catch (e) {
    return fail(e, opts.stderr);
  }
}

function readConfigSafe(stateDir: string, stderr: (line: string) => void): Config | null {
  try {
    return readConfigIfPresent(stateDir);
  } catch (e) {
    stderr(`${path.join(stateDir, "config.json")}: ${(e as Error).message}`);
    return null;
  }
}

function fail(e: unknown, stderr: (line: string) => void): number {
  if (e instanceof CliExit) {
    stderr(`${PRODUCT_NAME}: ${e.message}`);
    return e.code;
  }
  stderr(`${PRODUCT_NAME}: ${(e as Error).message}`);
  return 1;
}
