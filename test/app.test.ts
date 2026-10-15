import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../server/index.js";
import { login, makeTestApp, type TestEnv } from "./helpers.js";

describe("auth and routing", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeTestApp();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("rejects requests with an unknown Host header", async () => {
    const res = await env.app.fastify.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "evil.example:4999" },
    });
    expect(res.statusCode).toBe(421);
  });

  it("requires login for API routes", async () => {
    const res = await env.app.fastify.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: env.host },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects a wrong token", async () => {
    const res = await env.app.fastify.inject({
      method: "GET",
      url: "/login?token=wrong",
      headers: { host: env.host },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("exchanges the token for an HttpOnly SameSite=Strict cookie", async () => {
    const res = await env.app.fastify.inject({
      method: "GET",
      url: `/login?token=${env.token}`,
      headers: { host: env.host },
    });
    expect(res.statusCode).toBe(302);
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  it("serves the health route once logged in", async () => {
    const cookie = await login(env);
    const res = await env.app.fastify.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: env.host, cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, name: "Ensemble" });
  });

  it("persists browser sessions across app instances", async () => {
    const cookie = await login(env);
    const { buildApp } = await import("../server/app.js");
    const { defaultConfig } = await import("../server/config.js");
    const second = await buildApp({
      config: defaultConfig(env.token, 50000),
      db: env.db,
      host: "127.0.0.1",
      port: 4999,
      webDist: "/nonexistent",
    });
    const res = await second.fastify.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: env.host, cookie },
    });
    expect(res.statusCode).toBe(200);
    await second.fastify.close();
  });
});

describe("parseArgs", () => {
  it("defaults to loopback", () => {
    expect(parseArgs([])).toMatchObject({
      host: "127.0.0.1",
      port: 4800,
      open: true,
      command: "start",
    });
  });
  it("accepts --host, --port, --no-open", () => {
    expect(parseArgs(["--host", "100.64.0.1", "--port", "5000", "--no-open"])).toMatchObject({
      host: "100.64.0.1",
      port: 5000,
      open: false,
    });
  });
  it("rejects bad ports and unknown flags", () => {
    expect(() => parseArgs(["--port", "nope"])).toThrow();
    expect(() => parseArgs(["--bogus"])).toThrow();
  });
});
