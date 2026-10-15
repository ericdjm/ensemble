import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EventEnvelope } from "../shared/types.js";
import { drainSpools } from "../server/hooks/spool.js";
import { hashToken } from "../server/sessions.js";
import { makeTestApp, type TestEnv } from "./helpers.js";

async function post(env: TestEnv, sessionId: string, token: string, body: unknown, host?: string) {
  const port = env.app.services.listener.state.port;
  const res = await fetch(`http://127.0.0.1:${port}/api/hooks/${sessionId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(host ? { host } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function envelope(
  sessionId: string,
  seq: number,
  type: string,
  payload: Record<string, unknown> = {},
  extra: Partial<EventEnvelope> = {},
): EventEnvelope {
  return {
    id: `ev-${sessionId}-${seq}-${type}`,
    sessionId,
    generation: 1,
    seq,
    source: "test",
    type,
    tool: null,
    sourceTs: new Date().toISOString(),
    truncated: false,
    payload,
    ...extra,
  };
}

describe("hook listener and ingestion", () => {
  let env: TestEnv;
  const token = "hook-token-abc";
  const sessionId = "11111111-2222-3333-4444-555555555555";
  beforeEach(async () => {
    env = await makeTestApp();
    await env.app.start();
    env.db
      .prepare(
        "INSERT INTO repos (id, path, name, slug, default_base, created_at) VALUES ('r', '/tmp/r', 'r', 'r', 'main', 'now')",
      )
      .run();
    env.db
      .prepare(
        "INSERT INTO workspaces (id, repo_id, name, branch, path, base_branch, port, status, created_at) VALUES ('w', 'r', 'w', 'ens/w', '/tmp/w', 'main', 41000, 'ready', 'now')",
      )
      .run();
    env.db
      .prepare(
        "INSERT INTO sessions (id, workspace_id, agent, tmux_name, status, process_state, hook_token_hash, created_at) VALUES (?, 'w', 'claude', 'ens-1111', 'starting', 'running', ?, 'now')",
      )
      .run(sessionId, hashToken(token));
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("binds the persisted loopback port and reports ok", () => {
    expect(env.app.services.listener.state.ok).toBe(true);
  });

  it("rejects bad tokens, unknown sessions, wrong hosts, and bad envelopes", async () => {
    expect((await post(env, sessionId, "wrong", envelope(sessionId, 1, "Stop"))).status).toBe(401);
    expect((await post(env, "nope", token, envelope("nope", 1, "Stop"))).status).toBe(401);
    expect((await post(env, sessionId, token, "{not json")).status).toBe(400);
    expect((await post(env, sessionId, token, { id: "x" })).status).toBe(400);
    expect((await post(env, sessionId, token, envelope("other", 1, "Stop"))).status).toBe(400);
    const port = env.app.services.listener.state.port;
    const hostStatus = await new Promise<number>((resolve) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: `/api/hooks/${sessionId}`,
          headers: {
            host: "evil:1",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.end(JSON.stringify(envelope(sessionId, 1, "Stop")));
    });
    expect(hostStatus).toBe(421);
  });

  it("commits events, updates status, dedupes, and rejects old generations", async () => {
    let r = await post(
      env,
      sessionId,
      token,
      envelope(sessionId, 1, "SessionStart", { session_id: "cli-1", transcript_path: "/t" }),
    );
    expect(r.json).toMatchObject({ committed: true });
    expect(env.app.services.sessions.get(sessionId)).toMatchObject({
      cliSessionId: "cli-1",
      status: "idle",
      lastSeq: 1,
    });
    await post(env, sessionId, token, envelope(sessionId, 2, "UserPromptSubmit"));
    expect(env.app.services.sessions.get(sessionId).status).toBe("working");
    // duplicate id → committed but no change
    r = await post(env, sessionId, token, envelope(sessionId, 2, "UserPromptSubmit"));
    expect(r.json).toMatchObject({ committed: true, reason: "duplicate" });
    // old generation
    r = await post(env, sessionId, token, envelope(sessionId, 3, "Stop", {}, { generation: 0 }));
    expect(r.status).toBe(409);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 2 });
  });

  it("does not let a late lower sequence overwrite newer status, and records gaps", async () => {
    await post(env, sessionId, token, envelope(sessionId, 1, "SessionStart"));
    await post(env, sessionId, token, envelope(sessionId, 5, "Stop"));
    expect(env.app.services.sessions.get(sessionId)).toMatchObject({
      status: "idle",
      freshness: "stale",
      lastSeq: 5,
    });
    const gaps = env.db
      .prepare("SELECT from_seq, to_seq FROM event_gaps WHERE session_id = ?")
      .all(sessionId);
    expect(gaps).toEqual([{ from_seq: 2, to_seq: 4 }]);
    const r = await post(
      env,
      sessionId,
      token,
      envelope(sessionId, 3, "PermissionRequest", { tool_name: "Bash" }),
    );
    expect(r.json).toMatchObject({ committed: true, reason: "late" });
    expect(env.app.services.sessions.get(sessionId).status).toBe("idle");
  });

  it("drains spool records in order, deletes acknowledged ones, and absorbs gap markers", async () => {
    const spool = path.join(env.dir, "sessions", sessionId, "spool");
    mkdirSync(spool, { recursive: true });
    const rec = (seq: number, type: string, payload: Record<string, unknown> = {}) =>
      writeFileSync(
        path.join(spool, `1-${String(seq).padStart(10, "0")}.json`),
        JSON.stringify(envelope(sessionId, seq, type, payload)),
      );
    rec(2, "UserPromptSubmit");
    rec(1, "SessionStart", { session_id: "cli-9" });
    rec(3, "PermissionRequest", { tool_name: "Bash" });
    writeFileSync(
      path.join(spool, "gap.json"),
      JSON.stringify({ generation: 1, fromSeq: 4, toSeq: 6, count: 3, reason: "spool_full" }),
    );
    writeFileSync(path.join(spool, "1-0000000007.json"), "{corrupt");
    const summary = drainSpools(
      env.dir,
      new (await import("../server/hooks/ingest.js")).HookIngest(env.db, env.app.services.sessions),
    );
    expect(summary.ingested).toBe(3);
    expect(readdirSync(spool)).toEqual([]);
    const s = env.app.services.sessions.get(sessionId);
    expect(s).toMatchObject({
      cliSessionId: "cli-9",
      status: "needs_input",
      lastSeq: 3,
      freshness: "stale",
    });
    const gaps = env.db
      .prepare("SELECT reason FROM event_gaps WHERE session_id = ? ORDER BY reason")
      .all(sessionId);
    expect(gaps).toEqual([{ reason: "corrupt_record" }, { reason: "spool_full" }]);
  });
});
