import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { statePaths } from "./config.js";
import { buildCopyPlan } from "./copy/plan.js";
import { runCopyPlan } from "./copy/run.js";
import type { Db } from "./db/index.js";
import { nowIso } from "./db/index.js";
import { git, GitError } from "./git.js";
import {
  branchNameFor,
  isValidWorkspaceName,
  pickWorkspaceName,
  sanitizeWorkspaceName,
} from "./names.js";
import { allocatePortBlock } from "./ports.js";
import { effectiveRepoConfig, getRepo, listRepos, type Repo } from "./repos.js";
import type { Tmux } from "./tmux.js";

export type WorkspaceStatus =
  | "pending_approval"
  | "creating"
  | "copying"
  | "setting_up"
  | "ready"
  | "setup_failed"
  | "archived";

export type Agent = "claude" | "codex";

export interface CreationRequest {
  agent: Agent;
  prompt?: string;
  remoteControl?: boolean;
}

export interface CreationState {
  request: CreationRequest;
  steps: {
    approval?: true;
    worktree?: { head: string };
    copy?: { count: number };
    setup?: { exitCode: number };
  };
}

export interface Workspace {
  id: string;
  repoId: string;
  name: string;
  branch: string;
  path: string;
  baseBranch: string;
  port: number;
  status: WorkspaceStatus;
  error: string | null;
  creation: CreationState;
  copyManifest: string[];
  pr: { number: number; url: string; state: string } | null;
  createdAt: string;
  archivedAt: string | null;
}

interface WorkspaceRow {
  id: string;
  repo_id: string;
  name: string;
  branch: string;
  path: string;
  base_branch: string;
  port: number;
  status: WorkspaceStatus;
  error: string | null;
  creation_json: string;
  copy_manifest_json: string;
  pr_number: number | null;
  pr_url: string | null;
  pr_state: string | null;
  created_at: string;
  archived_at: string | null;
}

function rowToWorkspace(r: WorkspaceRow): Workspace {
  return {
    id: r.id,
    repoId: r.repo_id,
    name: r.name,
    branch: r.branch,
    path: r.path,
    baseBranch: r.base_branch,
    port: r.port,
    status: r.status,
    error: r.error,
    creation: JSON.parse(r.creation_json) as CreationState,
    copyManifest: JSON.parse(r.copy_manifest_json) as string[],
    pr:
      r.pr_number !== null && r.pr_url !== null
        ? { number: r.pr_number, url: r.pr_url, state: r.pr_state ?? "" }
        : null,
    createdAt: r.created_at,
    archivedAt: r.archived_at,
  };
}

export interface CreateWorkspaceInput {
  repoId: string;
  baseBranch?: string;
  name?: string;
  agent: Agent;
  prompt?: string;
  remoteControl?: boolean;
}

export class WorkspaceError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export interface WorkspaceServiceDeps {
  db: Db;
  config: Config;
  stateDir: string;
  tmux: Tmux;
}

export const setupSessionName = (id: string) => `ens-setup-${id.slice(0, 8)}`;
export const runSessionName = (id: string) => `ens-run-${id.slice(0, 8)}`;

export function scriptEnv(ws: Workspace, repo: Repo): Record<string, string> {
  return {
    ENSEMBLE_WORKSPACE_NAME: ws.name,
    ENSEMBLE_WORKSPACE_PATH: ws.path,
    ENSEMBLE_ROOT_PATH: repo.path,
    ENSEMBLE_PORT: String(ws.port),
  };
}

/**
 * Workspace lifecycle: a persisted, resumable create operation (architecture §6.1).
 * Emits "changed" (workspace) and "setup-output" (workspaceId, chunk).
 */
export class WorkspaceService extends EventEmitter {
  private readonly db: Db;
  private readonly config: Config;
  private readonly stateDir: string;
  private readonly tmux: Tmux;
  private readonly inFlight = new Set<string>();

  constructor(deps: WorkspaceServiceDeps) {
    super();
    this.db = deps.db;
    this.config = deps.config;
    this.stateDir = deps.stateDir;
    this.tmux = deps.tmux;
  }

  list(): Workspace[] {
    return (
      this.db.prepare("SELECT * FROM workspaces ORDER BY created_at").all() as WorkspaceRow[]
    ).map(rowToWorkspace);
  }

  get(id: string): Workspace {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as
      WorkspaceRow | undefined;
    if (!row) throw new WorkspaceError("workspace not found", 404);
    return rowToWorkspace(row);
  }

  logDir(id: string): string {
    const dir = path.join(statePaths(this.stateDir).workspaces, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  setupLogPath(id: string): string {
    return path.join(this.logDir(id), "setup.log");
  }

  readSetupLog(id: string, maxBytes = 512 * 1024): string {
    const file = this.setupLogPath(id);
    if (!existsSync(file)) return "";
    const size = statSync(file).size;
    const text = readFileSync(file, "utf8");
    return size > maxBytes ? text.slice(-maxBytes) : text;
  }

  private update(id: string, fields: Partial<Record<keyof WorkspaceRow, unknown>>): Workspace {
    const keys = Object.keys(fields);
    if (keys.length > 0) {
      const sets = keys.map((k) => `${k} = ?`).join(", ");
      this.db
        .prepare(`UPDATE workspaces SET ${sets} WHERE id = ?`)
        .run(...keys.map((k) => fields[k as keyof WorkspaceRow]), id);
    }
    const ws = this.get(id);
    this.emit("changed", ws);
    return ws;
  }

  private setStatus(id: string, status: WorkspaceStatus, error: string | null = null): Workspace {
    return this.update(id, { status, error });
  }

  private saveCreation(id: string, creation: CreationState): void {
    this.db
      .prepare("UPDATE workspaces SET creation_json = ? WHERE id = ?")
      .run(JSON.stringify(creation), id);
  }

  /** Reserves name, branch, path and port in one transaction. Nothing touches the disk here. */
  async create(input: CreateWorkspaceInput): Promise<Workspace> {
    const repo = getRepo(this.db, input.repoId);
    if (!repo) throw new WorkspaceError("repo not found", 404);
    const baseBranch = input.baseBranch ?? repo.defaultBase;
    try {
      await git(["rev-parse", "--verify", "--quiet", `${baseBranch}^{commit}`], { cwd: repo.path });
    } catch {
      throw new WorkspaceError(
        `base branch ${JSON.stringify(baseBranch)} not found in ${repo.name}`,
      );
    }
    const taken = new Set(
      (
        this.db.prepare("SELECT name FROM workspaces WHERE repo_id = ?").all(repo.id) as Array<{
          name: string;
        }>
      ).map((r) => r.name),
    );
    let name: string;
    if (input.name !== undefined && input.name.trim() !== "") {
      name = sanitizeWorkspaceName(input.name);
      if (taken.has(name))
        throw new WorkspaceError(`workspace ${name} already exists in ${repo.name}`, 409);
    } else {
      name = pickWorkspaceName(taken);
    }
    if (!isValidWorkspaceName(name)) throw new WorkspaceError("invalid workspace name");
    const branch = branchNameFor(this.config.branchPrefix, name);
    try {
      await git(["check-ref-format", "--branch", branch], { cwd: repo.path });
    } catch {
      throw new WorkspaceError(`invalid branch name ${branch}`);
    }
    const wsPath = path.join(this.config.workspaceRoot, repo.slug, name);
    if (existsSync(wsPath)) throw new WorkspaceError(`${wsPath} already exists on disk`, 409);

    const creation: CreationState = {
      request: {
        agent: input.agent,
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(input.remoteControl !== undefined ? { remoteControl: input.remoteControl } : {}),
      },
      steps: {},
    };
    const id = randomUUID();
    const insert = this.db.transaction(() => {
      const port = allocatePortBlock(this.db, this.config.portBase);
      this.db
        .prepare(
          "INSERT INTO workspaces (id, repo_id, name, branch, path, base_branch, port, status, creation_json, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?)",
        )
        .run(
          id,
          repo.id,
          name,
          branch,
          wsPath,
          baseBranch,
          port,
          JSON.stringify(creation),
          nowIso(),
        );
    });
    insert();
    const ws = this.get(id);
    this.emit("changed", ws);
    return ws;
  }

  /** Runs the create operation from its first incomplete step. Safe to call again after any failure. */
  async continue(id: string): Promise<Workspace> {
    if (this.inFlight.has(id)) throw new WorkspaceError("operation already in progress", 409);
    this.inFlight.add(id);
    try {
      return await this.runSteps(id);
    } finally {
      this.inFlight.delete(id);
    }
  }

  private async runSteps(id: string): Promise<Workspace> {
    let ws = this.get(id);
    if (ws.status === "archived" || ws.status === "ready") return ws;
    const repo = getRepo(this.db, ws.repoId);
    if (!repo) throw new WorkspaceError("repo not found", 404);
    const creation = ws.creation;

    // approval
    const eff = effectiveRepoConfig(this.db, repo);
    if (eff.file.error) {
      return this.setStatus(id, "setup_failed", `.ensemble.json is invalid: ${eff.file.error}`);
    }
    if (eff.needsApproval) {
      return this.setStatus(id, "pending_approval", null);
    }
    creation.steps.approval = true;
    this.saveCreation(id, creation);

    // worktree
    if (!creation.steps.worktree) {
      ws = this.setStatus(id, "creating");
      try {
        const head = await this.ensureWorktree(repo, ws);
        creation.steps.worktree = { head };
        this.saveCreation(id, creation);
      } catch (e) {
        return this.setStatus(id, "setup_failed", `worktree: ${(e as Error).message}`);
      }
    }

    // copy
    if (!creation.steps.copy) {
      ws = this.setStatus(id, "copying");
      try {
        const plan = buildCopyPlan(eff.config.copy, repo.path, ws.path);
        await runCopyPlan(plan);
        const manifest = plan.entries.map((e) => e.relPath);
        this.db
          .prepare("UPDATE workspaces SET copy_manifest_json = ? WHERE id = ?")
          .run(JSON.stringify(manifest), id);
        creation.steps.copy = { count: manifest.length };
        this.saveCreation(id, creation);
      } catch (e) {
        return this.setStatus(id, "setup_failed", `copy: ${(e as Error).message}`);
      }
    }

    // setup
    if (!creation.steps.setup) {
      ws = this.setStatus(id, "setting_up");
      try {
        const exitCode = await this.runSetup(repo, ws, eff.config.setup);
        if (exitCode !== 0) {
          return this.setStatus(id, "setup_failed", `setup script exited with ${exitCode}`);
        }
        creation.steps.setup = { exitCode };
        this.saveCreation(id, creation);
      } catch (e) {
        return this.setStatus(id, "setup_failed", `setup: ${(e as Error).message}`);
      }
    }

    ws = this.setStatus(id, "ready");
    this.emit("ready", ws);
    return ws;
  }

  /** Retries only the setup step of a failed workspace. */
  async retrySetup(id: string): Promise<Workspace> {
    const ws = this.get(id);
    if (ws.status !== "setup_failed")
      throw new WorkspaceError("workspace is not in setup_failed", 409);
    const creation = ws.creation;
    delete creation.steps.setup;
    this.saveCreation(id, creation);
    this.update(id, { error: null });
    return this.continue(id);
  }

  private async ensureWorktree(repo: Repo, ws: Workspace): Promise<string> {
    const existing = await this.registeredWorktrees(repo);
    const found = existing.find((w) => w.path === ws.path);
    if (found) {
      if (found.branch !== ws.branch) {
        throw new Error(`${ws.path} is a worktree of ${found.branch}, expected ${ws.branch}`);
      }
      return found.head;
    }
    if (existsSync(ws.path)) {
      throw new Error(
        `${ws.path} exists but is not a registered worktree; remove it or choose another name`,
      );
    }
    let branchExists = true;
    try {
      await git(["rev-parse", "--verify", "--quiet", `refs/heads/${ws.branch}`], {
        cwd: repo.path,
      });
    } catch {
      branchExists = false;
    }
    if (branchExists) {
      throw new Error(`branch ${ws.branch} already exists; delete it or choose another name`);
    }
    mkdirSync(path.dirname(ws.path), { recursive: true });
    await git(["worktree", "add", "-b", ws.branch, ws.path, ws.baseBranch], { cwd: repo.path });
    return git(["rev-parse", "HEAD"], { cwd: ws.path });
  }

  async registeredWorktrees(
    repo: Repo,
  ): Promise<Array<{ path: string; head: string; branch: string }>> {
    const out = await git(["worktree", "list", "--porcelain"], { cwd: repo.path });
    const result: Array<{ path: string; head: string; branch: string }> = [];
    let current: { path: string; head: string; branch: string } | null = null;
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) {
        current = { path: line.slice(9), head: "", branch: "" };
        result.push(current);
      } else if (current && line.startsWith("HEAD ")) current.head = line.slice(5);
      else if (current && line.startsWith("branch "))
        current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    }
    return result;
  }

  /** Runs the approved setup script in its own tmux session, streaming its log; resolves with the exit code. */
  private async runSetup(repo: Repo, ws: Workspace, script: string | null): Promise<number> {
    if (script === null) return 0;
    const name = setupSessionName(ws.id);
    const logFile = this.setupLogPath(ws.id);
    const pane = await this.tmux.pane(name);
    if (!pane) {
      await this.tmux.newSession({
        name,
        cwd: ws.path,
        env: scriptEnv(ws, repo),
        command: [process.env["SHELL"] ?? "/bin/zsh", "-lc", script],
        logFile,
      });
    } else if (pane.dead) {
      // A previous attempt already finished (e.g. before a restart): reuse its result.
      const code = pane.deadStatus ?? 1;
      await this.tmux.killSession(name);
      return code;
    }
    const stop = this.streamLog(ws.id, logFile);
    try {
      const code = await this.tmux.waitForExit(name);
      return code ?? 1;
    } finally {
      stop();
      await this.tmux.killSession(name);
    }
  }

  private streamLog(id: string, file: string): () => void {
    let offset = 0;
    const tick = () => {
      try {
        const size = statSync(file).size;
        if (size > offset) {
          const text = readFileSync(file, "utf8");
          this.emit("setup-output", id, text.slice(offset));
          offset = size;
        }
      } catch {
        /* not yet created */
      }
    };
    const timer = setInterval(tick, 300);
    return () => {
      clearInterval(timer);
      tick();
    };
  }

  markArchived(id: string, error: string | null): Workspace {
    return this.update(id, { status: "archived", archived_at: nowIso(), error });
  }

  setError(id: string, error: string | null): Workspace {
    return this.update(id, { error });
  }

  rename(id: string, newName: string): Workspace {
    const ws = this.get(id);
    const name = sanitizeWorkspaceName(newName);
    const clash = this.db
      .prepare("SELECT 1 FROM workspaces WHERE repo_id = ? AND name = ? AND id != ?")
      .get(ws.repoId, name, id);
    if (clash) throw new WorkspaceError(`workspace ${name} already exists`, 409);
    return this.update(id, { name });
  }

  /**
   * Startup reconcile (§6.4): prune stale worktree metadata, mark workspaces whose worktree
   * vanished, and re-enter interrupted create operations.
   */
  async reconcile(): Promise<void> {
    for (const repo of listRepos(this.db)) {
      let registered: Array<{ path: string }>;
      try {
        await git(["worktree", "prune"], { cwd: repo.path });
        registered = await this.registeredWorktrees(repo);
      } catch (e) {
        if (e instanceof GitError) continue; // repo path gone; leave rows untouched
        throw e;
      }
      const paths = new Set(registered.map((w) => w.path));
      for (const ws of this.list().filter((w) => w.repoId === repo.id && w.status !== "archived")) {
        if (ws.creation.steps.worktree && !paths.has(ws.path)) {
          this.update(id(ws), {
            status: "archived",
            archived_at: nowIso(),
            error: "worktree missing at startup",
          });
          continue;
        }
        if (ws.status === "creating" || ws.status === "copying" || ws.status === "setting_up") {
          await this.continue(ws.id).catch((e: Error) =>
            this.setStatus(ws.id, "setup_failed", e.message),
          );
        }
      }
    }
  }
}

const id = (ws: Workspace) => ws.id;
