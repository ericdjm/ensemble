import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { registerRepo } from "../server/repos.js";
import type { Workspace } from "../shared/types.js";
import { makeTempRepo } from "./git-helpers.js";
import { FAKE_AGENT } from "./helpers-session.js";
import { freePort, login, makeTestApp, type TestEnv } from "./helpers.js";

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

describe("agent sessions (tmux + fake agent)", () => {
  let env: TestEnv;
  let repoPath: string;
  let ws: Workspace;
  const extraAgentEnv: Record<string, string> = {};
  let port: number;

  beforeEach(async () => {
    port = await freePort();
    env = await makeTestApp({ cliPath: FAKE_AGENT, extraAgentEnv, port });
    await env.app.start();
    repoPath = makeTempRepo();
    const repo = await registerRepo(env.db, repoPath);
    const created = await env.app.services.workspaces.create({
      repoId: repo.id,
      agent: "claude",
      name: "sess",
    });
    ws = await env.app.services.workspaces.continue(created.id);
    expect(ws.status).toBe("ready");
  });
  afterEach(async () => {
    for (const k of Object.keys(extraAgentEnv)) delete extraAgentEnv[k];
    await env.cleanup();
  });

  const sessions = () => env.app.services.sessions;

  it("launches in tmux, captures the CLI session id through the hook, and records exit", async () => {
    const argvFile = path.join(env.dir, "argv.json");
    extraAgentEnv["FAKE_ARGV_FILE"] = argvFile;
    extraAgentEnv["FAKE_SESSION_ID"] = "conv-one";
    const s = await sessions().launch({ workspaceId: ws.id, agent: "claude", prompt: "do things" });
    expect(s).toMatchObject({ status: "starting", processState: "running", authMode: "unchecked" });
    const captured = await waitFor(
      () => {
        const cur = sessions().get(s.id);
        return cur.cliSessionId ? cur : null;
      },
      15_000,
      "SessionStart",
    );
    expect(captured).toMatchObject({
      cliSessionId: "conv-one",
      status: "idle",
      freshness: "current",
      authMode: "subscription",
      authLabel: "Claude subscription",
    });
    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    expect(argv[0]).toBe("--settings");
    expect(argv.at(-1)).toBe("do things");
    expect(existsSync(path.join(env.dir, "sessions", s.id, "hook.json"))).toBe(true);

    await sessions().input(s.id, "exit");
    const ended = await waitFor(
      () => {
        const cur = sessions().get(s.id);
        return cur.processState === "dead" ? cur : null;
      },
      15_000,
      "exit",
    );
    expect(ended).toMatchObject({ exitCode: 0, status: "exited" });
    // The dead pane is retained by tmux until killed.
    expect(await env.tmux.hasSession(ended.tmuxName)).toBe(true);
  });

  it("strips API-key variables even when the tmux server already retained them", async () => {
    // Start the tmux server from a client that still carries a key: simulates a pre-existing server.
    process.env["ANTHROPIC_API_KEY"] = "sk-retained";
    try {
      const { Tmux } = await import("../server/tmux.js");
      const leaky = new Tmux({ socketName: env.tmux.socketName, stripVars: [] });
      await leaky.newSession({
        name: "warm",
        cwd: "/",
        env: {},
        command: ["/bin/sh", "-c", "sleep 30"],
      });
      expect(
        (await leaky.run(["show-environment", "-g", "ANTHROPIC_API_KEY"])).startsWith(
          "ANTHROPIC_API_KEY=",
        ),
      ).toBe(true);
    } finally {
      delete process.env["ANTHROPIC_API_KEY"];
    }
    const envFile = path.join(env.dir, "agent-env.json");
    extraAgentEnv["FAKE_ENV_FILE"] = envFile;
    const s = await sessions().launch({ workspaceId: ws.id, agent: "claude" });
    await waitFor(() => (sessions().get(s.id).cliSessionId ? true : null), 15_000, "SessionStart");
    expect(JSON.parse(readFileSync(envFile, "utf8"))).toMatchObject({
      ANTHROPIC_API_KEY: false,
      OPENAI_API_KEY: false,
    });
    await sessions().kill(s.id);
  });

  it("refuses non-subscription logins by default and surfaces the reason", async () => {
    extraAgentEnv["FAKE_AUTH_METHOD"] = "api_key";
    const s = await sessions().launch({ workspaceId: ws.id, agent: "claude" });
    const refused = await waitFor(
      () => {
        const cur = sessions().get(s.id);
        return cur.processState === "dead" ? cur : null;
      },
      15_000,
      "refusal",
    );
    expect(refused).toMatchObject({
      exitCode: 78,
      status: "error",
      authMode: "api",
      authLabel: "API key billing",
    });
    expect(refused.refusalReason).toMatch(/subscription/);
  });

  it("resumes the exact conversation id of an exited session and refuses to resume without one", async () => {
    const argvFile = path.join(env.dir, "argv.json");
    extraAgentEnv["FAKE_ARGV_FILE"] = argvFile;
    extraAgentEnv["FAKE_SESSION_ID"] = "conv-A";
    const a = await sessions().launch({ workspaceId: ws.id, agent: "claude" });
    await waitFor(() => (sessions().get(a.id).cliSessionId ? true : null), 15_000, "A start");
    extraAgentEnv["FAKE_SESSION_ID"] = "conv-B";
    const b = await sessions().launch({ workspaceId: ws.id, agent: "claude" });
    await waitFor(
      () => (sessions().get(b.id).cliSessionId === "conv-B" ? true : null),
      15_000,
      "B start",
    );

    await expect(sessions().resume(a.id)).rejects.toThrow(/still running/);
    await sessions().input(a.id, "exit");
    await waitFor(
      () => (sessions().get(a.id).processState === "dead" ? true : null),
      15_000,
      "A exit",
    );

    const a2 = await sessions().resume(a.id);
    expect(a2.predecessorId).toBe(a.id);
    expect(sessions().get(a.id).successorId).toBe(a2.id);
    await waitFor(() => (sessions().get(a2.id).cliSessionId ? true : null), 15_000, "A2 start");
    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    expect(argv).toContain("--resume");
    expect(argv[argv.indexOf("--resume") + 1]).toBe("conv-A");
    expect(sessions().get(a2.id).cliSessionId).toBe("conv-A");
    await expect(sessions().resume(a.id)).rejects.toThrow(/already resumed/);

    // A session whose id was never captured cannot be resumed implicitly.
    env.db
      .prepare(
        "UPDATE sessions SET cli_session_id = NULL, process_state = 'dead', successor_id = NULL WHERE id = ?",
      )
      .run(b.id);
    await expect(sessions().resume(b.id)).rejects.toThrow(/no conversation id/);
    await expect(sessions().resume(b.id, { cliSessionId: "bad id!" })).rejects.toThrow(/invalid/);
    await sessions().kill(a2.id);
    await sessions().kill(b.id);
  });

  it("streams the terminal over /ws/term and accepts input", async () => {
    await env.app.fastify.listen({ host: "127.0.0.1", port });
    const cookie = await login(env);
    const s = await sessions().launch({ workspaceId: ws.id, agent: "claude" });
    await waitFor(() => (sessions().get(s.id).cliSessionId ? true : null), 15_000, "start");
    const received = await new Promise<string>((resolve, reject) => {
      const sock = new WebSocket(
        `ws://127.0.0.1:${port}/ws/term?target=session:${s.id}&cols=100&rows=30`,
        {
          headers: { origin: `http://127.0.0.1:${port}`, cookie },
        },
      );
      let buf = "";
      const timer = setTimeout(() => reject(new Error("no terminal output")), 15_000);
      sock.on("message", (data, isBinary) => {
        if (!isBinary) return;
        buf += data.toString();
        if (buf.includes("fake-agent ready")) {
          sock.send(Buffer.from("echo-me\n"));
        }
        if (buf.includes("> echo-me")) {
          clearTimeout(timer);
          sock.close();
          resolve(buf);
        }
      });
      sock.on("error", reject);
    });
    expect(received).toContain("fake-agent ready");
    expect(received).toContain("> echo-me");
    await sessions().kill(s.id);
  });

  it("rejects terminal targets that do not exist", async () => {
    await env.app.fastify.listen({ host: "127.0.0.1", port });
    const cookie = await login(env);
    const status = await new Promise<number>((resolve) => {
      const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/term?target=session:nope`, {
        headers: { origin: `http://127.0.0.1:${port}`, cookie },
      });
      sock.on("unexpected-response", (_r, res) => resolve(res.statusCode ?? 0));
      sock.on("error", () => resolve(-1));
    });
    expect(status).toBe(404);
  });

  it("reports the doctor without running auth commands", async () => {
    const { doctorReport } = await import("../server/doctor.js");
    const report = await doctorReport(
      env.app.services.config,
      env.db,
      env.tmux,
      env.app.services.listener.state,
    );
    expect(report.tools.find((t) => t.name === "tmux")?.version).toMatch(/^tmux/);
    expect(report.tools.find((t) => t.name === "claude")).toMatchObject({
      resolvedFrom: "override",
      path: FAKE_AGENT,
    });
    expect(report.hookListener.ok).toBe(true);
    expect(report.authModes.find((a) => a.agent === "claude")?.mode).toBe("unchecked");
  });

  it("stops sessions when the workspace is archived", async () => {
    const s = await sessions().launch({ workspaceId: ws.id, agent: "claude" });
    await waitFor(() => (sessions().get(s.id).cliSessionId ? true : null), 15_000, "start");
    writeFileSync(path.join(ws.path, "scratch.txt"), "x");
    const inv = await env.app.services.archive.inventory(ws);
    await env.app.services.archive.archive(ws.id, {
      inventoryHash: inv.hash,
      forceDirty: true,
      ignored: {},
    });
    expect(sessions().get(s.id).processState).toBe("missing");
    expect(await env.tmux.hasSession(s.tmuxName)).toBe(false);
  });
});
