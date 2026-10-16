import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { freePort, login, makeTestApp, type TestEnv } from "./helpers.js";

function connect(
  url: string,
  headers: Record<string, string>,
): Promise<{ ok: boolean; status?: number; first?: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.once("unexpected-response", (_req, res) => {
      resolve({ ok: false, status: res.statusCode ?? 0 });
      ws.terminate();
    });
    ws.once("error", () => resolve({ ok: false }));
    ws.once("message", (data) => {
      resolve({ ok: true, first: data.toString() });
      ws.close();
    });
  });
}

describe("/ws", () => {
  let env: TestEnv;
  let url: string;
  let origin: string;

  beforeEach(async () => {
    const port = await freePort();
    env = await makeTestApp({ port });
    await env.app.fastify.listen({ host: "127.0.0.1", port });
    url = `ws://127.0.0.1:${port}/ws`;
    origin = `http://127.0.0.1:${port}`;
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("rejects upgrades without a cookie", async () => {
    expect(await connect(url, { origin })).toMatchObject({ ok: false, status: 401 });
  });

  it("rejects upgrades with a bad origin", async () => {
    const cookie = await login(env);
    expect(await connect(url, { origin: "http://evil.example", cookie })).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("rejects upgrades with a bad Host", async () => {
    const cookie = await login(env);
    expect(await connect(url, { origin, cookie, host: "evil.example:1" })).toMatchObject({
      ok: false,
      status: 421,
    });
  });

  it("sends a snapshot to an authenticated client", async () => {
    const cookie = await login(env);
    const r = await connect(url, { origin, cookie });
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.first ?? "{}")).toMatchObject({ t: "snapshot" });
  });
});
