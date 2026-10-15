import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { statePaths } from "./config.js";
import { buildCopyPlanForPaths } from "./copy/plan.js";
import { runCopyPlan } from "./copy/run.js";
import type { Db } from "./db/index.js";
import { nowIso } from "./db/index.js";
import { git } from "./git.js";
import { effectiveRepoConfig, getRepo, type Repo } from "./repos.js";
import type { Tmux } from "./tmux.js";
import { scriptEnv, WorkspaceError, type Workspace, type WorkspaceService } from "./workspaces.js";
import type {
  ArchiveDecisions,
  ArchiveInventory,
  ArchiveRecord,
  IgnoredEntry,
  ManifestEntry,
} from "../shared/types.js";
export type { IgnoredEntry, ArchiveInventory, ArchiveDecisions, ManifestEntry, ArchiveRecord };

export class ArchiveConflict extends WorkspaceError {
  constructor(
    message: string,
    public readonly inventory: ArchiveInventory,
  ) {
    super(message, 409);
    this.name = "ArchiveConflict";
  }
}

export const archiveSessionName = (id: string) => `ens-archive-${id.slice(0, 8)}`;

function parseZ(out: string): string[] {
  return out.split("\0").filter((s) => s.length > 0);
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export interface ArchiveServiceDeps {
  db: Db;
  config: Config;
  stateDir: string;
  tmux: Tmux;
  workspaces: WorkspaceService;
}

export interface ArchiveHooks {
  /** Test-only: runs after preservation and the archive script, before the final rescan. */
  beforeRescan?: (ws: Workspace) => void;
}

/** Archive workflow (architecture §6.3). */
export class ArchiveService {
  private readonly db: Db;
  private readonly stateDir: string;
  private readonly tmux: Tmux;
  private readonly workspaces: WorkspaceService;
  private readonly inFlight = new Set<string>();
  private readonly stoppers: Array<(workspaceId: string) => Promise<void>> = [];

  constructor(deps: ArchiveServiceDeps) {
    this.db = deps.db;
    this.stateDir = deps.stateDir;
    this.tmux = deps.tmux;
    this.workspaces = deps.workspaces;
  }

  /** Registers a callback that stops a workspace's processes (agent sessions register here). */
  registerStopper(fn: (workspaceId: string) => Promise<void>): void {
    this.stoppers.push(fn);
  }

  async inventory(ws: Workspace): Promise<ArchiveInventory> {
    if (!existsSync(ws.path)) throw new WorkspaceError("worktree path does not exist", 409);
    const statusOut = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: ws.path,
    });
    const tracked: string[] = [];
    const untracked: string[] = [];
    const tokens = parseZ(statusOut);
    for (let i = 0; i < tokens.length; i++) {
      const entry = tokens[i] as string;
      const xy = entry.slice(0, 2);
      const file = entry.slice(3);
      if (xy === "??") untracked.push(file);
      else if (xy !== "!!") {
        tracked.push(file);
        if (xy[0] === "R" || xy[0] === "C") i++; // skip the rename source
      }
    }
    const ignoredOut = await git(
      ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
      {
        cwd: ws.path,
      },
    );
    const manifest = new Set(ws.copyManifest);
    const symlinks: string[] = [];
    const ignored: IgnoredEntry[] = parseZ(ignoredOut).map((raw) => {
      const directory = raw.endsWith("/");
      const rel = directory ? raw.slice(0, -1) : raw;
      let symlink = false;
      let size: number | null = null;
      try {
        const st = lstatSync(path.join(ws.path, rel));
        symlink = st.isSymbolicLink();
        if (st.isFile()) size = st.size;
      } catch {
        /* vanished */
      }
      if (symlink) symlinks.push(rel);
      return { path: rel, directory, symlink, size, fromCopyManifest: manifest.has(rel) };
    });
    for (const u of untracked) {
      try {
        if (lstatSync(path.join(ws.path, u)).isSymbolicLink()) symlinks.push(u);
      } catch {
        /* vanished */
      }
    }
    tracked.sort();
    untracked.sort();
    ignored.sort((a, b) => (a.path < b.path ? -1 : 1));
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          tracked,
          untracked,
          ignored: ignored.map((e) => [e.path, e.directory, e.symlink]),
        }),
      )
      .digest("hex");
    return { tracked, untracked, ignored, symlinks, hash };
  }

  private validateDecisions(inv: ArchiveInventory, d: ArchiveDecisions): string[] {
    if (d.inventoryHash !== inv.hash)
      throw new ArchiveConflict("the workspace changed since the preflight; review it again", inv);
    const dirty = inv.tracked.length + inv.untracked.length > 0;
    if (dirty && !d.forceDirty) {
      throw new WorkspaceError(
        "workspace has tracked modifications or untracked files; confirm their forced removal explicitly",
      );
    }
    const keep: string[] = [];
    for (const entry of inv.ignored) {
      if (entry.symlink) continue;
      const decision = d.ignored[entry.path];
      if (decision !== "keep" && decision !== "discard") {
        throw new WorkspaceError(`no keep/discard decision for ignored file ${entry.path}`);
      }
      if (decision === "keep") keep.push(entry.path);
    }
    return keep;
  }

  async archive(
    workspaceId: string,
    decisions: ArchiveDecisions,
    hooks: ArchiveHooks = {},
  ): Promise<ArchiveRecord | null> {
    if (this.inFlight.has(workspaceId))
      throw new WorkspaceError("archive already in progress", 409);
    this.inFlight.add(workspaceId);
    try {
      return await this.run(workspaceId, decisions, hooks);
    } finally {
      this.inFlight.delete(workspaceId);
    }
  }

  private async run(
    workspaceId: string,
    decisions: ArchiveDecisions,
    hooks: ArchiveHooks,
  ): Promise<ArchiveRecord | null> {
    const ws = this.workspaces.get(workspaceId);
    if (ws.status === "archived") throw new WorkspaceError("already archived", 409);
    if (!ws.creation.steps.worktree) {
      // Nothing was ever created on disk; just mark it.
      this.workspaces.markArchived(ws.id, null);
      return null;
    }
    const repo = getRepo(this.db, ws.repoId);
    if (!repo) throw new WorkspaceError("repo not found", 404);

    // 2. stop processes, then rescan against the decisions the user made.
    await this.stopProcesses(ws);
    const inv = await this.inventory(ws);
    const keep = this.validateDecisions(inv, decisions);

    // 3. preserve kept files, verified by hash.
    let record: ArchiveRecord | null = null;
    if (keep.length > 0) {
      record = await this.preserve(ws, keep);
    }

    // 4. archive script.
    const eff = effectiveRepoConfig(this.db, repo);
    const archiveScript = eff.scripts.find((s) => s.kind === "archive");
    if (archiveScript && archiveScript.script !== null) {
      if (!archiveScript.approved) throw new WorkspaceError("archive script is not approved", 409);
      const code = await this.runArchiveScript(ws, repo, archiveScript.script);
      if (code !== 0) {
        this.workspaces.setError(ws.id, `archive script exited with ${code}; worktree kept`);
        throw new WorkspaceError(`archive script exited with ${code}; worktree kept`, 409);
      }
    }

    hooks.beforeRescan?.(ws);

    // 5. final rescan; anything new or changed needs a new decision.
    const again = await this.inventory(ws);
    if (again.hash !== inv.hash) {
      throw new ArchiveConflict("files changed during archiving; review the new inventory", again);
    }
    if (record) this.verifyManifest(ws, record);

    const args = ["worktree", "remove"];
    if (decisions.forceDirty) args.push("--force");
    args.push(ws.path);
    try {
      await git(args, { cwd: repo.path });
    } catch (e) {
      this.workspaces.setError(ws.id, `worktree remove failed: ${(e as Error).message}`);
      throw new WorkspaceError(`worktree remove failed: ${(e as Error).message}`, 409);
    }
    this.workspaces.markArchived(ws.id, null);
    return record;
  }

  private async stopProcesses(ws: Workspace): Promise<void> {
    for (const name of [`ens-setup-${ws.id.slice(0, 8)}`, `ens-run-${ws.id.slice(0, 8)}`]) {
      await this.tmux.killSession(name);
    }
    for (const stop of this.stoppers) await stop(ws.id);
  }

  private async preserve(ws: Workspace, keep: string[]): Promise<ArchiveRecord> {
    const id = randomUUID();
    const recoveryDir = path.join(statePaths(this.stateDir).archives, ws.id, id);
    const filesDir = path.join(recoveryDir, "files");
    mkdirSync(filesDir, { recursive: true, mode: 0o700 });
    const { plan } = buildCopyPlanForPaths(keep, ws.path, filesDir);
    await runCopyPlan(plan);
    const manifest: ManifestEntry[] = plan.entries.map((e) => {
      const copied = path.join(filesDir, e.relPath);
      const sha = sha256File(copied);
      if (sha256File(path.join(ws.path, e.relPath)) !== sha) {
        throw new WorkspaceError(`preservation verification failed for ${e.relPath}`, 409);
      }
      return { relPath: e.relPath, size: statSync(copied).size, sha256: sha, mode: e.mode };
    });
    const record: ArchiveRecord = {
      id,
      workspaceId: ws.id,
      recoveryDir,
      manifest,
      createdAt: nowIso(),
      deletedAt: null,
    };
    this.db
      .prepare(
        "INSERT INTO archives (id, workspace_id, recovery_dir, manifest_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, ws.id, recoveryDir, JSON.stringify(manifest), record.createdAt);
    return record;
  }

  private verifyManifest(ws: Workspace, record: ArchiveRecord): void {
    for (const entry of record.manifest) {
      const source = path.join(ws.path, entry.relPath);
      if (!existsSync(source) || sha256File(source) !== entry.sha256) {
        throw new ArchiveConflict(`${entry.relPath} changed after it was preserved; review again`, {
          tracked: [],
          untracked: [],
          ignored: [],
          symlinks: [],
          hash: "",
        });
      }
    }
  }

  private async runArchiveScript(ws: Workspace, repo: Repo, script: string): Promise<number> {
    const name = archiveSessionName(ws.id);
    await this.tmux.killSession(name);
    await this.tmux.newSession({
      name,
      cwd: ws.path,
      env: scriptEnv(ws, repo),
      command: [process.env["SHELL"] ?? "/bin/zsh", "-lc", script],
    });
    try {
      return (await this.tmux.waitForExit(name)) ?? 1;
    } finally {
      await this.tmux.killSession(name);
    }
  }

  listArchives(workspaceId?: string): ArchiveRecord[] {
    const rows = (
      workspaceId
        ? this.db
            .prepare("SELECT * FROM archives WHERE workspace_id = ? ORDER BY created_at DESC")
            .all(workspaceId)
        : this.db.prepare("SELECT * FROM archives ORDER BY created_at DESC").all()
    ) as Array<{
      id: string;
      workspace_id: string;
      recovery_dir: string;
      manifest_json: string;
      created_at: string;
      deleted_at: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      recoveryDir: r.recovery_dir,
      manifest: JSON.parse(r.manifest_json) as ManifestEntry[],
      createdAt: r.created_at,
      deletedAt: r.deleted_at,
    }));
  }

  getArchive(id: string): ArchiveRecord {
    const rec = this.listArchives().find((a) => a.id === id);
    if (!rec) throw new WorkspaceError("archive not found", 404);
    return rec;
  }

  /** Copies preserved files into an existing directory through the pinned worker. */
  async restore(id: string, targetDir: string): Promise<number> {
    const rec = this.getArchive(id);
    if (rec.deletedAt) throw new WorkspaceError("archive files were deleted", 409);
    if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
      throw new WorkspaceError("restore target must be an existing directory");
    }
    const filesDir = path.join(rec.recoveryDir, "files");
    const { plan } = buildCopyPlanForPaths(
      rec.manifest.map((m) => m.relPath),
      filesDir,
      targetDir,
    );
    await runCopyPlan(plan);
    return plan.entries.length;
  }

  deleteArchiveFiles(id: string): void {
    const rec = this.getArchive(id);
    rmSync(rec.recoveryDir, { recursive: true, force: true });
    this.db.prepare("UPDATE archives SET deleted_at = ? WHERE id = ?").run(nowIso(), id);
  }

  async deleteBranch(workspaceId: string): Promise<void> {
    const ws = this.workspaces.get(workspaceId);
    if (ws.status !== "archived") throw new WorkspaceError("archive the workspace first", 409);
    const repo = getRepo(this.db, ws.repoId);
    if (!repo) throw new WorkspaceError("repo not found", 404);
    await git(["branch", "-D", ws.branch], { cwd: repo.path });
  }
}
