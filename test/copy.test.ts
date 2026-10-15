import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCopyPlan, CopyPlanError, validatePattern } from "../server/copy/plan.js";
import { CopyError, runCopyPlan } from "../server/copy/run.js";

describe("copy pattern validation", () => {
  it("rejects escapes", () => {
    expect(validatePattern("/etc/passwd")).toMatch(/relative/);
    expect(validatePattern("~/.ssh/id_rsa")).toMatch(/home/);
    expect(validatePattern("../x")).toMatch(/\.\./);
    expect(validatePattern("a/../b")).toMatch(/\.\./);
    expect(validatePattern(".git/config")).toMatch(/\.git/);
    expect(validatePattern("a\\b")).toMatch(/slash/);
    expect(validatePattern("")).not.toBeNull();
    expect(validatePattern(".env*")).toBeNull();
    expect(validatePattern("config/**/*.local")).toBeNull();
  });
});

describe("copy plan and worker", () => {
  let base: string;
  let src: string;
  let dst: string;
  let outside: string;

  beforeEach(() => {
    base = mkdtempSync(path.join(os.tmpdir(), "ensemble-copy-"));
    src = path.join(base, "src");
    dst = path.join(base, "dst");
    outside = path.join(base, "outside");
    for (const d of [
      src,
      dst,
      outside,
      path.join(src, "config"),
      path.join(src, ".git"),
      path.join(src, "node_modules", "x"),
    ]) {
      mkdirSync(d, { recursive: true });
    }
    writeFileSync(path.join(src, ".env"), "SECRET=1\n", { mode: 0o600 });
    writeFileSync(path.join(src, ".env.local"), "LOCAL=1\n");
    writeFileSync(path.join(src, "config", ".env.local"), "NESTED=1\n");
    writeFileSync(path.join(src, "README.md"), "readme\n");
    writeFileSync(path.join(src, ".git", "config"), "[core]\n");
    writeFileSync(path.join(src, "node_modules", "x", ".env"), "NM=1\n");
    writeFileSync(path.join(dst, ".git"), "gitdir: /elsewhere\n");
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("copies matching regular files and preserves content and mode", async () => {
    const plan = buildCopyPlan([".env*", "config/.env.local"], src, dst);
    expect(plan.entries.map((e) => e.relPath)).toEqual([".env", ".env.local", "config/.env.local"]);
    const results = await runCopyPlan(plan);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(readFileSync(path.join(dst, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(statSync(path.join(dst, ".env")).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(dst, "config", ".env.local"), "utf8")).toBe("NESTED=1\n");
    expect(readFileSync(path.join(dst, ".git"), "utf8")).toBe("gitdir: /elsewhere\n");
  });

  it("never matches inside .git and skips node_modules unless asked", () => {
    const plan = buildCopyPlan(["**/config", "**/.env"], src, dst);
    expect(plan.entries.map((e) => e.relPath)).toEqual([".env"]);
    const nm = buildCopyPlan(["node_modules/**/.env"], src, dst);
    expect(nm.entries.map((e) => e.relPath)).toEqual(["node_modules/x/.env"]);
  });

  it("rejects symlinked sources", () => {
    writeFileSync(path.join(outside, "secret"), "outside\n");
    symlinkSync(path.join(outside, "secret"), path.join(src, ".env.link"));
    expect(() => buildCopyPlan([".env*"], src, dst)).toThrow(CopyPlanError);
    expect(() => buildCopyPlan([".env*"], src, dst)).toThrow(/symlink/);
  });

  it("rejects overlapping roots", () => {
    expect(() => buildCopyPlan([".env"], src, path.join(src, "config"))).toThrow(/disjoint/);
  });

  it("fails closed when a destination parent is a symlink", async () => {
    mkdirSync(path.join(outside, "config"));
    symlinkSync(path.join(outside, "config"), path.join(dst, "config"));
    const plan = buildCopyPlan(["config/.env.local"], src, dst);
    await expect(runCopyPlan(plan)).rejects.toThrow(/not a directory/);
    expect(existsSync(path.join(outside, "config", ".env.local"))).toBe(false);
  });

  it("aborts when a destination directory is swapped for a symlink during the copy", async () => {
    mkdirSync(path.join(dst, "config"));
    const plan = buildCopyPlan(["config/.env.local"], src, dst);
    await expect(
      runCopyPlan(plan, { testHooks: true, testHook: `dst:config:symlink:${outside}` }),
    ).rejects.toThrow(/replaced during copy/);
    expect(existsSync(path.join(outside, ".env.local"))).toBe(false);
    expect(lstatSync(path.join(dst, "config")).isSymbolicLink()).toBe(true); // attacker's link remains, unused
  });

  it("aborts when a destination directory is swapped for another directory", async () => {
    mkdirSync(path.join(dst, "config"));
    const plan = buildCopyPlan(["config/.env.local"], src, dst);
    await expect(
      runCopyPlan(plan, { testHooks: true, testHook: "dst:config:swapdir:" }),
    ).rejects.toThrow(/replaced during copy/);
    expect(existsSync(path.join(dst, "config", ".env.local"))).toBe(false);
  });

  it("aborts when a source directory is swapped for a symlink during the copy", async () => {
    mkdirSync(path.join(outside, "config"));
    writeFileSync(path.join(outside, "config", ".env.local"), "ATTACKER=1\n");
    const plan = buildCopyPlan(["config/.env.local"], src, dst);
    await expect(
      runCopyPlan(plan, {
        testHooks: true,
        testHook: `src:config:symlink:${path.join(outside, "config")}`,
      }),
    ).rejects.toThrow(/replaced during copy/);
    expect(existsSync(path.join(dst, "config", ".env.local"))).toBe(false);
  });

  it("aborts when a source file changed inode since planning", async () => {
    const plan = buildCopyPlan([".env"], src, dst);
    rmSync(path.join(src, ".env"));
    writeFileSync(path.join(src, ".env"), "REPLACED=1\n");
    await expect(runCopyPlan(plan)).rejects.toThrow(CopyError);
    expect(existsSync(path.join(dst, ".env"))).toBe(false);
  });

  it("ignores the test hook without the flag", async () => {
    mkdirSync(path.join(dst, "config"));
    const plan = buildCopyPlan(["config/.env.local"], src, dst);
    await expect(
      runCopyPlan(plan, { testHook: `dst:config:symlink:${outside}` }),
    ).resolves.toBeTruthy();
    expect(readFileSync(path.join(dst, "config", ".env.local"), "utf8")).toBe("NESTED=1\n");
  });
});
