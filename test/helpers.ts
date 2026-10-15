import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp, type App } from "../server/app.js";
import { defaultConfig, ensureStateDirs } from "../server/config.js";
import { openDb, type Db } from "../server/db/index.js";
import { Tmux } from "../server/tmux.js";

export interface TestEnv {
  dir: string;
  db: Db;
  app: App;
  tmux: Tmux;
  token: string;
  host: string;
  cleanup: () => Promise<void>;
}

export const TEST_PORT = 4999;

/** Builds an app with a temp state dir, a file DB, a private tmux socket, and no web assets. */
export async function makeTestApp(): Promise<TestEnv> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ensemble-test-"));
  ensureStateDirs(dir);
  const db = openDb(path.join(dir, "ensemble.db"));
  const config = defaultConfig("test-token-0123456789abcdef", 50000);
  config.workspaceRoot = path.join(dir, "workspaces-root");
  const tmux = new Tmux({ socketName: `ensemble-test-${process.pid}` });
  const app = await buildApp({
    config,
    db,
    stateDir: dir,
    host: "127.0.0.1",
    port: TEST_PORT,
    webDist: path.join(dir, "no-web"),
    tmux,
  });
  return {
    dir,
    db,
    app,
    tmux,
    token: config.uiToken,
    host: `127.0.0.1:${TEST_PORT}`,
    cleanup: async () => {
      await app.fastify.close();
      await tmux.killServer();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Logs in through /login and returns the cookie header value. */
export async function login(env: TestEnv): Promise<string> {
  const res = await env.app.fastify.inject({
    method: "GET",
    url: `/login?token=${env.token}`,
    headers: { host: env.host },
  });
  if (res.statusCode !== 302) throw new Error(`login failed: ${res.statusCode}`);
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!raw) throw new Error("no cookie");
  return raw.split(";")[0] ?? "";
}
