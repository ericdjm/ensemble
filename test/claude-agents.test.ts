import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseClaudeAgent, parseClaudeAgents, statusFromAgent } from "../server/claude-agents.js";
import type {
  ClaudeAgentView,
  ClaudeAgentsReport,
  ClaudeAgentsView,
  Session,
} from "../shared/types.js";
import { makeTempRepo } from "./git-helpers.js";
import { FAKE_AGENT } from "./helpers-session.js";
import { login, makeTestApp, type TestEnv } from "./helpers.js";

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

describe("claude agents --json parsing", () => {
  it("keeps documented fields and drops malformed entries", () => {
    const agents = parseClaudeAgents(
      JSON.stringify([
        {
          id: "abc123",
          cwd: "/tmp/x",
          kind: "background",
          startedAt: 1_792_032_631_632,
          sessionId: "u-1",
          name: "fixer",
          state: "working",
          pid: 12,
          status: "busy",
          extra: "ignored",
        },
        {
          pid: 5,
          cwd: "/tmp/y",
          kind: "interactive",
          startedAt: 1,
          sessionId: "u-2",
          status: "busy",
        },
        { kind: "background" },
        "junk",
      ]),
    );
    expect(agents).toHaveLength(2);
    expect(agents[0]).toEqual({
      id: "abc123",
      cwd: "/tmp/x",
      kind: "background",
      startedAt: new Date(1_792_032_631_632).toISOString(),
      sessionId: "u-1",
      name: "fixer",
      state: "working",
      status: "busy",
      waitingFor: null,
      pid: 12,
    });
    expect(agents[1]?.id).toBeNull();
    expect(parseClaudeAgent(null)).toBeNull();
    expect(() => parseClaudeAgents("{}")).toThrow(/array/);
  });

  it("maps JSON status to Ensemble status", () => {
    const base = {
      id: "a",
      cwd: "/",
      kind: "background" as const,
      startedAt: null,
      sessionId: null,
      name: null,
      state: null,
      status: null,
      waitingFor: null,
      pid: null,
    };
    expect(statusFromAgent({ ...base, status: "busy" }).status).toBe("working");
    expect(statusFromAgent({ ...base, state: "working" }).status).toBe("working");
    const perm = statusFromAgent({ ...base, status: "waiting", waitingFor: "permission prompt" });
    expect(perm).toMatchObject({
      status: "needs_input",
      pending: { prompt: true, agentInput: false },
    });
    const input = statusFromAgent({ ...base, status: "waiting", waitingFor: "input needed" });
    expect(input).toMatchObject({
      status: "needs_input",
      pending: { prompt: false, agentInput: true },
    });
    expect(statusFromAgent({ ...base, state: "blocked" }).status).toBe("needs_input");
    expect(statusFromAgent({ ...base, status: "idle" }).status).toBe("idle");
    expect(statusFromAgent({ ...base, state: "done" }).status).toBe("idle");
    expect(statusFromAgent({ ...base, state: "working", status: "idle" }).status).toBe("idle");
  });
});

describe("adopting Claude background sessions (fake agent)", () => {
  let env: TestEnv;
  let repoPath: string;
  let cookie: string;
  let agentsFile: string;
  const extraAgentEnv: Record<string, string> = {};

  beforeEach(async () => {
    env = await makeTestApp({ cliPath: FAKE_AGENT, extraAgentEnv });
    await env.app.start();
    cookie = await login(env);
    repoPath = makeTempRepo();
    agentsFile = path.join(env.dir, "agents.json");
    extraAgentEnv["FAKE_AGENTS_FILE"] = agentsFile;
  });
  afterEach(async () => {
    for (const k of Object.keys(extraAgentEnv)) delete extraAgentEnv[k];
    await env.cleanup();
    rmSync(repoPath, { recursive: true, force: true });
  });

  const setAgents = (list: unknown[]) => writeFileSync(agentsFile, JSON.stringify(list));
  const get = (url: string) =>
    env.app.fastify.inject({ method: "GET", url, headers: { host: env.host, cookie } });
  const post = (url: string) =>
    env.app.fastify.inject({ method: "POST", url, headers: { host: env.host, cookie } });
  const bg = (over: Record<string, unknown> = {}) => ({
    id: "bg0001",
    cwd: repoPath,
    kind: "background",
    startedAt: Date.now(),
    sessionId: "conv-bg-1",
    name: "fixer",
    state: "working",
    pid: 4242,
    status: "busy",
    ...over,
  });

  it("lists sessions annotated with Ensemble matches and reports failures softly", async () => {
    setAgents([
      bg(),
      { pid: 1, cwd: "/elsewhere", kind: "interactive", startedAt: 1, status: "idle" },
    ]);
    const res = await get("/api/claude-agents");
    expect(res.statusCode).toBe(200);
    const report = res.json() as ClaudeAgentsView;
    expect(report.ok).toBe(true);
    expect(report.agents).toHaveLength(2);
    expect(report.agents[0]).toMatchObject({
      id: "bg0001",
      kind: "background",
      ensembleSessionId: null,
      workspaceId: null,
    });
    writeFileSync(agentsFile, "FAIL");
    const failed = (await get("/api/claude-agents")).json() as ClaudeAgentsReport;
    expect(failed.ok).toBe(false);
    expect(failed.agents).toEqual([]);
    expect(failed.error).toMatch(/failed/);
    writeFileSync(agentsFile, "not json");
    expect((await get("/api/claude-agents")).json()).toMatchObject({
      ok: false,
      error: expect.stringMatching(/unparseable/),
    });
  });

  it("attaches a background session in an in-place workspace and tracks status from the listing", async () => {
    setAgents([bg()]);
    const argvFile = path.join(env.dir, "argv.json");
    extraAgentEnv["FAKE_ARGV_FILE"] = argvFile;
    const res = await post("/api/claude-agents/bg0001/attach");
    expect(res.statusCode).toBe(202);
    const s = res.json() as Session;
    expect(s).toMatchObject({
      agent: "claude",
      adopted: true,
      claudeAgentId: "bg0001",
      cliSessionId: "conv-bg-1",
      processState: "running",
    });
    const ws = env.app.services.workspaces.get(s.workspaceId);
    expect(ws.kind).toBe("inplace");
    await waitFor(() => existsSync(argvFile), 15_000, "attach launched");
    expect(JSON.parse(readFileSync(argvFile, "utf8"))).toEqual(["attach", "bg0001"]);

    // Status follows the JSON: busy -> working, waiting -> needs_input, idle -> idle.
    const sessions = env.app.services.sessions;
    await sessions.refreshAdopted();
    expect(sessions.get(s.id)).toMatchObject({ status: "working", freshness: "current" });
    setAgents([bg({ status: "waiting", waitingFor: "permission prompt" })]);
    await sessions.refreshAdopted();
    expect(sessions.get(s.id)).toMatchObject({
      status: "needs_input",
      pendingInputs: { prompt: true },
    });
    setAgents([bg({ status: "idle", state: "working" })]);
    await sessions.refreshAdopted();
    expect(sessions.get(s.id).status).toBe("idle");
    // Listing failure marks the status stale but keeps it.
    writeFileSync(agentsFile, "FAIL");
    await sessions.refreshAdopted();
    expect(sessions.get(s.id)).toMatchObject({ status: "idle", freshness: "stale" });

    // The listing now points at the Ensemble session; attaching twice is refused.
    setAgents([bg()]);
    const listed = (await get("/api/claude-agents")).json() as { agents: ClaudeAgentView[] };
    expect(listed.agents[0]).toMatchObject({ ensembleSessionId: s.id, workspaceId: ws.id });
    expect((await post("/api/claude-agents/bg0001/attach")).statusCode).toBe(409);
    expect((await post("/api/claude-agents/nope/attach")).statusCode).toBe(404);
    await sessions.kill(s.id);
  });

  it("refuses a background session whose directory is not a git checkout", async () => {
    setAgents([bg({ cwd: env.dir })]);
    const res = await post("/api/claude-agents/bg0001/attach");
    expect(res.statusCode).toBe(409);
    expect(env.app.services.sessions.list()).toHaveLength(0);
  });

  it("rejects --bg through ensemble claude", async () => {
    const { validateCliArgs } = await import("../server/sessions.js");
    expect(() => validateCliArgs("claude", ["--bg"])).toThrow(/not allowed/);
  });
});
