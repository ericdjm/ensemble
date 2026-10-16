import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session, Workspace } from "../shared/types.js";
import { registerRepo } from "../server/repos.js";
import { makeTempRepo } from "./git-helpers.js";
import { FAKE_AGENT } from "./helpers-session.js";
import { login, makeTestApp, type TestEnv } from "./helpers.js";

describe("session labels, notes, pins", () => {
  let env: TestEnv;
  let repoPath: string;
  let ws: Workspace;
  let cookie: string;

  beforeEach(async () => {
    env = await makeTestApp({ cliPath: FAKE_AGENT });
    await env.app.start();
    cookie = await login(env);
    repoPath = makeTempRepo();
    const repo = await registerRepo(env.db, repoPath);
    const created = await env.app.services.workspaces.create({
      repoId: repo.id,
      agent: "claude",
      name: "meta",
    });
    ws = await env.app.services.workspaces.continue(created.id);
  });
  afterEach(async () => {
    await env.cleanup();
    rmSync(repoPath, { recursive: true, force: true });
  });

  const patch = (id: string, body: unknown) =>
    env.app.fastify.inject({
      method: "PATCH",
      url: `/api/sessions/${id}`,
      headers: { host: env.host, cookie },
      payload: body as Record<string, unknown>,
    });

  it("sets, clears, and validates label, notes, and pinned; broadcasts the change", async () => {
    const s = await env.app.services.sessions.launch({ workspaceId: ws.id, agent: "claude" });
    expect(s).toMatchObject({ label: null, notes: null, pinned: false, adopted: false });
    const changed: Session[] = [];
    env.app.services.sessions.on("changed", (item: Session) => changed.push(item));

    const res = await patch(s.id, { label: "  reviewer ", notes: "watch the tests", pinned: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ label: "reviewer", notes: "watch the tests", pinned: true });
    expect(changed.at(-1)).toMatchObject({ label: "reviewer", pinned: true });

    // Partial updates leave the other fields alone; empty strings clear.
    expect((await patch(s.id, { pinned: false })).json()).toMatchObject({
      label: "reviewer",
      notes: "watch the tests",
      pinned: false,
    });
    expect((await patch(s.id, { label: "", notes: null })).json()).toMatchObject({
      label: null,
      notes: null,
    });
    expect((await patch(s.id, { label: "x".repeat(81) })).statusCode).toBe(400);
    expect((await patch(s.id, { pinned: "yes" })).statusCode).toBe(400);
    expect((await patch("missing", { pinned: true })).statusCode).toBe(404);
    // Metadata survives in the snapshot used by the UI.
    await patch(s.id, { label: "final" });
    const state = (
      await env.app.fastify.inject({
        method: "GET",
        url: "/api/state",
        headers: { host: env.host, cookie },
      })
    ).json() as { sessions: Session[] };
    expect(state.sessions.find((x) => x.id === s.id)?.label).toBe("final");
    await env.app.services.sessions.kill(s.id);
  });
});
