import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EventEnvelope, EventSummary } from "../shared/types.js";
import { registerRepo } from "../server/repos.js";
import { hashToken } from "../server/sessions.js";
import type { Workspace } from "../shared/types.js";
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

describe("last answers, handoffs, ask-all (fake agent)", () => {
  let env: TestEnv;
  let repoPath: string;
  let ws: Workspace;
  let cookie: string;
  const extraAgentEnv: Record<string, string> = {};

  beforeEach(async () => {
    env = await makeTestApp({ cliPath: FAKE_AGENT, extraAgentEnv });
    await env.app.start();
    cookie = await login(env);
    repoPath = makeTempRepo();
    const repo = await registerRepo(env.db, repoPath);
    const created = await env.app.services.workspaces.create({
      repoId: repo.id,
      agent: "claude",
      name: "hand",
    });
    ws = await env.app.services.workspaces.continue(created.id);
  });
  afterEach(async () => {
    for (const k of Object.keys(extraAgentEnv)) delete extraAgentEnv[k];
    await env.cleanup();
    rmSync(repoPath, { recursive: true, force: true });
  });

  const sessions = () => env.app.services.sessions;
  const started = async (agent: "claude" | "codex" = "claude") => {
    const s = await sessions().launch({ workspaceId: ws.id, agent });
    await waitFor(() => sessions().get(s.id).cliSessionId !== null, 15_000, "SessionStart");
    return s;
  };
  const get = (url: string) =>
    env.app.fastify.inject({ method: "GET", url, headers: { host: env.host, cookie } });
  const post = (url: string, body: unknown) =>
    env.app.fastify.inject({
      method: "POST",
      url,
      headers: { host: env.host, cookie },
      payload: body as Record<string, unknown>,
    });

  it("stores the Stop payload's answer, previews it, and serves the full text", async () => {
    const s = await started();
    const long = "word ".repeat(100).trim();
    await sessions().input(s.id, `reply ${long}`);
    const cur = await waitFor(
      () => {
        const c = sessions().get(s.id);
        return c.lastAnswerAt ? c : null;
      },
      15_000,
      "answer",
    );
    expect(cur.lastAnswerSource).toBe("stop-payload");
    expect(cur.lastAnswerPreview?.length).toBe(240);
    expect(cur.lastAnswerPreview?.endsWith("…")).toBe(true);
    const res = await get(`/api/sessions/${s.id}/last-answer`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ text: `${long} #1`, source: "stop-payload" });
    // A later turn replaces it; a turn without a captured answer keeps the previous one.
    await sessions().input(s.id, "reply second");
    await waitFor(() => sessions().lastAnswer(s.id).text === "second #2", 15_000, "second");
    await sessions().input(s.id, "fire Stop");
    await new Promise((r) => setTimeout(r, 800));
    expect(sessions().lastAnswer(s.id).text).toBe("second #2");
  });

  it("falls back to the transcript tail when the Stop payload carries no message", async () => {
    const transcript = path.join(env.dir, "transcript.jsonl");
    writeFileSync(
      transcript,
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "from the file" }] },
      }) + "\n",
    );
    extraAgentEnv["FAKE_TRANSCRIPT_PATH"] = transcript;
    extraAgentEnv["FAKE_STOP_WITHOUT_MESSAGE"] = "1";
    const s = await started();
    await sessions().input(s.id, "reply ignored");
    await waitFor(() => sessions().get(s.id).lastAnswerAt !== null, 15_000, "answer");
    expect(sessions().lastAnswer(s.id)).toMatchObject({
      text: "from the file",
      source: "transcript",
    });
  });

  it("captures the Codex notify message through the hook listener", async () => {
    const s = await started("codex");
    const row = env.db
      .prepare("SELECT hook_generation, last_seq FROM sessions WHERE id = ?")
      .get(s.id) as { hook_generation: number; last_seq: number };
    const token = "codex-token-for-test";
    env.db
      .prepare("UPDATE sessions SET hook_token_hash = ? WHERE id = ?")
      .run(hashToken(token), s.id);
    const envelope: EventEnvelope = {
      id: "ev-codex-1",
      sessionId: s.id,
      generation: row.hook_generation,
      seq: row.last_seq + 1,
      source: "codex-notify",
      type: "agent-turn-complete",
      tool: null,
      sourceTs: new Date().toISOString(),
      truncated: false,
      payload: { type: "agent-turn-complete", "last-assistant-message": "codex says hi" },
    };
    const res = await fetch(
      `http://127.0.0.1:${env.app.services.listener.state.port}/api/hooks/${s.id}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(envelope),
      },
    );
    expect(res.status).toBe(200);
    expect(sessions().lastAnswer(s.id)).toMatchObject({
      text: "codex says hi",
      source: "codex-notify",
    });
    expect(sessions().get(s.id).status).toBe("idle");
  });

  it("hands the answer to another session as a multi-line prompt and logs both sides", async () => {
    const a = await started();
    const inputFile = path.join(env.dir, "b-input.txt");
    extraAgentEnv["FAKE_INPUT_FILE"] = inputFile;
    const b = await started("codex");
    delete extraAgentEnv["FAKE_INPUT_FILE"];
    await sessions().input(a.id, "reply line one");
    await waitFor(() => sessions().get(a.id).lastAnswerAt !== null, 15_000, "answer");

    const res = await post(`/api/sessions/${a.id}/handoff`, {
      targetSessionId: b.id,
      text: "Please review:\n\nline one #1\nsecond line",
    });
    expect(res.statusCode).toBe(200);
    const received = await waitFor(
      () => (existsSync(inputFile) ? readFileSync(inputFile, "utf8") : null),
      15_000,
      "delivery",
    );
    const lines = received.split("\n").filter((l) => l.length > 0);
    expect(lines[0]).toBe(
      "From claude in " + `${path.basename(repoPath)}/hand (Ensemble handoff):`,
    );
    expect(lines).toContain("Please review:");
    expect(lines).toContain("line one #1");
    expect(lines).toContain("second line");

    const events = async (id: string) =>
      (await get(`/api/sessions/${id}/events`)).json() as { events: EventSummary[] };
    const inB = (await events(b.id)).events.filter((e) => e.type === "ensemble.handoff");
    const inA = (await events(a.id)).events.filter((e) => e.type === "ensemble.handoff");
    expect(inB).toHaveLength(1);
    expect(inB[0]?.summary).toMatch(/received \d+ chars from claude/);
    expect(inA[0]?.summary).toMatch(/sent \d+ chars to codex/);
    // Internal events take ordered sequence numbers like hook events do; nothing is left in the spool.
    const spool = path.join(env.dir, "sessions", b.id, "spool");
    expect(readFileSync(path.join(spool, "state.json"), "utf8")).toContain('"seq"');
    expect(existsSync(path.join(spool, `1-${String(inB[0]?.seq).padStart(10, "0")}.json`))).toBe(
      false,
    );
    // Later hook events keep sequencing after the internal one.
    await sessions().input(b.id, "reply after");
    await waitFor(() => sessions().lastAnswer(b.id).text === "after #1", 15_000, "b answer");
    expect(sessions().get(b.id).freshness).toBe("current");

    expect(
      (await post(`/api/sessions/${a.id}/handoff`, { targetSessionId: a.id, text: "x" }))
        .statusCode,
    ).toBe(400);
    await sessions().kill(b.id);
    expect(
      (await post(`/api/sessions/${a.id}/handoff`, { targetSessionId: b.id, text: "x" }))
        .statusCode,
    ).toBe(409);
  });

  it("asks all running sessions in a workspace", async () => {
    const f1 = path.join(env.dir, "in1.txt");
    const f2 = path.join(env.dir, "in2.txt");
    extraAgentEnv["FAKE_INPUT_FILE"] = f1;
    const a = await started();
    extraAgentEnv["FAKE_INPUT_FILE"] = f2;
    const b = await started();
    delete extraAgentEnv["FAKE_INPUT_FILE"];
    await sessions().kill(b.id);
    const c = await started();
    expect(c).toBeTruthy();
    const res = await post(`/api/workspaces/${ws.id}/ask-all`, { text: "status please" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sent: string[] };
    expect(body.sent).toHaveLength(2);
    expect(body.sent).toContain(a.id);
    expect(body.sent).not.toContain(b.id);
    await waitFor(() => existsSync(f1) && readFileSync(f1, "utf8").includes("status please"));
    expect(existsSync(f2)).toBe(false);
    for (const id of body.sent) await sessions().kill(id);
    expect((await post(`/api/workspaces/${ws.id}/ask-all`, { text: "x" })).statusCode).toBe(409);
  });
});
