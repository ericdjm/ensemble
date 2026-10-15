import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Hard constraint from the spec: application source must never reference the CLIs'
 * credential stores. This test (also run in CI) fails on any hit.
 */
const ROOT = path.resolve(import.meta.dirname, "..");
const SCANNED_DIRS = ["server", "helpers", "shared", "bin", path.join("web", "src")];
const FORBIDDEN = [
  ".credentials.json",
  ".claude.json",
  "auth.json",
  "find-generic-password",
  "find-internet-password",
  "Keychain",
  "keychain",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

describe("credential path check", () => {
  it("source never references credential stores", () => {
    const hits: string[] = [];
    for (const dir of SCANNED_DIRS) {
      const abs = path.join(ROOT, dir);
      let files: string[];
      try {
        files = walk(abs);
      } catch {
        continue;
      }
      for (const file of files) {
        const text = readFileSync(file, "utf8");
        for (const needle of FORBIDDEN) {
          if (text.includes(needle)) hits.push(`${path.relative(ROOT, file)}: ${needle}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
