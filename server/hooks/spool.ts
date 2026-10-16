import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "../../shared/types.js";
import { statePaths } from "../config.js";
import { isEnvelope, type HookIngest } from "./ingest.js";
import { withSpoolLock } from "./spool-lock.js";

/**
 * Allocates the next sequence number in a session's spool and writes the record, exactly like the
 * hook helpers do, so server-originated events (handoffs, relays) share one ordered history.
 * Returns the record path; the caller deletes it once the event is committed.
 */
export function enqueueLocal(
  sessionDir: string,
  fields: { sessionId: string; type: string; payload: unknown; source?: string },
): { envelope: EventEnvelope; recordPath: string } {
  return withSpoolLock(sessionDir, (spool) => {
    let state = { generation: 1, seq: 0 };
    try {
      const s = JSON.parse(readFileSync(path.join(spool, "state.json"), "utf8")) as {
        generation?: unknown;
        seq?: unknown;
      };
      if (Number.isInteger(s.generation) && Number.isInteger(s.seq))
        state = { generation: s.generation as number, seq: s.seq as number };
    } catch {
      /* fresh spool */
    }
    state.seq += 1;
    const envelope: EventEnvelope = {
      id: randomUUID(),
      sessionId: fields.sessionId,
      generation: state.generation,
      seq: state.seq,
      source: fields.source ?? "ensemble",
      type: fields.type,
      tool: null,
      sourceTs: new Date().toISOString(),
      truncated: false,
      payload: fields.payload,
    };
    const recordPath = path.join(
      spool,
      `${state.generation}-${String(state.seq).padStart(10, "0")}.json`,
    );
    const tmp = `${recordPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(envelope), { mode: 0o600 });
    renameSync(tmp, recordPath);
    const stateTmp = path.join(spool, `state.json.${process.pid}.tmp`);
    writeFileSync(stateTmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(stateTmp, path.join(spool, "state.json"));
    return { envelope, recordPath };
  });
}

export interface DrainSummary {
  ingested: number;
  deleted: number;
  rejected: number;
  sessions: string[];
}

/**
 * Drains every session spool on disk (regardless of session state) in (generation, seq) order,
 * deleting records only after they were committed. Gap markers become event_gaps rows.
 */
export function drainSpools(
  stateDir: string,
  ingest: HookIngest,
  onSessionDrained: (sessionId: string) => void = () => undefined,
): DrainSummary {
  const summary: DrainSummary = { ingested: 0, deleted: 0, rejected: 0, sessions: [] };
  const root = statePaths(stateDir).sessions;
  if (!existsSync(root)) return summary;
  for (const sessionId of readdirSync(root)) {
    const spool = path.join(root, sessionId, "spool");
    if (!existsSync(spool)) continue;
    const records = readdirSync(spool)
      .filter((n) => /^\d+-\d{10}\.json$/.test(n))
      .sort();
    let touched = false;
    for (const name of records) {
      const file = path.join(spool, name);
      let envelope: unknown;
      try {
        envelope = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        summary.rejected += 1;
        const parts = /^(\d+)-(\d{10})\.json$/.exec(name);
        const gen = Number(parts?.[1] ?? 0);
        const seqNo = Number(parts?.[2] ?? 0);
        ingest.recordGap(sessionId, gen, seqNo, seqNo, "corrupt_record");
        rmSync(file, { force: true });
        continue;
      }
      if (!isEnvelope(envelope) || envelope.sessionId !== sessionId) {
        summary.rejected += 1;
        rmSync(file, { force: true });
        continue;
      }
      const result = ingest.ingest(envelope, { replay: true });
      if (result.committed || result.status === 409 || result.status === 404) {
        // Committed, cleared history, or a session that no longer exists: the record has no future.
        unlinkSync(file);
        summary.deleted += 1;
        if (result.committed) summary.ingested += 1;
        else summary.rejected += 1;
        touched = touched || result.committed;
      }
    }
    const gapFile = path.join(spool, "gap.json");
    if (existsSync(gapFile)) {
      try {
        const gap = JSON.parse(readFileSync(gapFile, "utf8")) as {
          generation: number;
          fromSeq: number;
          toSeq: number;
          reason: string;
        };
        ingest.recordGap(sessionId, gap.generation, gap.fromSeq, gap.toSeq, gap.reason);
        touched = true;
      } catch {
        /* unreadable marker: nothing recoverable */
      }
      rmSync(gapFile, { force: true });
    }
    if (touched) {
      summary.sessions.push(sessionId);
      onSessionDrained(sessionId);
    }
  }
  return summary;
}
