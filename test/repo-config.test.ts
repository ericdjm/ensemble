import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRepoConfig, readRepoConfigFile, scriptHash } from "../server/repo-config.js";

describe(".ensemble.json parsing", () => {
  it("accepts the documented example", () => {
    const cfg = parseRepoConfig({
      setup: "pnpm install",
      run: "pnpm dev --port $ENSEMBLE_PORT",
      archive: "",
      copy: [".env", ".env.local"],
      defaultAgent: "claude",
    });
    expect(cfg).toEqual({
      setup: "pnpm install",
      run: "pnpm dev --port $ENSEMBLE_PORT",
      archive: null,
      copy: [".env", ".env.local"],
      defaultAgent: "claude",
    });
  });

  it("rejects unsafe copy patterns and bad types", () => {
    expect(() => parseRepoConfig({ copy: ["/etc/passwd"] })).toThrow(/relative/);
    expect(() => parseRepoConfig({ copy: ["../secret"] })).toThrow(/\.\./);
    expect(() => parseRepoConfig({ copy: ["~/x"] })).toThrow(/home/);
    expect(() => parseRepoConfig({ copy: [".git/config"] })).toThrow(/\.git/);
    expect(() => parseRepoConfig({ copy: ["a//b"] })).toThrow(/empty/);
    expect(() => parseRepoConfig({ copy: "not-an-array" })).toThrow();
    expect(() => parseRepoConfig({ setup: 42 })).toThrow();
    expect(() => parseRepoConfig({ defaultAgent: "gemini" })).toThrow();
    expect(() => parseRepoConfig([])).toThrow();
  });

  it("hashes scripts deterministically", () => {
    expect(scriptHash("pnpm install")).toBe(scriptHash("pnpm install"));
    expect(scriptHash("pnpm install")).not.toBe(scriptHash("pnpm install "));
  });
});

describe("readRepoConfigFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "ensemble-rc-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("handles missing, broken, and valid files", () => {
    expect(readRepoConfigFile(dir)).toMatchObject({ exists: false, error: null });
    writeFileSync(path.join(dir, ".ensemble.json"), "{ nope");
    expect(readRepoConfigFile(dir)).toMatchObject({ exists: true });
    expect(readRepoConfigFile(dir).error).not.toBeNull();
    writeFileSync(path.join(dir, ".ensemble.json"), JSON.stringify({ setup: "make" }));
    expect(readRepoConfigFile(dir)).toMatchObject({
      exists: true,
      error: null,
      config: { setup: "make" },
    });
  });
});
