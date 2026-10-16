import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as pty from "node-pty";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgentCommand } from "../server/cli.js";
import { writeServerInfo } from "../server/config.js";
import { parseArgs } from "../server/index.js";
import { packageRoot } from "../server/paths.js";
import { ensurePtyHelperExecutable } from "../server/terminal.js";
import { gitIn, makeTempRepo } from "./git-helpers.js";
import { FAKE_AGENT } from "./helpers-session.js";
import { freePort, makeTestApp, type TestEnv } from "./helpers.js";

describe("parseArgs for agent commands", () => {
  it("captures everything after claude/codex verbatim", () => {
    expect(parseArgs(["claude", "--model", "opus", "-p", "--port", "9"])).toMatchObject({
      command: "claude",
      agentArgs: ["--model", "opus", "-p", "--port", "9"],
      port: 4800,
    });
    expect(parseArgs(["--port", "5000", "codex", "hello world"])).toMatchObject({
      command: "codex",
      port: 5000,
      agentArgs: ["hello world"],
    });
    expect(parseArgs(["start"]).agentArgs).toEqual([]);
  });
});

describe("ensemble claude|codex", () => {
  let env: TestEnv;
  let repoPath: string;
  let port: number;
  const extraAgentEnv: Record<string, string> = {};
  const out: string[] = [];
  const err: string[] = [];
  const io = { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };

  beforeEach(async () => {
    out.length = 0;
    err.length = 0;
    port = await freePort();
    env = await makeTestApp({ cliPath: FAKE_AGENT, extraAgentEnv, port });
    await env.app.start();
    await env.app.fastify.listen({ host: "127.0.0.1", port });
    writeServerInfo(env.dir, {
      host: "127.0.0.1",
      port,
      pid: process.pid,
      tmuxSocket: env.tmux.socketName,
      startedAt: new Date().toISOString(),
    });
    repoPath = makeTempRepo();
  });
  afterEach(async () => {
    for (const k of Object.keys(extraAgentEnv)) delete extraAgentEnv[k];
    await env.cleanup();
    rmSync(repoPath, { recursive: true, force: true });
  });

  const base = (over: Partial<Parameters<typeof runAgentCommand>[0]> = {}) => ({
    agent: "claude" as const,
    args: [] as string[],
    stateDir: env.dir,
    cwd: repoPath,
    env: {} as NodeJS.ProcessEnv,
    requireTty: false,
    ...io,
    ...over,
  });

  it("accepts the config token as a bearer header on API routes only", async () => {
    const ok = await env.app.fastify.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: env.host, authorization: `Bearer ${env.token}` },
    });
    expect(ok.statusCode).toBe(200);
    const bad = await env.app.fastify.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: env.host, authorization: "Bearer nope" },
    });
    expect(bad.statusCode).toBe(401);
    const html = await env.app.fastify.inject({
      method: "GET",
      url: "/",
      headers: { host: env.host, authorization: `Bearer ${env.token}` },
    });
    expect(html.statusCode).toBe(401);
  });

  it("launches in the checkout through the server and attaches", async () => {
    const argvFile = path.join(env.dir, "argv.json");
    extraAgentEnv["FAKE_ARGV_FILE"] = argvFile;
    const attached: string[] = [];
    const code = await runAgentCommand(
      base({
        args: ["--model", "opus"],
        attach: async (name, socket) => {
          attached.push(name, socket);
          return 0;
        },
      }),
    );
    expect(code).toBe(0);
    const [ws] = env.app.services.workspaces.list();
    expect(ws).toMatchObject({ kind: "inplace", status: "ready", branch: "main" });
    const [session] = env.app.services.sessions.list();
    expect(session).toMatchObject({
      agent: "claude",
      workspaceId: ws?.id,
      processState: "running",
    });
    expect(attached).toEqual([session?.tmuxName, env.tmux.socketName]);
    expect(out.join("\n")).toContain(`http://127.0.0.1:${port}/#/ws/${ws?.id}`);
    expect(out.join("\n")).toContain("in place at");
    for (let i = 0; i < 100 && !existsSync(argvFile); i++)
      await new Promise((r) => setTimeout(r, 150));
    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    expect(argv.slice(2)).toEqual(["--model", "opus"]);

    // Second launch from a subdirectory reuses the workspace.
    gitIn(repoPath, ["checkout", "-q", "-b", "topic"]);
    const code2 = await runAgentCommand(
      base({ agent: "codex", cwd: repoPath, attach: async () => 3 }),
    );
    expect(code2).toBe(3);
    expect(env.app.services.workspaces.list()).toHaveLength(1);
    expect(env.app.services.workspaces.get(ws!.id).branch).toBe("topic");
    expect(env.app.services.sessions.list()).toHaveLength(2);
  });

  it("relays the server's rejection of non-interactive arguments", async () => {
    const code = await runAgentCommand(base({ args: ["-p", "hi"], attach: async () => 0 }));
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/not allowed/);
    expect(env.app.services.sessions.list()).toHaveLength(0);
  });

  it("refuses when the server is not running or was never started", async () => {
    const dead = await freePort();
    const dir = mkdtempSync(path.join(os.tmpdir(), "ensemble-cli-"));
    try {
      const noConfig = await runAgentCommand(base({ stateDir: dir, attach: async () => 0 }));
      expect(noConfig).toBe(1);
      expect(err.join("\n")).toMatch(/has not been started/);
      err.length = 0;
      // Config present, server.json pointing at a closed port.
      const { copyFileSync } = await import("node:fs");
      copyFileSync(path.join(env.dir, "config.json"), path.join(dir, "config.json"));
      writeServerInfo(dir, {
        host: "127.0.0.1",
        port: dead,
        pid: 0,
        tmuxSocket: "x",
        startedAt: "",
      });
      const down = await runAgentCommand(base({ stateDir: dir, attach: async () => 0 }));
      expect(down).toBe(1);
      expect(err.join("\n")).toMatch(/not running at http:\/\/127\.0\.0\.1:\d+/);
      expect(err.join("\n")).toMatch(/ensemble start/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(env.app.services.workspaces.list()).toHaveLength(0);
  });

  it("runs the real binary directly inside a session and for --version", async () => {
    const calls: Array<[string, string[]]> = [];
    const passthrough = async (cliPath: string, args: string[]) => {
      calls.push([cliPath, args]);
      return 7;
    };
    expect(
      await runAgentCommand(
        base({ env: { ENSEMBLE_INSIDE: "1" }, args: ["--model", "x"], passthrough }),
      ),
    ).toBe(7);
    expect(await runAgentCommand(base({ args: ["--version"], passthrough }))).toBe(7);
    expect(calls).toEqual([
      [FAKE_AGENT, ["--model", "x"]],
      [FAKE_AGENT, ["--version"]],
    ]);
    expect(env.app.services.workspaces.list()).toHaveLength(0);
  });

  it("attaches a real terminal and returns on its own when the agent exits", async () => {
    ensurePtyHelperExecutable();
    const tsx = path.join(packageRoot(), "node_modules", ".bin", "tsx");
    expect(existsSync(tsx)).toBe(true);
    let output = "";
    const term = pty.spawn(tsx, [path.join(packageRoot(), "server", "main.ts"), "claude"], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: repoPath,
      env: {
        ...(process.env as Record<string, string>),
        ENSEMBLE_STATE_DIR: env.dir,
        TERM: "xterm-256color",
      },
    });
    const exited = new Promise<number>((resolve) => term.onExit((e) => resolve(e.exitCode)));
    term.onData((d) => {
      output += d;
    });
    const started = Date.now();
    while (!output.includes("fake-agent ready")) {
      if (Date.now() - started > 45_000) throw new Error(`agent never started:\n${output}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    term.write("exit\r");
    const code = await Promise.race([
      exited,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error(`did not return:\n${output}`)), 30_000),
      ),
    ]);
    expect(code).toBe(0);
    expect(output).toContain("session ended (exit 0)");
    await env.app.services.sessions.refreshLiveness();
    const [session] = env.app.services.sessions.list();
    expect(session).toMatchObject({ processState: "dead", exitCode: 0, status: "exited" });
    // The dead pane is retained for the browser; the hook was removed again.
    expect(await env.tmux.hasSession(session!.tmuxName)).toBe(true);
    const hooks = await env.tmux.run(["show-hooks", "-t", `=${session!.tmuxName}:`]);
    expect(hooks).not.toContain("pane-died");
  }, 90_000);
});
