import { existsSync, readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import path from "node:path";
import { statePaths } from "../config.js";
import { isEnvelope, type HookIngest } from "./ingest.js";

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
