import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EventSummary, Workspace } from "../shared/types.js";
import { HookIngest } from "../server/hooks/ingest.js";
import { drainSpools } from "../server/hooks/spool.js";
import { registerRepo } from "../server/repos.js";
import { CLAUDE_HOOK_EVENTS } from "../server/sessions.js";
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

describe("event log: live capture, downtime replay, clear, export", () => {
  let env: TestEnv;
  let repoPath: string;
  let ws: Workspace;

  beforeEach(async () => {
    env = await makeTestApp({ cliPath: FAKE_AGENT });
    await env.app.start();
    repoPath = makeTempRepo();
    const repo = await registerRepo(env.db, repoPath);
    const created = await env.app.services.workspaces.create({
      repoId: repo.id,
      agent: "claude",
      name: "ev",
    });
    ws = await env.app.services.workspaces.continue(created.id);
  });
  afterEach(async () => {
    await env.cleanup();
  });

  const sessions = () => env.app.services.sessions;
  const types = (id: string) =>
    (
      env.db
        .prepare(
          "SELECT seq, type FROM events WHERE session_id = ? AND generation = (SELECT hook_generation FROM sessions WHERE id = ?) ORDER BY seq",
        )
        .all(id, id) as Array<{ seq: number; type: string }>
    ).map((r) => `${r.seq}:${r.type}`);

  async function launchAndStart() {
    const s = await sessions().launch({ workspaceId: ws.id, agent: "claude" });
    await waitFor(() => (sessions().get(s.id).cliSessionId ? true : null), 15_000, "SessionStart");
    return s;
  }

  it("registers every supported Claude hook event in the per-session settings file", async () => {
    const s = await launchAndStart();
    const settings = JSON.parse(
      readFileSync(path.join(env.dir, "sessions", s.id, "claude-settings.json"), "utf8"),
    ) as { hooks: Record<string, unknown> };
    expect(Object.keys(settings.hooks).sort()).toEqual([...CLAUDE_HOOK_EVENTS].sort());
    await sessions().kill(s.id);
  });

  it("records tool events live with summaries and turns status working/idle", async () => {
    const s = await launchAndStart();
    await sessions().input(s.id, "tool Bash");
    await waitFor(
      () => (types(s.id).some((t) => t.endsWith("PostToolUse")) ? true : null),
      15_000,
      "PostToolUse",
    );
    expect(sessions().get(s.id).status).toBe("working");
    await sessions().input(s.id, "fire Stop");
    await waitFor(() => (sessions().get(s.id).status === "idle" ? true : null), 15_000, "Stop");
    const cookie = await login(env);
    const res = await env.app.fastify.inject({
      method: "GET",
      url: `/api/sessions/${s.id}/events`,
      headers: { host: env.host, cookie },
    });
    const body = res.json() as { events: EventSummary[] };
    const pre = body.events.find((e) => e.type === "PreToolUse");
    expect(pre).toMatchObject({ toolName: "Bash", summary: "Bash", truncated: false });
    expect(body.events.map((e) => e.type)).toEqual([
      "ensemble.preflight",
      "ensemble.launch",
      "SessionStart",
      "PreToolUse",
      "PostToolUse",
      "Stop",
    ]);
    await sessions().kill(s.id);
  });

  it("replays events captured while the listener was down, once and in order, with no duplicates", async () => {
    const s = await launchAndStart();
    const before = types(s.id).length;
    await env.app.services.listener.stop();
    await sessions().input(s.id, "tool Read");
    await sessions().input(s.id, "fire Stop");
    await new Promise((r) => setTimeout(r, 2500));
    expect(types(s.id)).toHaveLength(before);
    const spool = path.join(env.dir, "sessions", s.id, "spool");
    expect(readdirSync(spool).filter((n) => /^\d+-\d{10}\.json$/.test(n)).length).toBe(3);

    await env.app.services.listener.start();
    const summary = drainSpools(env.dir, new HookIngest(env.db, sessions()));
    expect(summary.ingested).toBe(3);
    expect(types(s.id).slice(before)).toEqual([
      `${before + 1}:PreToolUse`,
      `${before + 2}:PostToolUse`,
      `${before + 3}:Stop`,
    ]);
    expect(sessions().get(s.id)).toMatchObject({ status: "idle", freshness: "current" });
    // A second drain is a no-op.
    expect(drainSpools(env.dir, new HookIngest(env.db, sessions())).ingested).toBe(0);
    expect(readdirSync(spool).filter((n) => /^\d+-\d{10}\.json$/.test(n))).toEqual([]);
    await sessions().kill(s.id);
  });

  it("clears history under the lock so delayed old-generation events cannot come back", async () => {
    const s = await launchAndStart();
    await sessions().input(s.id, "tool Bash");
    await waitFor(() => (types(s.id).length >= 5 ? true : null), 15_000, "tool events");
    const cleared = sessions().clearEvents(s.id);
    expect(cleared).toMatchObject({ hookGeneration: 2, lastSeq: 0 });
    expect(types(s.id)).toEqual([]);
    const hook = JSON.parse(
      readFileSync(path.join(env.dir, "sessions", s.id, "hook.json"), "utf8"),
    ) as { generation: number };
    expect(hook.generation).toBe(2);

    // Delayed POST with the old generation.
    const port = env.app.services.listener.state.port;
    const token = hook as unknown as { token: string };
    const res = await fetch(`http://127.0.0.1:${port}/api/hooks/${s.id}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token.token}` },
      body: JSON.stringify({
        id: "late-1",
        sessionId: s.id,
        generation: 1,
        seq: 9,
        source: "test",
        type: "Stop",
        tool: null,
        sourceTs: "x",
        truncated: false,
        payload: {},
      }),
    });
    expect(res.status).toBe(409);
    // Stale spool record with the old generation.
    const spool = path.join(env.dir, "sessions", s.id, "spool");
    writeFileSync(
      path.join(spool, "1-0000000009.json"),
      JSON.stringify({
        id: "late-2",
        sessionId: s.id,
        generation: 1,
        seq: 9,
        source: "test",
        type: "Stop",
        tool: null,
        sourceTs: "x",
        truncated: false,
        payload: {},
      }),
    );
    const summary = drainSpools(env.dir, new HookIngest(env.db, sessions()));
    expect(summary).toMatchObject({ ingested: 0, rejected: 1 });
    expect(types(s.id)).toEqual([]);
    // New live events use the new generation.
    await sessions().input(s.id, "tool Write");
    await waitFor(() => (types(s.id).length >= 2 ? true : null), 15_000, "new generation events");
    expect(types(s.id)).toEqual(["1:PreToolUse", "2:PostToolUse"]);
    await sessions().kill(s.id);
  });

  it("exports JSONL with gap markers in sequence order", async () => {
    const s = await launchAndStart();
    env.db
      .prepare(
        "INSERT INTO event_gaps (session_id, generation, from_seq, to_seq, count, reason, recorded_at) VALUES (?, 1, 2, 2, 1, 'spool_full', 'now')",
      )
      .run(s.id);
    const cookie = await login(env);
    const res = await env.app.fastify.inject({
      method: "GET",
      url: `/api/sessions/${s.id}/events.jsonl`,
      headers: { host: env.host, cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("ndjson");
    const lines = res.body
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ seq: 1, type: "ensemble.preflight" });
    expect(lines[1]).toMatchObject({ seq: 2, type: "ensemble.launch" });
    expect(lines[2]).toMatchObject({ gap: true, fromSeq: 2, toSeq: 2, reason: "spool_full" });
    expect(lines.at(-1)).toMatchObject({ type: "SessionStart" });
    await sessions().kill(s.id);
  });
});
