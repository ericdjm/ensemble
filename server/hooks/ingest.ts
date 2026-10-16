import { timingSafeEqual } from "node:crypto";
import { unlinkSync } from "node:fs";
import type { EventEnvelope } from "../../shared/types.js";
import { captureAnswer } from "../answers.js";
import type { Db } from "../db/index.js";
import { nowIso } from "../db/index.js";
import { hashToken, turnStateFromRow, type SessionRow, type SessionService } from "../sessions.js";
import { reduce, shouldNotify } from "./reducer.js";

export interface IngestResult {
  committed: boolean;
  status: number;
  reason?: string | undefined;
}

// Lazy import avoids a module cycle (spool.ts imports isEnvelope from here).
import * as spoolModule from "./spool.js";
function requireSpool(): typeof spoolModule {
  return spoolModule;
}

export function isEnvelope(v: unknown): v is EventEnvelope {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e["id"] === "string" &&
    e["id"].length > 0 &&
    e["id"].length <= 64 &&
    typeof e["sessionId"] === "string" &&
    Number.isInteger(e["generation"]) &&
    Number.isInteger(e["seq"]) &&
    (e["seq"] as number) >= 1 &&
    typeof e["source"] === "string" &&
    typeof e["type"] === "string" &&
    typeof e["sourceTs"] === "string"
  );
}

/** Shared ingestion for live POSTs and spool replay: verify, dedupe, reduce in order, commit, then ack. */
export class HookIngest {
  constructor(
    private readonly db: Db,
    private readonly sessions: SessionService,
  ) {}

  verifyToken(sessionId: string, token: string | undefined): boolean {
    if (!token) return false;
    const row = this.db
      .prepare("SELECT hook_token_hash FROM sessions WHERE id = ?")
      .get(sessionId) as { hook_token_hash: string | null } | undefined;
    if (!row?.hook_token_hash) return false;
    const a = Buffer.from(hashToken(token), "hex");
    const b = Buffer.from(row.hook_token_hash, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Records a server-originated event (handoff, relay hop) in the session's ordered history. It goes
   * through the spool like a hook event so sequence numbers stay unique; the record is removed on commit.
   */
  appendInternal(sessionId: string, type: string, payload: unknown): IngestResult {
    const { enqueueLocal } = requireSpool();
    const { envelope, recordPath } = enqueueLocal(this.sessions.sessionDir(sessionId), {
      sessionId,
      type,
      payload,
    });
    const result = this.ingest(envelope, { replay: false });
    if (result.committed) {
      try {
        unlinkSync(recordPath);
      } catch {
        /* drained concurrently */
      }
    }
    return result;
  }

  ingest(envelope: EventEnvelope, opts: { replay: boolean }): IngestResult {
    // File reads for the transcript fallback happen outside the transaction.
    const answer = captureAnswer(envelope.type, envelope.payload);
    const run = this.db.transaction((): IngestResult => {
      const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(envelope.sessionId) as
        SessionRow | undefined;
      if (!row) return { committed: false, status: 404, reason: "unknown session" };
      if (envelope.generation !== row.hook_generation)
        return { committed: false, status: 409, reason: "generation" };
      const inserted = this.db
        .prepare(
          "INSERT OR IGNORE INTO events (event_id, session_id, generation, seq, type, tool_name, source_ts, ingested_at, truncated, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          envelope.id,
          row.id,
          envelope.generation,
          envelope.seq,
          envelope.type,
          envelope.tool,
          envelope.sourceTs,
          nowIso(),
          envelope.truncated ? 1 : 0,
          JSON.stringify(envelope.payload ?? null),
        );
      if (inserted.changes === 0) return { committed: true, status: 200, reason: "duplicate" };
      if (envelope.seq <= row.last_seq) return { committed: true, status: 200, reason: "late" };

      const before = turnStateFromRow(row);
      let after = reduce(before, envelope);
      if (envelope.seq > row.last_seq + 1 && row.last_seq > 0) {
        this.recordGap(
          row.id,
          envelope.generation,
          row.last_seq + 1,
          envelope.seq - 1,
          "missing_sequence",
        );
        after = { ...after, freshness: "stale" };
      } else if (
        after.freshness === "stale" &&
        (envelope.type === "Stop" || envelope.type === "UserPromptSubmit")
      ) {
        after = { ...after, freshness: "current" };
      }
      this.db
        .prepare(
          `UPDATE sessions SET last_seq = ?, status = ?, pending_inputs_json = ?, cli_session_id = ?, transcript_path = ?, freshness = ?,
             auth_mode = ?, auth_label = ?, auth_checked_at = ?, refusal_reason = ?,
             remote_control = CASE WHEN ? IS NULL THEN remote_control ELSE ? END,
             ended_at = CASE WHEN ? = 'exited' THEN COALESCE(ended_at, ?) ELSE ended_at END,
             last_answer = COALESCE(?, last_answer),
             last_answer_at = CASE WHEN ? IS NULL THEN last_answer_at ELSE ? END,
             last_answer_source = COALESCE(?, last_answer_source)
           WHERE id = ?`,
        )
        .run(
          envelope.seq,
          after.status,
          JSON.stringify(after.pending),
          after.cliSessionId,
          after.transcriptPath,
          after.freshness,
          after.authMode,
          after.authLabel,
          after.authCheckedAt,
          after.refusalReason,
          after.remoteControl === null ? null : 1,
          after.remoteControl ? 1 : 0,
          after.status,
          nowIso(),
          answer?.text ?? null,
          answer?.text ?? null,
          envelope.sourceTs,
          answer?.source ?? null,
          row.id,
        );
      const notify = !opts.replay && shouldNotify(before, after);
      return { committed: true, status: 200, reason: notify ? "notify" : undefined };
    });
    const result = run();
    if (result.committed && result.reason !== "duplicate" && result.reason !== "late") {
      if (!opts.replay) this.sessions.emitChanged(envelope.sessionId, result.reason === "notify");
      this.sessions.emit("event", envelope);
      if (envelope.type === "Stop" || envelope.type === "agent-turn-complete") {
        this.sessions.emit("stop", envelope.sessionId);
      }
    }
    return result;
  }

  recordGap(
    sessionId: string,
    generation: number,
    fromSeq: number,
    toSeq: number,
    reason: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO event_gaps (session_id, generation, from_seq, to_seq, count, reason, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, generation, reason) DO UPDATE SET from_seq = MIN(from_seq, excluded.from_seq), to_seq = MAX(to_seq, excluded.to_seq), count = count + excluded.count, recorded_at = excluded.recorded_at`,
      )
      .run(sessionId, generation, fromSeq, toSeq, toSeq - fromSeq + 1, reason, nowIso());
    this.db.prepare("UPDATE sessions SET freshness = 'stale' WHERE id = ?").run(sessionId);
  }
}
