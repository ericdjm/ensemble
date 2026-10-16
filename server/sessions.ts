import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Agent, LastAnswer, PendingInputs, Session } from "../shared/types.js";
import { answerPreview } from "./answers.js";
import type { Config } from "./config.js";
import { statePaths } from "./config.js";
import type { Db } from "./db/index.js";
import { nowIso } from "./db/index.js";
import { getRepo } from "./repos.js";
import { packageRoot } from "./paths.js";
import { STRIPPED_ENV_VARS, type Tmux } from "./tmux.js";
import { scriptEnv, WorkspaceError, type WorkspaceService } from "./workspaces.js";
import { EMPTY_PENDING, initialTurnState, type TurnState } from "./hooks/reducer.js";
import { withSpoolLock } from "./hooks/spool-lock.js";
import { readFileSync, readdirSync, rmSync } from "node:fs";

export const EXIT_REFUSED = 78;

/** Claude Code events registered per session (docs/architecture.md §7.6). PermissionRequest hooks return nothing. */
export const CLAUDE_HOOK_EVENTS: readonly string[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "Notification",
  "Elicitation",
  "ElicitationResult",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "SessionEnd",
];

/** Codex lifecycle hooks (documented; injection via -c is unverified on the real binary, see cli-notes). */
export const CODEX_HOOK_EVENTS: readonly string[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
  "SessionEnd",
];

export interface SessionRow {
  id: string;
  workspace_id: string;
  agent: Agent;
  tmux_name: string;
  cli_session_id: string | null;
  transcript_path: string | null;
  remote_control: number;
  status: Session["status"];
  exit_code: number | null;
  process_state: Session["processState"];
  freshness: Session["freshness"];
  auth_mode: Session["authMode"];
  auth_label: string | null;
  auth_checked_at: string | null;
  billing_opt_in: number;
  billing_ack: number;
  refusal_reason: string | null;
  predecessor_id: string | null;
  successor_id: string | null;
  hook_generation: number;
  last_seq: number;
  pending_inputs_json: string;
  hook_token_hash: string | null;
  last_answer: string | null;
  last_answer_at: string | null;
  last_answer_source: Session["lastAnswerSource"];
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export function rowToSession(r: SessionRow): Session {
  let pending: PendingInputs;
  try {
    pending = {
      ...EMPTY_PENDING,
      perm: {},
      ...(JSON.parse(r.pending_inputs_json) as Partial<PendingInputs>),
    };
  } catch {
    pending = { ...EMPTY_PENDING, perm: {} };
  }
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    agent: r.agent,
    tmuxName: r.tmux_name,
    cliSessionId: r.cli_session_id,
    transcriptPath: r.transcript_path,
    remoteControl: r.remote_control === 1,
    status: r.status,
    exitCode: r.exit_code,
    processState: r.process_state,
    freshness: r.freshness,
    authMode: r.auth_mode,
    authLabel: r.auth_label,
    authCheckedAt: r.auth_checked_at,
    billingOptIn: r.billing_opt_in === 1,
    billingAck: r.billing_ack === 1,
    refusalReason: r.refusal_reason,
    predecessorId: r.predecessor_id,
    successorId: r.successor_id,
    hookGeneration: r.hook_generation,
    lastSeq: r.last_seq,
    pendingInputs: pending,
    lastAnswerAt: r.last_answer_at,
    lastAnswerSource: r.last_answer_source,
    lastAnswerPreview: answerPreview(r.last_answer),
    createdAt: r.created_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

export function turnStateFromRow(r: SessionRow): TurnState {
  const s = rowToSession(r);
  return {
    ...initialTurnState(),
    status: s.status,
    turnActive: s.status === "working",
    pending: s.pendingInputs,
    cliSessionId: s.cliSessionId,
    transcriptPath: s.transcriptPath,
    freshness: s.freshness,
    authMode: s.authMode,
    authLabel: s.authLabel,
    authCheckedAt: s.authCheckedAt,
    refusalReason: s.refusalReason,
    remoteControl: s.remoteControl,
  };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const sessionTmuxName = (id: string) => `ens-${id.slice(0, 8)}`;

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Arguments that would make the session non-interactive or override Ensemble's own flags. */
const DENIED_CLI_ARGS: Record<Agent, ReadonlySet<string>> = {
  claude: new Set([
    "-p",
    "--print",
    "--settings",
    "--remote-control",
    "--help",
    "-h",
    "--version",
    "-v",
  ]),
  codex: new Set(["--help", "-h", "--version", "-V"]),
};
/** Codex subcommands that are not an interactive session (checked on the first positional argument only). */
const DENIED_CODEX_SUBCOMMANDS = new Set([
  "exec",
  "e",
  "login",
  "logout",
  "mcp",
  "mcp-server",
  "app-server",
  "completion",
  "apply",
  "a",
  "cloud",
  "sandbox",
  "debug",
  "features",
  "help",
]);
export const MAX_CLI_ARGS = 64;
export const MAX_CLI_ARG_LENGTH = 8192;

/** Validates user-supplied CLI arguments passed through `ensemble claude|codex` (docs/plan-v2.md Phase 1). */
export function validateCliArgs(agent: Agent, args: unknown): string[] {
  if (args === undefined) return [];
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string"))
    throw new WorkspaceError("cliArgs must be an array of strings");
  const list = args as string[];
  if (list.length > MAX_CLI_ARGS) throw new WorkspaceError(`at most ${MAX_CLI_ARGS} CLI arguments`);
  let firstPositional: string | null = null;
  for (const arg of list) {
    if (arg.length > MAX_CLI_ARG_LENGTH || arg.includes("\0"))
      throw new WorkspaceError("invalid CLI argument");
    const bare = arg.includes("=") && arg.startsWith("--") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (DENIED_CLI_ARGS[agent].has(bare))
      throw new WorkspaceError(
        `${arg} is not allowed through Ensemble: sessions must stay interactive and keep Ensemble's hooks; run ${agent} directly instead`,
      );
    if (firstPositional === null && !arg.startsWith("-")) firstPositional = arg;
  }
  if (
    agent === "codex" &&
    firstPositional !== null &&
    DENIED_CODEX_SUBCOMMANDS.has(firstPositional)
  )
    throw new WorkspaceError(
      `codex ${firstPositional} is not an interactive session; run codex directly instead`,
    );
  return list;
}

export interface LaunchInput {
  workspaceId: string;
  agent: Agent;
  prompt?: string;
  /** Extra arguments from `ensemble claude|codex [args...]`, already validated by validateCliArgs. */
  cliArgs?: string[];
  remoteControl?: boolean;
  billingAck?: boolean;
  /** Resume this exact CLI conversation id (set by resume()). */
  resumeCliSessionId?: string;
  predecessorId?: string;
}

export interface SessionServiceDeps {
  db: Db;
  config: Config;
  stateDir: string;
  tmux: Tmux;
  workspaces: WorkspaceService;
  /** Test-only: extra variables placed in the agent's tmux environment. */
  extraAgentEnv?: Record<string, string>;
}

/** Agent session lifecycle (docs/architecture.md §7). Emits "changed" (Session) and "status" (Session, notify). */
export class SessionService extends EventEmitter {
  private readonly db: Db;
  private readonly config: Config;
  private readonly stateDir: string;
  private readonly tmux: Tmux;
  private readonly workspaces: WorkspaceService;
  private readonly extraAgentEnv: Record<string, string>;
  private cliCache = new Map<string, { path: string; at: number }>();
  private livenessTimer: NodeJS.Timeout | null = null;

  constructor(deps: SessionServiceDeps) {
    super();
    this.db = deps.db;
    this.config = deps.config;
    this.stateDir = deps.stateDir;
    this.tmux = deps.tmux;
    this.workspaces = deps.workspaces;
    this.extraAgentEnv = deps.extraAgentEnv ?? {};
  }

  list(): Session[] {
    return (
      this.db.prepare("SELECT * FROM sessions ORDER BY created_at").all() as SessionRow[]
    ).map(rowToSession);
  }

  listForWorkspace(workspaceId: string): Session[] {
    return (
      this.db
        .prepare("SELECT * FROM sessions WHERE workspace_id = ? ORDER BY created_at")
        .all(workspaceId) as SessionRow[]
    ).map(rowToSession);
  }

  row(id: string): SessionRow {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      SessionRow | undefined;
    if (!row) throw new WorkspaceError("session not found", 404);
    return row;
  }

  get(id: string): Session {
    return rowToSession(this.row(id));
  }

  sessionDir(id: string): string {
    return path.join(statePaths(this.stateDir).sessions, id);
  }

  emitChanged(id: string, notify = false): Session {
    const s = this.get(id);
    this.emit("changed", s);
    this.emit("status", s, notify);
    return s;
  }

  /** Resolves the official CLI: settings override, else the user's login-shell PATH. */
  async resolveCli(agent: Agent): Promise<{ path: string; from: "override" | "login-shell PATH" }> {
    const override = this.config.cliPaths[agent];
    if (override) return { path: override, from: "override" };
    const cached = this.cliCache.get(agent);
    if (cached && Date.now() - cached.at < 60_000)
      return { path: cached.path, from: "login-shell PATH" };
    const found = await loginShellWhich(agent);
    if (!found)
      throw new WorkspaceError(
        `${agent} was not found on your login-shell PATH; set its path in settings`,
        409,
      );
    this.cliCache.set(agent, { path: found, at: Date.now() });
    return { path: found, from: "login-shell PATH" };
  }

  async launch(input: LaunchInput): Promise<Session> {
    const ws = this.workspaces.get(input.workspaceId);
    if (ws.status !== "ready") throw new WorkspaceError("workspace is not ready", 409);
    const repo = getRepo(this.db, ws.repoId);
    if (!repo) throw new WorkspaceError("repo not found", 404);
    const cli = await this.resolveCli(input.agent);
    const cliArgs = validateCliArgs(input.agent, input.cliArgs);

    const id = randomUUID();
    const dir = this.sessionDir(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    mkdirSync(path.join(dir, "spool"), { mode: 0o700 });
    const token = randomBytes(32).toString("base64url");
    const write = (name: string, value: unknown) => {
      const file = path.join(dir, name);
      writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
      chmodSync(file, 0o600);
      return file;
    };
    write("hook.json", {
      sessionId: id,
      token,
      port: this.config.hookPort,
      generation: 1,
      limits: this.config.spool,
    });

    const helpers = path.join(packageRoot(), "helpers");
    const captureCmd = (adapter: Agent) =>
      `${shellQuote(process.execPath)} ${shellQuote(path.join(helpers, "hook-capture.mjs"))} ${adapter}`;
    const options: string[] = [];
    let remoteControlName: string | undefined;
    if (input.agent === "claude") {
      const hooks: Record<string, unknown> = {};
      for (const event of CLAUDE_HOOK_EVENTS) {
        hooks[event] = [
          { hooks: [{ type: "command", command: captureCmd("claude"), timeout: 5 }] },
        ];
      }
      const settings = write("claude-settings.json", { hooks });
      options.push("--settings", settings);
      if (input.resumeCliSessionId) options.push("--resume", input.resumeCliSessionId);
      if (input.remoteControl) remoteControlName = `${repo.name}/${ws.name}`;
    } else {
      const notify = `notify=[${JSON.stringify(process.execPath)},${JSON.stringify(path.join(helpers, "codex-notify.mjs"))}]`;
      if (input.resumeCliSessionId) options.push("resume");
      options.push("-c", notify);
      for (const event of CODEX_HOOK_EVENTS) {
        options.push(
          "-c",
          `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(captureCmd("codex"))}}]}]`,
        );
      }
      if (input.resumeCliSessionId) options.push(input.resumeCliSessionId);
    }
    options.push(...cliArgs);

    const optIn = this.config.billingOptIn;
    const manifest = write("launch.json", {
      agent: input.agent,
      cliPath: cli.path,
      cwd: ws.path,
      options,
      prompt: input.prompt,
      remoteControlName,
      env: {
        strip: optIn ? [] : [...STRIPPED_ENV_VARS],
        set: { ENSEMBLE_SESSION_DIR: dir, ENSEMBLE_SESSION_ID: id, ENSEMBLE_INSIDE: "1" },
      },
      auth: { require: "subscription", optIn, ack: input.billingAck === true },
      sessionDir: dir,
      sessionId: id,
    });

    const tmuxName = sessionTmuxName(id);
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO sessions (id, workspace_id, agent, tmux_name, remote_control, status, process_state, freshness, auth_mode,
          billing_opt_in, billing_ack, predecessor_id, hook_generation, last_seq, pending_inputs_json, hook_token_hash,
          cli_options_json, created_at, started_at)
         VALUES (?, ?, ?, ?, ?, 'starting', 'running', 'unknown', 'unchecked', ?, ?, ?, 1, 0, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ws.id,
        input.agent,
        tmuxName,
        input.remoteControl ? 1 : 0,
        optIn ? 1 : 0,
        input.billingAck ? 1 : 0,
        input.predecessorId ?? null,
        JSON.stringify(EMPTY_PENDING),
        hashToken(token),
        JSON.stringify(options),
        now,
        now,
      );
    if (input.predecessorId) {
      this.db
        .prepare("UPDATE sessions SET successor_id = ? WHERE id = ?")
        .run(id, input.predecessorId);
      this.emitChanged(input.predecessorId);
    }

    try {
      await this.tmux.newSession({
        name: tmuxName,
        cwd: ws.path,
        env: {
          ...scriptEnv(ws, repo),
          ENSEMBLE_SESSION_ID: id,
          ENSEMBLE_SESSION_DIR: dir,
          ...this.extraAgentEnv,
        },
        command: [process.execPath, path.join(helpers, "agent-launcher.mjs"), manifest],
      });
    } catch (e) {
      this.db
        .prepare(
          "UPDATE sessions SET status = 'error', process_state = 'missing', refusal_reason = ?, ended_at = ? WHERE id = ?",
        )
        .run(`tmux: ${(e as Error).message}`, nowIso(), id);
    }
    this.ensureLiveness();
    return this.emitChanged(id);
  }

  /** Starts a new process that resumes the exact CLI conversation of an exited session. */
  async resume(
    id: string,
    opts: { cliSessionId?: string; billingAck?: boolean } = {},
  ): Promise<Session> {
    const old = this.get(id);
    if (old.processState === "running") throw new WorkspaceError("session is still running", 409);
    if (old.successorId) throw new WorkspaceError("session was already resumed", 409);
    const cliSessionId = opts.cliSessionId ?? old.cliSessionId;
    if (!cliSessionId) {
      throw new WorkspaceError(
        "no conversation id was captured for this session; paste the id, use the CLI's own picker, or start a new conversation",
        409,
      );
    }
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(cliSessionId))
      throw new WorkspaceError("invalid conversation id");
    return this.launch({
      workspaceId: old.workspaceId,
      agent: old.agent,
      remoteControl: old.remoteControl,
      ...(opts.billingAck !== undefined ? { billingAck: opts.billingAck } : {}),
      resumeCliSessionId: cliSessionId,
      predecessorId: old.id,
    });
  }

  /** Opens a fresh terminal session running the CLI's own interactive conversation picker. */
  async openPicker(id: string): Promise<Session> {
    const old = this.get(id);
    if (old.processState === "running") throw new WorkspaceError("session is still running", 409);
    return this.launch({
      workspaceId: old.workspaceId,
      agent: old.agent,
      resumeCliSessionId: "",
      predecessorId: old.id,
    });
  }

  /** Types text into the session and submits it. Multi-line text is pasted (bracketed when the CLI asks for it). */
  async input(id: string, text: string): Promise<void> {
    const s = this.get(id);
    if (s.processState !== "running") throw new WorkspaceError("session is not running", 409);
    if (text.includes("\n") || text.includes("\r"))
      await this.tmux.pasteLine(s.tmuxName, text, this.sessionDir(id));
    else await this.tmux.sendLine(s.tmuxName, text);
  }

  /** Full text of the captured last answer (docs/plan-v2.md Phase 2). */
  lastAnswer(id: string): LastAnswer {
    const r = this.row(id);
    return { text: r.last_answer, at: r.last_answer_at, source: r.last_answer_source };
  }

  /** Delivers `text` to `targetId` as a handoff from `fromId`, recording an ensemble.handoff event on both. */
  async handoff(
    fromId: string,
    targetId: string,
    text: string,
    appendEvent: (sessionId: string, type: string, payload: unknown) => void,
  ): Promise<{ delivered: number }> {
    if (fromId === targetId) throw new WorkspaceError("cannot hand off a session to itself");
    const from = this.get(fromId);
    const target = this.get(targetId);
    if (target.processState !== "running")
      throw new WorkspaceError("target session is not running", 409);
    const body = text.trim();
    if (!body) throw new WorkspaceError("nothing to send");
    const header = `From ${from.agent} in ${this.workspaceLabel(from.workspaceId)} (Ensemble handoff):`;
    await this.input(targetId, `${header}\n${body}`);
    const payload = {
      fromSessionId: from.id,
      fromAgent: from.agent,
      toSessionId: target.id,
      toAgent: target.agent,
      chars: body.length,
    };
    appendEvent(target.id, "ensemble.handoff", { ...payload, direction: "received" });
    appendEvent(from.id, "ensemble.handoff", { ...payload, direction: "sent" });
    return { delivered: body.length };
  }

  /** Sends one prompt to every running session in a workspace. */
  async askAll(workspaceId: string, text: string): Promise<{ sent: string[] }> {
    const body = text.trim();
    if (!body) throw new WorkspaceError("nothing to send");
    const sent: string[] = [];
    for (const s of this.listForWorkspace(workspaceId)) {
      if (s.processState !== "running") continue;
      await this.input(s.id, body);
      sent.push(s.id);
    }
    if (sent.length === 0) throw new WorkspaceError("no running sessions in this workspace", 409);
    return { sent };
  }

  workspaceLabel(workspaceId: string): string {
    try {
      const ws = this.workspaces.get(workspaceId);
      const repo = getRepo(this.db, ws.repoId);
      return repo ? `${repo.name}/${ws.name}` : ws.name;
    } catch {
      return "workspace";
    }
  }

  async sendCommand(id: string, command: string): Promise<void> {
    const s = this.get(id);
    if (s.processState !== "running") throw new WorkspaceError("session is not running", 409);
    if (s.agent !== "claude") throw new WorkspaceError("only available for Claude sessions", 409);
    if (s.authMode === "other")
      throw new WorkspaceError("Remote Control is not available for this authentication mode", 409);
    await this.tmux.sendLine(s.tmuxName, command);
  }

  async kill(id: string): Promise<Session> {
    const s = this.get(id);
    await this.tmux.killSession(s.tmuxName);
    this.db
      .prepare(
        "UPDATE sessions SET process_state = 'missing', status = CASE WHEN status IN ('exited','error') THEN status ELSE 'exited' END, ended_at = COALESCE(ended_at, ?) WHERE id = ?",
      )
      .run(nowIso(), id);
    return this.emitChanged(id);
  }

  /**
   * Clears the event history (docs §7.6): under the spool lock the generation is bumped and old records
   * removed, so a delayed POST or replay carrying the old generation is rejected instead of restored.
   */
  clearEvents(id: string): Session {
    const row = this.row(id);
    const dir = this.sessionDir(id);
    const newGeneration = withSpoolLock(dir, (spool) => {
      let generation = row.hook_generation;
      try {
        const state = JSON.parse(readFileSync(path.join(spool, "state.json"), "utf8")) as {
          generation?: number;
        };
        if (Number.isInteger(state.generation))
          generation = Math.max(generation, state.generation as number);
      } catch {
        /* no state yet */
      }
      const next = generation + 1;
      for (const name of readdirSync(spool)) {
        if (name === "lock") continue;
        if (name === "gap.json" || /^\d+-\d{10}\.json$/.test(name))
          rmSync(path.join(spool, name), { force: true });
      }
      writeFileSync(path.join(spool, "state.json"), JSON.stringify({ generation: next, seq: 0 }), {
        mode: 0o600,
      });
      const hookFile = path.join(dir, "hook.json");
      try {
        const hook = JSON.parse(readFileSync(hookFile, "utf8")) as Record<string, unknown>;
        writeFileSync(hookFile, JSON.stringify({ ...hook, generation: next }, null, 2), {
          mode: 0o600,
        });
      } catch {
        /* session dir without hook.json (never launched) */
      }
      return next;
    });
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM events WHERE session_id = ? AND generation < ?")
        .run(id, newGeneration);
      this.db
        .prepare("DELETE FROM event_gaps WHERE session_id = ? AND generation < ?")
        .run(id, newGeneration);
      this.db
        .prepare("UPDATE sessions SET hook_generation = ?, last_seq = 0 WHERE id = ?")
        .run(newGeneration, id);
    })();
    return this.emitChanged(id);
  }

  async stopForWorkspace(workspaceId: string): Promise<void> {
    for (const s of this.listForWorkspace(workspaceId)) {
      if (s.processState === "running" || s.processState === "dead" || s.processState === "unknown")
        await this.kill(s.id);
    }
  }

  ensureLiveness(intervalMs = 2000): void {
    if (this.livenessTimer) return;
    this.livenessTimer = setInterval(() => {
      this.refreshLiveness().catch(() => undefined);
    }, intervalMs);
    this.livenessTimer.unref();
  }

  stopLiveness(): void {
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.livenessTimer = null;
  }

  /** Reconciles process_state/exit_code with tmux (docs §6.4 and §7.6). */
  async refreshLiveness(): Promise<void> {
    const rows = this.db
      .prepare("SELECT * FROM sessions WHERE process_state IN ('running','unknown','dead')")
      .all() as SessionRow[];
    if (rows.length === 0) return;
    const panes = new Map((await this.tmux.listPanes()).map((p) => [p.session, p]));
    for (const row of rows) {
      const pane = panes.get(row.tmux_name);
      let processState: Session["processState"];
      let exitCode: number | null = row.exit_code;
      if (!pane) processState = "missing";
      else if (pane.dead) {
        processState = "dead";
        exitCode = pane.deadStatus;
      } else processState = "running";
      if (processState === row.process_state && exitCode === row.exit_code) continue;
      let status = row.status;
      if (processState !== "running") {
        if (exitCode === EXIT_REFUSED) status = "error";
        else if (status !== "error") status = "exited";
      }
      this.db
        .prepare(
          "UPDATE sessions SET process_state = ?, exit_code = ?, status = ?, ended_at = CASE WHEN ? = 'running' THEN ended_at ELSE COALESCE(ended_at, ?) END WHERE id = ?",
        )
        .run(processState, exitCode, status, processState, nowIso(), row.id);
      this.emitChanged(row.id, false);
    }
  }
}

/** Resolves a binary on the user's login-shell PATH; aliases (e.g. `alias claude='ensemble claude'`) are ignored. */
function loginShellWhich(name: string): Promise<string | null> {
  if (!/^[a-z0-9_-]+$/i.test(name)) return Promise.resolve(null);
  const shell = process.env["SHELL"] ?? "/bin/zsh";
  return new Promise((resolve) => {
    execFile(
      shell,
      ["-lc", `unalias -a 2>/dev/null; command -v ${name}`],
      {
        timeout: 10_000,
        env: { HOME: process.env["HOME"] ?? "", PATH: process.env["PATH"] ?? "" },
      },
      (error, stdout) => {
        const line = stdout.trim().split("\n").pop() ?? "";
        resolve(!error && line.startsWith("/") ? line : null);
      },
    );
  });
}

export { loginShellWhich };
