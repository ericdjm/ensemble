import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EventSummary, Relay, Workspace } from "../shared/types.js";
import { registerRepo } from "../server/repos.js";
import { makeTempRepo } from "./git-helpers.js";
import { FAKE_AGENT } from "./helpers-session.js";
import { login, makeTestApp, type TestEnv } from "./helpers.js";

async function waitFor<T>(
  fn: () => T | undefined | false | null,
  timeoutMs = 20_000,
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

describe("bounded relays (opt-in)", () => {
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
      name: "relay",
    });
    ws = await env.app.services.workspaces.continue(created.id);
    extraAgentEnv["FAKE_AUTO_REPLY"] = "echo";
  });
  afterEach(async () => {
    for (const k of Object.keys(extraAgentEnv)) delete extraAgentEnv[k];
    await env.cleanup();
    rmSync(repoPath, { recursive: true, force: true });
  });

  const sessions = () => env.app.services.sessions;
  const relays = () => env.app.services.relays;
  const started = async (agent: "claude" | "codex" = "claude") => {
    const s = await sessions().launch({ workspaceId: ws.id, agent });
    await waitFor(() => sessions().get(s.id).status === "idle", 15_000, "idle");
    return s;
  };
  const post = (url: string, body?: unknown) =>
    env.app.fastify.inject({
      method: "POST",
      url,
      headers: { host: env.host, cookie },
      ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
    });
  const settle = (id: string) =>
    waitFor(
      () => {
        const r = relays().get(id);
        return r.status !== "running" ? r : null;
      },
      30_000,
      "relay end",
    );

  it("is refused unless enabled in settings", async () => {
    const a = await started();
    const b = await started("codex");
    const res = await post("/api/relays", { aSessionId: a.id, bSessionId: b.id, kickoff: "go" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/disabled/) });
    expect(relays().list()).toHaveLength(0);
  });

  it("relays answers back and forth until the done marker, logging every hop", async () => {
    env.app.services.config.relayEnabled = true;
    extraAgentEnv["FAKE_AUTO_REPLY_DONE_AT"] = "2";
    extraAgentEnv["FAKE_AUTO_REPLY_DONE_WORD"] = "FINISHED";
    const a = await started();
    const b = await started("codex");
    const res = await post("/api/relays", {
      aSessionId: a.id,
      bSessionId: b.id,
      kickoff: "Design the API.\nKeep it short.",
      maxRounds: 6,
      doneMarker: "FINISHED",
    });
    expect(res.statusCode).toBe(202);
    const relay = res.json() as Relay;
    expect(relay).toMatchObject({ status: "running", awaitingSessionId: a.id, roundsDone: 0 });
    // Hop 1: A's answer (echo #1) goes to B. Hop 2: B's answer (echo #1, no marker yet) goes to A.
    // A's second answer is "echo #2 FINISHED" -> done. B's second answer would also be marked, but
    // the relay ends as soon as a received answer contains the marker.
    const done = await settle(relay.id);
    expect(done.status).toBe("done");
    expect(done.roundsDone).toBe(2);
    expect(done.awaitingSessionId).toBeNull();
    const events = async (id: string) =>
      (
        (
          await env.app.fastify.inject({
            method: "GET",
            url: `/api/sessions/${id}/events`,
            headers: { host: env.host, cookie },
          })
        ).json() as { events: EventSummary[] }
      ).events.filter((e) => e.type === "ensemble.relay");
    const evA = await events(a.id);
    const evB = await events(b.id);
    expect(evA.map((e) => e.summary)).toEqual(["relay hop 0", "relay hop 1 sent", "relay hop 2"]);
    expect(evB.map((e) => e.summary)).toEqual(["relay hop 1", "relay hop 2 sent"]);
    // Both sessions must be free again.
    const again = await post("/api/relays", { aSessionId: b.id, bSessionId: a.id, kickoff: "x" });
    expect(again.statusCode).toBe(202);
    relays().stop((again.json() as Relay).id);
  });

  it("stops at the hop limit and can be stopped by hand", async () => {
    env.app.services.config.relayEnabled = true;
    const a = await started();
    const b = await started();
    const r1 = (
      await post("/api/relays", { aSessionId: a.id, bSessionId: b.id, kickoff: "go", maxRounds: 1 })
    ).json() as Relay;
    const limited = await settle(r1.id);
    expect(limited.status).toBe("limit");
    expect(limited.roundsDone).toBe(1);

    const r2 = (
      await post("/api/relays", {
        aSessionId: a.id,
        bSessionId: b.id,
        kickoff: "go",
        maxRounds: 20,
      })
    ).json() as Relay;
    expect(r2.status).toBe("running");
    const dup = await post("/api/relays", { aSessionId: b.id, bSessionId: a.id, kickoff: "go" });
    expect(dup.statusCode).toBe(409);
    const stopped = (await post(`/api/relays/${r2.id}/stop`)).json() as Relay;
    expect(stopped.status).toBe("stopped");
    await new Promise((r) => setTimeout(r, 1500));
    expect(relays().get(r2.id).status).toBe("stopped");
  });

  it("refuses busy sessions, validates inputs, and ends with an error when the target dies", async () => {
    env.app.services.config.relayEnabled = true;
    const a = await started();
    const b = await started();
    expect(
      (await post("/api/relays", { aSessionId: a.id, bSessionId: a.id, kickoff: "x" })).statusCode,
    ).toBe(400);
    expect(
      (
        await post("/api/relays", {
          aSessionId: a.id,
          bSessionId: b.id,
          kickoff: "x",
          doneMarker: "two words",
        })
      ).statusCode,
    ).toBe(400);
    await sessions().input(b.id, "fire UserPromptSubmit");
    await waitFor(() => sessions().get(b.id).status === "working", 10_000, "busy");
    const busy = await post("/api/relays", { aSessionId: a.id, bSessionId: b.id, kickoff: "x" });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ error: expect.stringMatching(/must be idle/) });
    await sessions().input(b.id, "fire Stop");
    await waitFor(() => sessions().get(b.id).status === "idle", 10_000, "idle again");

    const r = (
      await post("/api/relays", { aSessionId: a.id, bSessionId: b.id, kickoff: "go", maxRounds: 5 })
    ).json() as Relay;
    await sessions().kill(b.id);
    const ended = await settle(r.id);
    expect(ended.status).toBe("error");
    expect(ended.error).toMatch(/not running/);
  });

  it("marks running relays interrupted at startup", async () => {
    env.app.services.config.relayEnabled = true;
    const a = await started();
    const b = await started();
    extraAgentEnv["FAKE_AUTO_REPLY"] = "";
    delete extraAgentEnv["FAKE_AUTO_REPLY"];
    const r = (
      await post("/api/relays", { aSessionId: a.id, bSessionId: b.id, kickoff: "go" })
    ).json() as Relay;
    expect(relays().get(r.id).status).toBe("running");
    relays().interruptAll();
    expect(relays().get(r.id)).toMatchObject({ status: "interrupted", error: "server restarted" });
  });
});
