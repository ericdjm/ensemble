import { describe, expect, it } from "vitest";
import { buildApp } from "../server/app.js";
import { parseArgs } from "../server/index.js";

describe("app", () => {
  it("serves the health route", async () => {
    const app = await buildApp({ webDist: "/nonexistent/web/dist" });
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, name: "Ensemble" });
    await app.close();
  });
});

describe("parseArgs", () => {
  it("defaults to loopback", () => {
    expect(parseArgs([])).toEqual({ host: "127.0.0.1", port: 4800 });
  });
  it("accepts --host and --port", () => {
    expect(parseArgs(["--host", "100.64.0.1", "--port", "5000"])).toEqual({
      host: "100.64.0.1",
      port: 5000,
    });
  });
  it("rejects bad ports and unknown flags", () => {
    expect(() => parseArgs(["--port", "nope"])).toThrow();
    expect(() => parseArgs(["--bogus"])).toThrow();
  });
});
