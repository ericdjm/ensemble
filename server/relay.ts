// Bounded, opt-in relay between two sessions (docs/plan-v2.md Phase 2). Off unless config.relayEnabled.
// Human-mediated handoffs remain the default; this automates at most `maxRounds` hops between exactly
// two sessions, logs every hop as an `ensemble.relay` event, and stops at the limit, on a done marker,
// on any error, or when the user stops it. Nothing resumes after a server restart.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Relay, RelayStatus, Session } from "../shared/types.js";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import { nowIso } from "./db/index.js";
import type { SessionService } from "./sessions.js";
import { WorkspaceError } from "./workspaces.js";

export const RELAY_MAX_ROUNDS = 20;
export const RELAY_DEFAULT_MARKER = "RELAY_DONE";

interface RelayRow {
  id: string;
  workspace_id: string;
  a_session_id: string;
  b_session_id: string;
  awaiting_session_id: string | null;
  max_rounds: number;
  rounds_done: number;
  done_marker: string;
  status: RelayStatus;
  error: string | null;
  created_at: string;
  ended_at: string | null;
}

function rowToRelay(r: RelayRow): Relay {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    aSessionId: r.a_session_id,
    bSessionId: r.b_session_id,
    awaitingSessionId: r.awaiting_session_id,
    maxRounds: r.max_rounds,
    roundsDone: r.rounds_done,
    doneMarker: r.done_marker,
    status: r.status,
    error: r.error,
    createdAt: r.created_at,
    endedAt: r.ended_at,
  };
}

export interface StartRelayInput {
  aSessionId: string;
  bSessionId: string;
  kickoff: string;
  maxRounds?: number;
  doneMarker?: string;
}

export interface RelayServiceDeps {
  db: Db;
  config: Config;
  sessions: SessionService;
  appendEvent: (sessionId: string, type: string, payload: unknown) => void;
}

/** Emits "changed" (Relay). */
export class RelayService extends EventEmitter {
  private readonly db: Db;
  private readonly config: Config;
  private readonly sessions: SessionService;
  private readonly appendEvent: RelayServiceDeps["appendEvent"];
  private chain: Promise<void> = Promise.resolve();

  constructor(deps: RelayServiceDeps) {
    super();
    this.db = deps.db;
    this.config = deps.config;
    this.sessions = deps.sessions;
    this.appendEvent = deps.appendEvent;
    this.sessions.on("stop", (sessionId: string) => {
      this.chain = this.chain.then(() => this.onStop(sessionId)).catch(() => undefined);
    });
  }

  list(): Relay[] {
    return (this.db.prepare("SELECT * FROM relays ORDER BY created_at").all() as RelayRow[]).map(
      rowToRelay,
    );
  }

  get(id: string): Relay {
    const row = this.db.prepare("SELECT * FROM relays WHERE id = ?").get(id) as
      RelayRow | undefined;
    if (!row) throw new WorkspaceError("relay not found", 404);
    return rowToRelay(row);
  }

  private runningFor(sessionId: string): RelayRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM relays WHERE status = 'running' AND (a_session_id = ? OR b_session_id = ?) LIMIT 1",
      )
      .get(sessionId, sessionId) as RelayRow | undefined;
  }

  private update(id: string, fields: Partial<Record<keyof RelayRow, unknown>>): Relay {
    const keys = Object.keys(fields);
    if (keys.length > 0) {
      this.db
        .prepare(`UPDATE relays SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
        .run(...keys.map((k) => fields[k as keyof RelayRow]), id);
    }
    const relay = this.get(id);
    this.emit("changed", relay);
    return relay;
  }

  private end(id: string, status: RelayStatus, error: string | null = null): Relay {
    return this.update(id, { status, error, ended_at: nowIso(), awaiting_session_id: null });
  }

  private requireIdle(s: Session, role: string): void {
    if (s.processState !== "running")
      throw new WorkspaceError(`${role} session is not running`, 409);
    if (s.status !== "idle")
      throw new WorkspaceError(
        `${role} session must be idle (it is ${s.status}); a relay needs a clean turn boundary`,
        409,
      );
  }

  async start(input: StartRelayInput): Promise<Relay> {
    if (!this.config.relayEnabled)
      throw new WorkspaceError("relays are disabled; enable them in Settings first", 409);
    if (input.aSessionId === input.bSessionId)
      throw new WorkspaceError("a relay needs two different sessions");
    const maxRounds = input.maxRounds ?? 4;
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > RELAY_MAX_ROUNDS)
      throw new WorkspaceError(`maxRounds must be between 1 and ${RELAY_MAX_ROUNDS}`);
    const marker = (input.doneMarker ?? RELAY_DEFAULT_MARKER).trim();
    if (!marker || marker.length > 64 || /\s/.test(marker))
      throw new WorkspaceError("doneMarker must be a single word of at most 64 characters");
    const kickoff = input.kickoff.trim();
    if (!kickoff) throw new WorkspaceError("kickoff text is required");
    const a = this.sessions.get(input.aSessionId);
    const b = this.sessions.get(input.bSessionId);
    this.requireIdle(a, "first");
    this.requireIdle(b, "second");
    for (const s of [a, b]) {
      if (this.runningFor(s.id))
        throw new WorkspaceError(`session ${s.id} is already in a relay`, 409);
    }
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO relays (id, workspace_id, a_session_id, b_session_id, awaiting_session_id, max_rounds, rounds_done, done_marker, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'running', ?)`,
      )
      .run(id, a.workspaceId, a.id, b.id, a.id, maxRounds, marker, nowIso());
    const text = `${this.instructions(marker, 0, maxRounds)}\n${kickoff}`;
    try {
      await this.sessions.input(a.id, text);
    } catch (e) {
      this.end(id, "error", (e as Error).message);
      throw e;
    }
    this.appendEvent(a.id, "ensemble.relay", {
      relayId: id,
      hop: 0,
      from: "user",
      to: a.id,
      chars: kickoff.length,
    });
    return this.update(id, {});
  }

  stop(id: string): Relay {
    const r = this.get(id);
    if (r.status !== "running") return r;
    return this.end(id, "stopped");
  }

  private instructions(marker: string, hop: number, max: number): string {
    return `[Ensemble relay, hop ${hop} of ${max}. Another agent will receive your answer verbatim. Include the word ${marker} in your answer when the exchange is complete.]`;
  }

  /** Advances the relay that waits on `sessionId`, if any. Serialized through `chain`. */
  private async onStop(sessionId: string): Promise<void> {
    const row = this.runningFor(sessionId);
    if (!row || row.awaiting_session_id !== sessionId) return;
    const answer = this.sessions.lastAnswer(sessionId);
    if (!answer.text) {
      this.end(row.id, "error", `no answer was captured from session ${sessionId.slice(0, 8)}`);
      return;
    }
    if (answer.text.includes(row.done_marker)) {
      this.end(row.id, "done");
      return;
    }
    if (row.rounds_done >= row.max_rounds) {
      this.end(row.id, "limit");
      return;
    }
    const fromId = sessionId;
    const toId = fromId === row.a_session_id ? row.b_session_id : row.a_session_id;
    const from = this.sessions.get(fromId);
    let to: Session;
    try {
      to = this.sessions.get(toId);
      this.requireIdle(to, "target");
    } catch (e) {
      this.end(row.id, "error", (e as Error).message);
      return;
    }
    const hop = row.rounds_done + 1;
    const header = `From ${from.agent} in ${this.sessions.workspaceLabel(from.workspaceId)}:`;
    const text = `${this.instructions(row.done_marker, hop, row.max_rounds)}\n${header}\n${answer.text}`;
    try {
      await this.sessions.input(to.id, text);
    } catch (e) {
      this.end(row.id, "error", (e as Error).message);
      return;
    }
    const payload = { relayId: row.id, hop, from: from.id, to: to.id, chars: answer.text.length };
    this.appendEvent(to.id, "ensemble.relay", payload);
    this.appendEvent(from.id, "ensemble.relay", { ...payload, direction: "sent" });
    this.update(row.id, { rounds_done: hop, awaiting_session_id: to.id });
  }

  /** Startup: nothing resumes across restarts; running relays become `interrupted`. */
  interruptAll(): void {
    const rows = this.db.prepare("SELECT id FROM relays WHERE status = 'running'").all() as Array<{
      id: string;
    }>;
    for (const r of rows) this.end(r.id, "interrupted", "server restarted");
  }
}
