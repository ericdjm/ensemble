import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type App } from "../server/app.js";
import { defaultConfig, ensureStateDirs, pickFreeHookPort } from "../server/config.js";
import { openDb, type Db } from "../server/db/index.js";
import { hashToken } from "../server/sessions.js";
import { Tmux } from "../server/tmux.js";

/** Non-loopback UI binding (e.g. --host <tailscale-ip>) must not move the hook listener off 127.0.0.1. */
describe("--host hardening", () => {
  let dir: string;
  let db: Db;
  let app: App;
  let tmux: Tmux;
  const uiHost = "100.64.0.1";
  const token = "hook-token-xyz";
  const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "ensemble-host-"));
    ensureStateDirs(dir);
    db = openDb(path.join(dir, "ensemble.db"));
    const config = defaultConfig("t".repeat(32), await pickFreeHookPort());
    config.allowedHosts = ["mymac.tailnet.ts.net:4999"];
    tmux = new Tmux({ socketName: `ensemble-host-test-${process.pid}` });
    app = await buildApp({
      config,
      db,
      stateDir: dir,
      host: uiHost,
      port: 4999,
      webDist: path.join(dir, "none"),
      tmux,
    });
    await app.start();
    db.prepare(
      "INSERT INTO repos (id, path, name, slug, default_base, created_at) VALUES ('r', '/tmp/r', 'r', 'r', 'main', 'now')",
    ).run();
    db.prepare(
      "INSERT INTO workspaces (id, repo_id, name, branch, path, base_branch, port, status, created_at) VALUES ('w', 'r', 'w', 'ens/w', '/tmp/w', 'main', 41000, 'ready', 'now')",
    ).run();
    db.prepare(
      "INSERT INTO sessions (id, workspace_id, agent, tmux_name, status, process_state, hook_token_hash, created_at) VALUES (?, 'w', 'claude', 'ens-aaaa', 'starting', 'running', ?, 'now')",
    ).run(sessionId, hashToken(token));
  });
  afterEach(async () => {
    await app.fastify.close();
    await tmux.killServer();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts the UI only on the configured hosts", async () => {
    const login = (host: string) =>
      app.fastify.inject({
        method: "GET",
        url: `/login?token=${"t".repeat(32)}`,
        headers: { host },
      });
    expect((await login(`${uiHost}:4999`)).statusCode).toBe(302);
    expect((await login("mymac.tailnet.ts.net:4999")).statusCode).toBe(302);
    expect((await login("127.0.0.1:4999")).statusCode).toBe(302);
    expect((await login("evil.example:4999")).statusCode).toBe(421);
    expect((await login(`${uiHost}:4998`)).statusCode).toBe(421);
  });

  it("keeps the hook listener on 127.0.0.1 with its own Host rule and token auth", async () => {
    const port = app.services.listener.state.port;
    expect(app.services.listener.state.ok).toBe(true);
    const post = (host: string, auth?: string) =>
      new Promise<number>((resolve) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            method: "POST",
            path: `/api/hooks/${sessionId}`,
            headers: {
              host,
              "content-type": "application/json",
              ...(auth ? { authorization: auth } : {}),
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", () => resolve(-1));
        req.end(
          JSON.stringify({
            id: "h1",
            sessionId,
            generation: 1,
            seq: 1,
            source: "test",
            type: "SessionStart",
            tool: null,
            sourceTs: "x",
            truncated: false,
            payload: { session_id: "c1" },
          }),
        );
      });
    expect(await post(`127.0.0.1:${port}`, `Bearer ${token}`)).toBe(200);
    expect(await post(`${uiHost}:${port}`, `Bearer ${token}`)).toBe(421);
    expect(await post(`127.0.0.1:${port}`)).toBe(401);
    // Nothing listens for hooks on the UI host.
    const addr = app.services.listener.state;
    expect(addr.port).not.toBe(4999);
  });

  it("rejects WebSocket upgrades whose Origin is not an allowed host", async () => {
    const { originAllowed } = await import("../server/auth.js");
    expect(originAllowed(`http://${uiHost}:4999`, app.allowedHosts)).toBe(true);
    expect(originAllowed("http://mymac.tailnet.ts.net:4999", app.allowedHosts)).toBe(true);
    expect(originAllowed("http://evil.example", app.allowedHosts)).toBe(false);
  });
});
