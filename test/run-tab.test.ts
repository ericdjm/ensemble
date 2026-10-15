import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveScripts, effectiveRepoConfig, registerRepo } from "../server/repos.js";
import { makeTempRepo } from "./git-helpers.js";
import { FAKE_AGENT } from "./helpers-session.js";
import { login, makeTestApp, type TestEnv } from "./helpers.js";

describe("run script and comment-to-agent", () => {
  let env: TestEnv;
  let repoPath: string;
  beforeEach(async () => {
    env = await makeTestApp({ cliPath: FAKE_AGENT });
    await env.app.start();
    repoPath = makeTempRepo();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("starts and stops the approved run script in its own tmux session", async () => {
    writeFileSync(
      path.join(repoPath, ".ensemble.json"),
      JSON.stringify({ run: "echo run-on-$ENSEMBLE_PORT; sleep 60" }),
    );
    const repo = await registerRepo(env.db, repoPath);
    const created = await env.app.services.workspaces.create({ repoId: repo.id, agent: "claude" });
    let ws = await env.app.services.workspaces.continue(created.id);
    expect(ws.status).toBe("pending_approval");
    await expect(env.app.services.workspaces.startRun(ws.id)).rejects.toThrow(/not ready/);
    const eff = effectiveRepoConfig(env.db, repo);
    approveScripts(env.db, repo, [
      { kind: "run", hash: eff.scripts.find((s) => s.kind === "run")?.hash as string },
    ]);
    ws = await env.app.services.workspaces.continue(created.id);
    expect(ws.status).toBe("ready");

    const cookie = await login(env);
    let res = await env.app.fastify.inject({
      method: "GET",
      url: `/api/workspaces/${ws.id}/run`,
      headers: { host: env.host, cookie },
    });
    expect(res.json()).toMatchObject({ running: false, approved: true });
    res = await env.app.fastify.inject({
      method: "POST",
      url: `/api/workspaces/${ws.id}/run`,
      headers: { host: env.host, cookie },
    });
    expect(res.json()).toMatchObject({ running: true });
    expect(await env.tmux.hasSession(`ens-run-${ws.id.slice(0, 8)}`)).toBe(true);
    res = await env.app.fastify.inject({
      method: "DELETE",
      url: `/api/workspaces/${ws.id}/run`,
      headers: { host: env.host, cookie },
    });
    expect(res.json()).toMatchObject({ running: false });
    expect(await env.tmux.hasSession(`ens-run-${ws.id.slice(0, 8)}`)).toBe(false);
  });

  it("refuses to run an unapproved or missing run script", async () => {
    const repo = await registerRepo(env.db, repoPath);
    const created = await env.app.services.workspaces.create({ repoId: repo.id, agent: "claude" });
    const ws = await env.app.services.workspaces.continue(created.id);
    await expect(env.app.services.workspaces.startRun(ws.id)).rejects.toThrow(/no run script/);
  });

  it("sends a formatted line comment to a running session", async () => {
    const repo = await registerRepo(env.db, repoPath);
    const created = await env.app.services.workspaces.create({ repoId: repo.id, agent: "claude" });
    const ws = await env.app.services.workspaces.continue(created.id);
    const s = await env.app.services.sessions.launch({ workspaceId: ws.id, agent: "claude" });
    for (let i = 0; i < 60 && !env.app.services.sessions.get(s.id).cliSessionId; i++)
      await new Promise((r) => setTimeout(r, 250));
    const cookie = await login(env);
    const res = await env.app.fastify.inject({
      method: "POST",
      url: `/api/sessions/${s.id}/comment`,
      headers: { host: env.host, cookie },
      payload: { path: "src/app.ts", from: 14, to: 10, text: "extract this" },
    });
    expect(res.statusCode).toBe(204);
    let pane = "";
    for (let i = 0; i < 20 && !pane.includes("> In src/app.ts lines 10–14: extract this"); i++) {
      await new Promise((r) => setTimeout(r, 250));
      pane = await env.tmux.run(["capture-pane", "-p", "-t", `=${s.tmuxName}:`]);
    }
    expect(pane).toContain("> In src/app.ts lines 10–14: extract this");
    await env.app.services.sessions.kill(s.id);
  });
});
