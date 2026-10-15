import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, rotateToken, statePaths, validateConfig } from "../server/config.js";
import { computeAllowedHosts, originAllowed, tokensMatch } from "../server/auth.js";

describe("config", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "ensemble-cfg-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates config.json with private modes on first run", async () => {
    const cfg = await loadConfig(dir);
    const p = statePaths(dir);
    expect(statSync(p.root).mode & 0o777).toBe(0o700);
    expect(statSync(p.sessions).mode & 0o777).toBe(0o700);
    expect(statSync(p.config).mode & 0o777).toBe(0o600);
    expect(cfg.uiToken.length).toBeGreaterThanOrEqual(32);
    expect(cfg.hookPort).toBeGreaterThanOrEqual(49152);
    const again = await loadConfig(dir);
    expect(again.uiToken).toBe(cfg.uiToken);
    expect(again.hookPort).toBe(cfg.hookPort);
  });

  it("rotates the token", async () => {
    const cfg = await loadConfig(dir);
    const next = rotateToken(dir, cfg);
    expect(next.uiToken).not.toBe(cfg.uiToken);
    expect(JSON.parse(readFileSync(statePaths(dir).config, "utf8")).uiToken).toBe(next.uiToken);
  });

  it("rejects invalid values", () => {
    expect(() => validateConfig({ version: 1, uiToken: "short", hookPort: 50000 })).toThrow();
    expect(() =>
      validateConfig({ version: 1, uiToken: "x".repeat(32), hookPort: 70000 }),
    ).toThrow();
    expect(() =>
      validateConfig({
        version: 1,
        uiToken: "x".repeat(32),
        hookPort: 50000,
        cliPaths: { claude: "relative" },
      }),
    ).toThrow();
    const ok = validateConfig({
      version: 1,
      uiToken: "x".repeat(32),
      hookPort: 50000,
      portBase: 42000,
    });
    expect(ok.portBase).toBe(42000);
    expect(ok.branchPrefix).toBe("ens");
  });
});

describe("auth helpers", () => {
  it("computes allowed hosts", () => {
    const hosts = computeAllowedHosts("127.0.0.1", 4800);
    expect(hosts.has("127.0.0.1:4800")).toBe(true);
    expect(hosts.has("localhost:4800")).toBe(true);
    expect(hosts.has("example.com:4800")).toBe(false);
    expect(computeAllowedHosts("100.64.0.1", 4800).has("100.64.0.1:4800")).toBe(true);
    expect(computeAllowedHosts("127.0.0.1", 4800, ["mymac.tail:4800"]).has("mymac.tail:4800")).toBe(
      true,
    );
  });
  it("checks origins strictly", () => {
    const hosts = computeAllowedHosts("127.0.0.1", 4800);
    expect(originAllowed("http://127.0.0.1:4800", hosts)).toBe(true);
    expect(originAllowed("http://127.0.0.1:4801", hosts)).toBe(false);
    expect(originAllowed("null", hosts)).toBe(false);
    expect(originAllowed(undefined, hosts)).toBe(false);
    expect(originAllowed("file://x", hosts)).toBe(false);
  });
  it("compares tokens without leaking length", () => {
    expect(tokensMatch("abc", "abc")).toBe(true);
    expect(tokensMatch("abc", "abcd")).toBe(false);
  });
});
