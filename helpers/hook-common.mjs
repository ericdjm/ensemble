// Shared, dependency-free code for the hook helpers and the agent launcher (docs/architecture.md §7.6).
// Durable-first: every envelope is written to the session spool under a lock before delivery is attempted.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const LOCK_RETRIES = 20;
export const LOCK_INTERVAL_MS = 25;
export const LOCK_STALE_MS = 10_000;
export const DEFAULT_DELIVERY_TIMEOUT_MS = 2000;

/** Replaces stdout/stderr writes with no-ops so nothing can reach the agent's hook output. */
export function silence() {
  process.stdout.write = () => true;
  process.stderr.write = () => true;
}

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Reads all of stdin synchronously up to `cap` bytes. */
export function readStdinCapped(cap) {
  const chunks = [];
  let total = 0;
  let truncated = false;
  const buf = Buffer.alloc(64 * 1024);
  for (;;) {
    let n;
    try {
      n = fs.readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if (e.code === "EAGAIN") {
        sleepSync(5);
        continue;
      }
      if (e.code === "EOF") break;
      throw e;
    }
    if (n === 0) break;
    if (total + n > cap) {
      chunks.push(Buffer.from(buf.subarray(0, Math.max(0, cap - total))));
      truncated = true;
      break;
    }
    chunks.push(Buffer.from(buf.subarray(0, n)));
    total += n;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

export function sessionDirFromEnv(argv) {
  return (
    argv.find((a) => a.startsWith("--session-dir="))?.slice("--session-dir=".length) ??
    process.env.ENSEMBLE_SESSION_DIR ??
    null
  );
}

/** hook.json: { sessionId, token, port, generation, limits: { payloadCapBytes, totalCapBytes } } */
export function loadSessionConfig(sessionDir) {
  return JSON.parse(fs.readFileSync(path.join(sessionDir, "hook.json"), "utf8"));
}

export function spoolDir(sessionDir) {
  return path.join(sessionDir, "spool");
}

/** Runs fn while holding the spool lock. Bounded wait; a stale lock is broken. Throws if the lock cannot be taken. */
export function withSpoolLock(sessionDir, fn) {
  const dir = spoolDir(sessionDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, "lock");
  for (let i = 0; i < LOCK_RETRIES; i++) {
    try {
      const fd = fs.openSync(lock, "wx", 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      try {
        return fn(dir);
      } finally {
        try {
          fs.unlinkSync(lock);
        } catch {
          /* already gone */
        }
      }
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lock);
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

export function readState(dir) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    if (Number.isInteger(s.generation) && Number.isInteger(s.seq)) return s;
  } catch {
    /* fresh */
  }
  return { generation: 1, seq: 0 };
}

export function writeJsonAtomic(file, value, mode = 0o600) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode });
  fs.renameSync(tmp, file);
}

function spoolBytes(dir) {
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json") || name === "state.json" || name === "gap.json") continue;
    try {
      total += fs.statSync(path.join(dir, name)).size;
    } catch {
      /* raced */
    }
  }
  return total;
}

export function recordName(generation, seq) {
  return `${generation}-${String(seq).padStart(10, "0")}.json`;
}

/**
 * Allocates a sequence number and writes the envelope to the spool (or a bounded gap marker when full).
 * Mutates `envelope` to add generation and seq. Returns { recordPath | null, dropped }.
 */
export function enqueue(sessionDir, cfg, envelope) {
  return withSpoolLock(sessionDir, (dir) => {
    const state = readState(dir);
    state.seq += 1;
    envelope.generation = state.generation;
    envelope.seq = state.seq;
    const data = JSON.stringify(envelope);
    const totalCap = cfg?.limits?.totalCapBytes ?? 64 * 1024 * 1024;
    let recordPath = null;
    let dropped = false;
    if (spoolBytes(dir) + data.length > totalCap) {
      dropped = true;
      const gapFile = path.join(dir, "gap.json");
      let gap = null;
      try {
        gap = JSON.parse(fs.readFileSync(gapFile, "utf8"));
      } catch {
        /* none */
      }
      if (!gap || gap.generation !== state.generation) {
        gap = {
          generation: state.generation,
          fromSeq: state.seq,
          toSeq: state.seq,
          count: 1,
          reason: "spool_full",
        };
      } else {
        gap.toSeq = state.seq;
        gap.count += 1;
      }
      writeJsonAtomic(gapFile, gap);
    } else {
      recordPath = path.join(dir, recordName(state.generation, state.seq));
      const tmp = `${recordPath}.tmp`;
      fs.writeFileSync(tmp, data, { mode: 0o600 });
      fs.renameSync(tmp, recordPath);
    }
    writeJsonAtomic(path.join(dir, "state.json"), state);
    return { recordPath, dropped };
  });
}

/** POSTs the envelope once. Resolves true only when the server says it committed. Never throws. */
export async function deliver(cfg, envelope, timeoutMs = DEFAULT_DELIVERY_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(
      `http://127.0.0.1:${cfg.port}/api/hooks/${encodeURIComponent(envelope.sessionId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify(envelope),
        signal: controller.signal,
      },
    );
    let committed = false;
    try {
      const text = await res.text();
      committed = res.ok && JSON.parse(text).committed === true;
    } catch {
      committed = false;
    }
    return committed;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function makeEnvelope(cfg, fields) {
  return {
    id: crypto.randomUUID(),
    sessionId: cfg.sessionId,
    generation: 0,
    seq: 0,
    source: fields.source,
    type: fields.type,
    tool: fields.tool ?? null,
    sourceTs: new Date().toISOString(),
    truncated: fields.truncated ?? false,
    payload: fields.payload ?? {},
  };
}

/** Spool first, then one delivery attempt; the record is removed only after a committed acknowledgement. */
export async function enqueueAndDeliver(sessionDir, cfg, envelope, timeoutMs) {
  let recordPath = null;
  try {
    ({ recordPath } = enqueue(sessionDir, cfg, envelope));
  } catch {
    // Storage failure: still try a direct delivery so the server may see it; nothing durable is possible.
  }
  const committed = await deliver(cfg, envelope, timeoutMs);
  if (committed && recordPath) {
    try {
      fs.unlinkSync(recordPath);
    } catch {
      /* already drained */
    }
  }
  return committed;
}
