import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { packageRoot } from "../server/paths.js";

export const FAKE_AGENT = path.join(packageRoot(), "test", "fixtures", "fake-agent.mjs");
export const HELPERS = path.join(packageRoot(), "helpers");

export interface FakeSessionDir {
  dir: string;
  sessionId: string;
  token: string;
}

/** Creates a session directory with hook.json pointing at the given listener port. */
export function makeSessionDir(
  port: number,
  overrides: Partial<{ generation: number; totalCapBytes: number; payloadCapBytes: number }> = {},
): FakeSessionDir {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ensemble-sess-"));
  const sessionId = `sess-${path.basename(dir)}`;
  const token = "tok-" + path.basename(dir);
  mkdirSync(path.join(dir, "spool"), { mode: 0o700 });
  writeFileSync(
    path.join(dir, "hook.json"),
    JSON.stringify({
      sessionId,
      token,
      port,
      generation: overrides.generation ?? 1,
      limits: {
        payloadCapBytes: overrides.payloadCapBytes ?? 256 * 1024,
        totalCapBytes: overrides.totalCapBytes ?? 64 * 1024 * 1024,
      },
    }),
    { mode: 0o600 },
  );
  if (overrides.generation !== undefined) {
    writeFileSync(
      path.join(dir, "spool", "state.json"),
      JSON.stringify({ generation: overrides.generation, seq: 0 }),
    );
  }
  chmodSync(dir, 0o700);
  return { dir, sessionId, token };
}
