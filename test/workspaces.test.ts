import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, ensureStateDirs } from "../server/config.js";
import { openDb, type Db } from "../server/db/index.js";
import { approveScripts, effectiveRepoConfig, registerRepo, type Repo } from "../server/repos.js";
import { scriptHash } from "../server/repo-config.js";
import { Tmux } from "../server/tmux.js";
import { WorkspaceService } from "../server/workspaces.js";
import { gitIn, makeTempRepo } from "./git-helpers.js";

describe("workspace lifecycle", () => {
  let dir: string;
  let db: Db;
  let repoPath: string;
  let repo: Repo;
  let tmux: Tmux;
  let svc: WorkspaceService;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "ensemble-ws-"));
    ensureStateDirs(dir);
    db = openDb(path.join(dir, "t.db"));
    repoPath = makeTempRepo();
    writeFileSync(path.join(repoPath, ".env"), "SECRET=1\n");
    repo = await registerRepo(db, repoPath);
    const config = defaultConfig("t".repeat(32), 50000);
    config.workspaceRoot = path.join(dir, "root");
    tmux = new Tmux({ socketName: `ensemble-ws-test-${process.pid}` });
    svc = new WorkspaceService({ db, config, stateDir: dir, tmux });
  });

  afterEach(async () => {
    await tmux.killServer();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  });

  function approveAll() {
    const eff = effectiveRepoConfig(db, repo);
    approveScripts(
      db,
      repo,
      eff.scripts
        .filter((s) => s.script !== null)
        .map((s) => ({ kind: s.kind, hash: s.hash as string })),
    );
  }

  it("creates a worktree, copies .env, runs setup with ENSEMBLE_* env, and becomes ready", async () => {
    writeFileSync(
      path.join(repoPath, ".ensemble.json"),
      JSON.stringify({
        setup: 'echo "port=$ENSEMBLE_PORT name=$ENSEMBLE_WORKSPACE_NAME" > setup-ran.txt',
        copy: [".env"],
      }),
    );
    approveAll();
    const created = await svc.create({ repoId: repo.id, agent: "claude", name: "Allegro" });
    expect(created.name).toBe("allegro");
    expect(created.branch).toBe("ens/allegro");
    expect(created.port).toBe(41000);
    expect(created.status).toBe("creating");
    expect(existsSync(created.path)).toBe(false);

    const ws = await svc.continue(created.id);
    expect(ws.status).toBe("ready");
    expect(ws.error).toBeNull();
    expect(readFileSync(path.join(ws.path, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(ws.copyManifest).toEqual([".env"]);
    expect(readFileSync(path.join(ws.path, "setup-ran.txt"), "utf8")).toBe(
      "port=41000 name=allegro\n",
    );
    expect(gitIn(ws.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("ens/allegro");
    expect(svc.readSetupLog(ws.id)).toBeDefined();
  });

  it("waits for approval without touching disk, then resumes without repeating steps", async () => {
    writeFileSync(
      path.join(repoPath, ".ensemble.json"),
      JSON.stringify({ setup: "touch setup-ran.txt" }),
    );
    const created = await svc.create({ repoId: repo.id, agent: "codex" });
    let ws = await svc.continue(created.id);
    expect(ws.status).toBe("pending_approval");
    expect(existsSync(ws.path)).toBe(false);

    approveScripts(db, repo, [{ kind: "setup", hash: scriptHash("touch setup-ran.txt") }]);
    ws = await svc.continue(created.id);
    expect(ws.status).toBe("ready");
    expect(ws.creation.steps.worktree).toBeDefined();
    expect(existsSync(path.join(ws.path, "setup-ran.txt"))).toBe(true);

    // Calling continue again on a ready workspace is a no-op.
    expect((await svc.continue(created.id)).status).toBe("ready");
  });

  it("records setup failure, keeps the worktree, and retries only setup", async () => {
    writeFileSync(
      path.join(repoPath, ".ensemble.json"),
      JSON.stringify({ setup: "test -f go.txt" }),
    );
    approveAll();
    const created = await svc.create({ repoId: repo.id, agent: "claude" });
    let ws = await svc.continue(created.id);
    expect(ws.status).toBe("setup_failed");
    expect(ws.error).toMatch(/exited with 1/);
    expect(existsSync(ws.path)).toBe(true);
    const head = ws.creation.steps.worktree?.head;

    writeFileSync(path.join(ws.path, "go.txt"), "");
    ws = await svc.retrySetup(created.id);
    expect(ws.status).toBe("ready");
    expect(ws.creation.steps.worktree?.head).toBe(head);
  });

  it("fails closed on an unsafe copy pattern even with approved scripts", async () => {
    writeFileSync(
      path.join(repoPath, ".ensemble.json"),
      JSON.stringify({ setup: "true", copy: ["../outside"] }),
    );
    const created = await svc.create({ repoId: repo.id, agent: "claude" });
    const ws = await svc.continue(created.id);
    expect(ws.status).toBe("setup_failed");
    expect(ws.error).toMatch(/\.ensemble\.json is invalid/);
  });

  it("rejects duplicate names, bad base branches, and existing paths", async () => {
    await svc.create({ repoId: repo.id, agent: "claude", name: "dup" });
    await expect(svc.create({ repoId: repo.id, agent: "claude", name: "dup" })).rejects.toThrow(
      /already exists/,
    );
    await expect(
      svc.create({ repoId: repo.id, agent: "claude", baseBranch: "nope" }),
    ).rejects.toThrow(/not found/);
    await expect(svc.create({ repoId: "missing", agent: "claude" })).rejects.toThrow(
      /repo not found/,
    );
  });

  it("reconciles missing worktrees and resumes interrupted creations", async () => {
    const created = await svc.create({ repoId: repo.id, agent: "claude", name: "gone" });
    let ws = await svc.continue(created.id);
    expect(ws.status).toBe("ready");
    rmSync(ws.path, { recursive: true, force: true });

    const other = await svc.create({ repoId: repo.id, agent: "claude", name: "interrupted" });
    db.prepare("UPDATE workspaces SET status = 'creating' WHERE id = ?").run(other.id);

    await svc.reconcile();
    ws = svc.get(created.id);
    expect(ws.status).toBe("archived");
    expect(ws.error).toMatch(/missing/);
    expect(svc.get(other.id).status).toBe("ready");
  });

  it("renames without touching branch or path", async () => {
    const created = await svc.create({ repoId: repo.id, agent: "claude", name: "old" });
    const ws = svc.rename(created.id, "New Name");
    expect(ws.name).toBe("new-name");
    expect(ws.branch).toBe("ens/old");
  });
});
