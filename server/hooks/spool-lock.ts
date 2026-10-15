import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

const LOCK_RETRIES = 40;
const LOCK_INTERVAL_MS = 25;
const LOCK_STALE_MS = 10_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Same lock protocol as helpers/hook-common.mjs so server-side generation changes exclude hook writers. */
export function withSpoolLock<T>(sessionDir: string, fn: (spoolDir: string) => T): T {
  const dir = path.join(sessionDir, "spool");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, "lock");
  for (let i = 0; i < LOCK_RETRIES; i++) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      try {
        return fn(dir);
      } finally {
        try {
          unlinkSync(lock);
        } catch {
          /* already gone */
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lock);
          continue;
        }
      } catch {
        continue;
      }
      sleepSync(LOCK_INTERVAL_MS);
    }
  }
  throw new Error("spool lock busy");
}
