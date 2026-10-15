import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePrView } from "../server/pr.js";
import { registerRepo } from "../server/repos.js";
import type { Workspace } from "../shared/types.js";
import { gitIn, makeTempRepo } from "./git-helpers.js";
import { FAKE_AGENT } from "./helpers-session.js";
import { login, makeTestApp, type TestEnv } from "./helpers.js";

const FAKE_GH = path.join(import.meta.dirname, "fixtures", "fake-gh.mjs");

describe("PR flow through gh", () => {
  let env: TestEnv;
  let repoPath: string;
  let bare: string;
  let ws: Workspace;
  let stateFile: string;
  let logFile: string;

  beforeEach(async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ensemble-gh-"));
    stateFile = path.join(tmp, "gh-state.json");
    logFile = path.join(tmp, "gh-log.jsonl");
    env = await makeTestApp({
      cliPath: FAKE_AGENT,
      ghBinary: FAKE_GH,
      ghEnv: { FAKE_GH_STATE: stateFile, FAKE_GH_LOG: logFile },
    });
    await env.app.start();
    repoPath = makeTempRepo();
    bare = mkdtempSync(path.join(os.tmpdir(), "ensemble-bare-"));
    execFileSync("git", ["init", "-q", "--bare", bare]);
    gitIn(repoPath, ["remote", "add", "origin", bare]);
    gitIn(repoPath, ["push", "-q", "-u", "origin", "main"]);
    const repo = await registerRepo(env.db, repoPath);
    const created = await env.app.services.workspaces.create({
      repoId: repo.id,
      agent: "claude",
      name: "prflow",
    });
    ws = await env.app.services.workspaces.continue(created.id);
    writeFileSync(path.join(ws.path, "feature.txt"), "feature\n");
    gitIn(ws.path, ["add", "feature.txt"]);
    gitIn(ws.path, ["commit", "-q", "-m", "feat: feature"]);
  });
  afterEach(async () => {
    await env.cleanup();
    rmSync(repoPath, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
    rmSync(path.dirname(stateFile), { recursive: true, force: true });
  });

  const ghCalls = () =>
    readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as string[]);

  it("pushes the branch to origin", async () => {
    const r = await env.app.services.pr.push(ws.id);
    expect(r.branch).toBe("ens/prflow");
    expect(
      execFileSync("git", ["--git-dir", bare, "branch", "--list", "ens/prflow"]).toString(),
    ).toContain("ens/prflow");
  });

  it("creates, views, polls, and merges a PR, never handling tokens", async () => {
    const cookie = await login(env);
    let res = await env.app.fastify.inject({
      method: "GET",
      url: `/api/workspaces/${ws.id}/pr`,
      headers: { host: env.host, cookie },
    });
    expect(res.statusCode).toBe(404);

    res = await env.app.fastify.inject({
      method: "POST",
      url: `/api/workspaces/${ws.id}/pr`,
      headers: { host: env.host, cookie },
      payload: { title: "Add feature", body: "Adds feature.txt", draft: true },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      number: 1,
      state: "OPEN",
      isDraft: true,
      title: "Add feature",
      baseRefName: "main",
    });
    const create = ghCalls().find((c) => c[0] === "pr" && c[1] === "create");
    expect(create).toContain("--head");
    expect(create?.[create.indexOf("--head") + 1]).toBe("ens/prflow");
    expect(create).toContain("--draft");
    expect(env.app.services.workspaces.get(ws.id).pr).toMatchObject({
      number: 1,
      url: "https://github.com/example/repo/pull/1",
    });
    expect(JSON.stringify(ghCalls())).not.toMatch(/gho_|ghp_|token/i);

    const info = await env.app.services.pr.refresh(ws.id);
    expect(info.checks).toEqual([
      { name: "CI", result: "passed", url: "https://ci.example/1" },
      { name: "lint", result: "pending", url: null },
    ]);

    await env.app.services.pr.pollOnce();
    expect(ghCalls().filter((c) => c[1] === "view").length).toBeGreaterThanOrEqual(3);

    res = await env.app.fastify.inject({
      method: "POST",
      url: `/api/workspaces/${ws.id}/pr/merge`,
      headers: { host: env.host, cookie },
      payload: { method: "squash" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: "MERGED" });
    const merge = ghCalls().find((c) => c[1] === "merge");
    expect(merge).toEqual(["pr", "merge", "1", "--squash"]);
    expect(env.app.services.workspaces.get(ws.id).pr?.state).toBe("MERGED");
    await expect(env.app.services.pr.create(ws.id, { title: "again", body: "" })).rejects.toThrow(
      /already has PR/,
    );
  });

  it("refuses when gh is not logged in", async () => {
    writeFileSync(stateFile, JSON.stringify({ loggedIn: false, prs: {} }));
    await expect(env.app.services.pr.create(ws.id, { title: "x", body: "" })).rejects.toThrow(
      /not logged in/,
    );
    expect((await env.app.services.pr.ghAuth()).ok).toBe(false);
  });

  it("parses check rollups defensively", () => {
    const info = parsePrView({
      number: 7,
      url: "u",
      state: "OPEN",
      statusCheckRollup: [
        { context: "legacy", state: "FAILURE" },
        { name: "x", status: "QUEUED" },
      ],
    });
    expect(info.checks.map((c) => c.result)).toEqual(["failed", "pending"]);
    expect(parsePrView(null).number).toBe(0);
  });
});
