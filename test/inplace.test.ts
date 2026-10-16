import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listRepos } from "../server/repos.js";
import { validateCliArgs } from "../server/sessions.js";
import { INPLACE_WORKSPACE_NAME } from "../server/workspaces.js";
import { gitIn, makeTempRepo } from "./git-helpers.js";
import { FAKE_AGENT } from "./helpers-session.js";
import { makeTestApp, type TestEnv } from "./helpers.js";

async function waitFor<T>(
  fn: () => T | undefined | false | null,
  timeoutMs = 15_000,
  label = "condition",
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe("in-place workspaces (docs/plan-v2.md Phase 1)", () => {
  let env: TestEnv;
  let repoPath: string;
  const extraAgentEnv: Record<string, string> = {};

  beforeEach(async () => {
    env = await makeTestApp({ cliPath: FAKE_AGENT, extraAgentEnv });
    await env.app.start();
    repoPath = makeTempRepo();
  });
  afterEach(async () => {
    for (const k of Object.keys(extraAgentEnv)) delete extraAgentEnv[k];
    await env.cleanup();
    rmSync(repoPath, { recursive: true, force: true });
  });

  const workspaces = () => env.app.services.workspaces;
  const sessions = () => env.app.services.sessions;

  it("creates a ready workspace for the checkout, registers the repo, and reuses it", async () => {
    const ws = await workspaces().createInPlace({ path: repoPath, agent: "claude" });
    expect(ws).toMatchObject({
      kind: "inplace",
      status: "ready",
      name: INPLACE_WORKSPACE_NAME,
      branch: "main",
      baseBranch: "main",
      path: realpathSync(repoPath),
    });
    expect(ws.creation.steps.worktree).toBeUndefined();
    expect(ws.port).toBeGreaterThan(0);
    expect(listRepos(env.db)).toHaveLength(1);
    expect(existsSync(path.join(env.dir, "workspaces-root"))).toBe(false);

    // A subdirectory maps to the same checkout; a branch change is picked up on reuse.
    gitIn(repoPath, ["checkout", "-q", "-b", "feature/x"]);
    const sub = path.join(repoPath, "sub");
    gitIn(repoPath, ["init", "-q", "--bare", "unrelated"]); // noise in the tree
    writeFileSync(path.join(repoPath, "note.txt"), "x\n");
    rmSync(path.join(repoPath, "unrelated"), { recursive: true, force: true });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(sub);
    const again = await workspaces().createInPlace({ path: sub, agent: "codex" });
    expect(again.id).toBe(ws.id);
    expect(again.branch).toBe("feature/x");
    expect(workspaces().list()).toHaveLength(1);
  });

  it("returns the worktree workspace when run inside a worktree Ensemble created", async () => {
    const { registerRepo } = await import("../server/repos.js");
    const repo = await registerRepo(env.db, repoPath);
    const created = await workspaces().create({ repoId: repo.id, agent: "claude", name: "wt" });
    const ready = await workspaces().continue(created.id);
    expect(ready.status).toBe("ready");
    const found = await workspaces().createInPlace({ path: ready.path, agent: "claude" });
    expect(found.id).toBe(ready.id);
    expect(found.kind).toBe("worktree");
    expect(listRepos(env.db)).toHaveLength(1);
  });

  it("rejects a directory that is not inside a git repository", async () => {
    await expect(
      workspaces().createInPlace({ path: env.dir, agent: "claude" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      workspaces().createInPlace({ path: path.join(env.dir, "nope"), agent: "claude" }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("validates pass-through CLI arguments", () => {
    expect(validateCliArgs("claude", undefined)).toEqual([]);
    expect(validateCliArgs("claude", ["--model", "opus", "fix the tests"])).toEqual([
      "--model",
      "opus",
      "fix the tests",
    ]);
    for (const bad of [["-p", "hi"], ["--print"], ["--settings", "x"], ["--remote-control", "n"]])
      expect(() => validateCliArgs("claude", bad)).toThrow(/not allowed/);
    expect(() => validateCliArgs("claude", ["--settings=x"])).toThrow(/not allowed/);
    expect(() => validateCliArgs("codex", ["exec", "ls"])).toThrow(/not an interactive/);
    expect(() => validateCliArgs("codex", ["login"])).toThrow(/not an interactive/);
    expect(validateCliArgs("codex", ["--model", "o3", "resume"])).toHaveLength(3);
    expect(validateCliArgs("codex", ["say login"])).toEqual(["say login"]);
    expect(() => validateCliArgs("claude", ["a\0b"])).toThrow(/invalid/);
    expect(() => validateCliArgs("claude", "x" as unknown as string[])).toThrow();
    expect(() => validateCliArgs("claude", new Array(65).fill("a"))).toThrow(/at most/);
  });

  it("passes CLI arguments to the agent after Ensemble's own options and marks the session", async () => {
    const ws = await workspaces().createInPlace({ path: repoPath, agent: "claude" });
    const argvFile = path.join(env.dir, "argv.json");
    const envFile = path.join(env.dir, "env.json");
    extraAgentEnv["FAKE_ARGV_FILE"] = argvFile;
    extraAgentEnv["FAKE_ENV_FILE"] = envFile;
    const s = await sessions().launch({
      workspaceId: ws.id,
      agent: "claude",
      cliArgs: ["--model", "opus"],
    });
    await waitFor(() => existsSync(envFile), 15_000, "agent start");
    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    expect(argv[0]).toBe("--settings");
    expect(argv.slice(2)).toEqual(["--model", "opus"]);
    const seen = JSON.parse(readFileSync(envFile, "utf8")) as Record<string, boolean>;
    expect(seen["ENSEMBLE_INSIDE"]).toBe(true);
    expect(seen["ANTHROPIC_API_KEY"]).toBe(false);
    await expect(
      sessions().launch({ workspaceId: ws.id, agent: "claude", cliArgs: ["-p", "x"] }),
    ).rejects.toThrow(/not allowed/);
    await sessions().kill(s.id);
  });

  it("forgets an in-place workspace: stops sessions, removes nothing", async () => {
    const ws = await workspaces().createInPlace({ path: repoPath, agent: "claude" });
    const s = await sessions().launch({ workspaceId: ws.id, agent: "claude" });
    await waitFor(() => sessions().get(s.id).cliSessionId !== null, 15_000, "session start");
    writeFileSync(path.join(repoPath, ".env"), "SECRET=1\n");
    writeFileSync(path.join(repoPath, "README.md"), "# changed\n");
    writeFileSync(path.join(repoPath, "new.txt"), "untracked\n");
    await expect(env.app.services.archive.inventory(ws)).rejects.toMatchObject({
      statusCode: 409,
    });
    const record = await env.app.services.archive.archive(ws.id, {
      inventoryHash: "",
      forceDirty: false,
      ignored: {},
    });
    expect(record).toBeNull();
    expect(workspaces().get(ws.id)).toMatchObject({ status: "archived", error: null });
    expect(sessions().get(s.id).processState).not.toBe("running");
    expect(readFileSync(path.join(repoPath, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(readFileSync(path.join(repoPath, "README.md"), "utf8")).toBe("# changed\n");
    expect(existsSync(path.join(repoPath, "new.txt"))).toBe(true);
    expect(gitIn(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    // Launching again in the same checkout creates a fresh record.
    const fresh = await workspaces().createInPlace({ path: repoPath, agent: "claude" });
    expect(fresh.id).not.toBe(ws.id);
    expect(fresh.status).toBe("ready");
  });

  it("marks an in-place workspace archived when its checkout is gone at startup", async () => {
    const ws = await workspaces().createInPlace({ path: repoPath, agent: "claude" });
    rmSync(repoPath, { recursive: true, force: true });
    await workspaces().reconcile();
    expect(workspaces().get(ws.id)).toMatchObject({
      status: "archived",
      error: "checkout missing at startup",
    });
  });
});
