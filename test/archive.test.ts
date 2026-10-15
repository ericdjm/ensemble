import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArchiveConflict, ArchiveService } from "../server/archive.js";
import { defaultConfig, ensureStateDirs } from "../server/config.js";
import { openDb, type Db } from "../server/db/index.js";
import { approveScripts, effectiveRepoConfig, registerRepo, type Repo } from "../server/repos.js";
import { Tmux } from "../server/tmux.js";
import { WorkspaceService, type Workspace } from "../server/workspaces.js";
import { gitIn, makeTempRepo } from "./git-helpers.js";

describe("archive", () => {
  let dir: string;
  let db: Db;
  let repoPath: string;
  let repo: Repo;
  let tmux: Tmux;
  let workspaces: WorkspaceService;
  let archive: ArchiveService;
  let outside: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "ensemble-arch-"));
    ensureStateDirs(dir);
    outside = path.join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "target.txt"), "outside\n");
    db = openDb(path.join(dir, "t.db"));
    repoPath = makeTempRepo();
    writeFileSync(path.join(repoPath, ".env"), "SECRET=1\n");
    repo = await registerRepo(db, repoPath);
    const config = defaultConfig("t".repeat(32), 50000);
    config.workspaceRoot = path.join(dir, "root");
    tmux = new Tmux({ socketName: `ensemble-arch-test-${process.pid}` });
    workspaces = new WorkspaceService({ db, config, stateDir: dir, tmux });
    archive = new ArchiveService({ db, config, stateDir: dir, tmux, workspaces });
  });

  afterEach(async () => {
    await tmux.killServer();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  });

  async function readyWorkspace(
    cfg: Record<string, unknown> = { copy: [".env"] },
  ): Promise<Workspace> {
    writeFileSync(path.join(repoPath, ".ensemble.json"), JSON.stringify(cfg));
    const eff = effectiveRepoConfig(db, repo);
    approveScripts(
      db,
      repo,
      eff.scripts
        .filter((s) => s.script !== null)
        .map((s) => ({ kind: s.kind, hash: s.hash as string })),
    );
    const created = await workspaces.create({ repoId: repo.id, agent: "claude", name: "arch" });
    const ws = await workspaces.continue(created.id);
    expect(ws.status).toBe("ready");
    return ws;
  }

  it("preserves a modified ignored .env from a git-clean worktree and requires explicit decisions", async () => {
    const ws = await readyWorkspace();
    writeFileSync(path.join(ws.path, ".env"), "SECRET=changed\n");
    mkdirSync(path.join(ws.path, "node_modules", "pkg"), { recursive: true });
    writeFileSync(path.join(ws.path, "node_modules", "pkg", "index.js"), "x");
    symlinkSync(path.join(outside, "target.txt"), path.join(ws.path, ".env.link"));
    expect(gitIn(ws.path, ["status", "--porcelain"])).toBe("");

    const inv = await archive.inventory(ws);
    expect(inv.tracked).toEqual([]);
    expect(inv.untracked).toEqual([]);
    expect(inv.ignored.map((e) => e.path)).toEqual([".env", ".env.link", "node_modules"]);
    expect(inv.ignored.find((e) => e.path === ".env")).toMatchObject({
      fromCopyManifest: true,
      symlink: false,
    });
    expect(inv.ignored.find((e) => e.path === "node_modules")).toMatchObject({ directory: true });
    expect(inv.symlinks).toEqual([".env.link"]);

    // Generic confirmation is not enough: every ignored file needs a decision.
    await expect(
      archive.archive(ws.id, { inventoryHash: inv.hash, forceDirty: true, ignored: {} }),
    ).rejects.toThrow(/no keep\/discard decision for ignored file \.env/);
    expect(existsSync(ws.path)).toBe(true);

    const record = await archive.archive(ws.id, {
      inventoryHash: inv.hash,
      forceDirty: false,
      ignored: { ".env": "keep", node_modules: "discard" },
    });
    expect(record).not.toBeNull();
    expect(record?.manifest).toHaveLength(1);
    expect(record?.manifest[0]).toMatchObject({ relPath: ".env", size: 15 });
    expect(readFileSync(path.join(record?.recoveryDir ?? "", "files", ".env"), "utf8")).toBe(
      "SECRET=changed\n",
    );
    expect(existsSync(ws.path)).toBe(false);
    expect(workspaces.get(ws.id).status).toBe("archived");
    expect(readFileSync(path.join(outside, "target.txt"), "utf8")).toBe("outside\n");
    expect(gitIn(repoPath, ["branch", "--list", "ens/arch"])).toContain("ens/arch");

    // Restore and branch deletion.
    const target = path.join(dir, "restore-target");
    mkdirSync(target);
    expect(await archive.restore(record?.id ?? "", target)).toBe(1);
    expect(readFileSync(path.join(target, ".env"), "utf8")).toBe("SECRET=changed\n");
    await archive.deleteBranch(ws.id);
    expect(gitIn(repoPath, ["branch", "--list", "ens/arch"])).toBe("");
    archive.deleteArchiveFiles(record?.id ?? "");
    expect(existsSync(record?.recoveryDir ?? "")).toBe(false);
  });

  it("refuses dirty worktrees without force and keeps everything intact", async () => {
    const ws = await readyWorkspace({});
    writeFileSync(path.join(ws.path, "README.md"), "modified\n");
    writeFileSync(path.join(ws.path, "notes.txt"), "untracked\n");
    const inv = await archive.inventory(ws);
    expect(inv.tracked).toEqual(["README.md"]);
    expect(inv.untracked).toEqual(["notes.txt"]);
    await expect(
      archive.archive(ws.id, { inventoryHash: inv.hash, forceDirty: false, ignored: {} }),
    ).rejects.toThrow(/confirm their forced removal/);
    expect(existsSync(ws.path)).toBe(true);
    await archive.archive(ws.id, { inventoryHash: inv.hash, forceDirty: true, ignored: {} });
    expect(existsSync(ws.path)).toBe(false);
  });

  it("rejects a stale inventory hash", async () => {
    const ws = await readyWorkspace({});
    const inv = await archive.inventory(ws);
    writeFileSync(path.join(ws.path, "late.txt"), "late\n");
    await expect(
      archive.archive(ws.id, { inventoryHash: inv.hash, forceDirty: true, ignored: {} }),
    ).rejects.toThrow(ArchiveConflict);
    expect(existsSync(ws.path)).toBe(true);
  });

  it("stops when the archive script fails and keeps the worktree", async () => {
    const ws = await readyWorkspace({ copy: [".env"], archive: "exit 5" });
    const inv = await archive.inventory(ws);
    await expect(
      archive.archive(ws.id, {
        inventoryHash: inv.hash,
        forceDirty: false,
        ignored: { ".env": "keep" },
      }),
    ).rejects.toThrow(/archive script exited with 5/);
    expect(existsSync(ws.path)).toBe(true);
    expect(workspaces.get(ws.id).status).toBe("ready");
    expect(workspaces.get(ws.id).error).toMatch(/worktree kept/);
    // Preservation happened before the script and is retained.
    expect(archive.listArchives(ws.id)).toHaveLength(1);
  });

  it("stops when new files appear after preservation and before removal", async () => {
    const ws = await readyWorkspace();
    const inv = await archive.inventory(ws);
    await expect(
      archive.archive(
        ws.id,
        { inventoryHash: inv.hash, forceDirty: false, ignored: { ".env": "keep" } },
        { beforeRescan: (w) => writeFileSync(path.join(w.path, ".env.new"), "NEW=1\n") },
      ),
    ).rejects.toThrow(/changed during archiving/);
    expect(existsSync(ws.path)).toBe(true);
    expect(workspaces.get(ws.id).status).toBe("ready");
  });

  it("stops when a preserved file changes before removal", async () => {
    const ws = await readyWorkspace();
    const inv = await archive.inventory(ws);
    await expect(
      archive.archive(
        ws.id,
        { inventoryHash: inv.hash, forceDirty: false, ignored: { ".env": "keep" } },
        { beforeRescan: (w) => writeFileSync(path.join(w.path, ".env"), "SECRET=edited-late\n") },
      ),
    ).rejects.toThrow(/changed after it was preserved/);
    expect(existsSync(ws.path)).toBe(true);
  });
});
