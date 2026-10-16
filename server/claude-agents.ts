// Claude Code background sessions (docs/plan-v2.md Phase 3). `claude agents --json --all` is the
// documented way to read session state from outside Claude Code; `claude attach <id>` takes over a
// terminal, which Ensemble runs inside one of its own tmux sessions so the browser can show it.
// Hooks cannot be injected into an already running session, so status comes from this JSON only.
import { execFile } from "node:child_process";
import type {
  ClaudeAgent,
  ClaudeAgentsReport,
  PendingInputs,
  SessionStatus,
} from "../shared/types.js";
import { EMPTY_PENDING } from "./hooks/reducer.js";

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Validates one entry of the JSON array; unknown fields are dropped, missing ones become null. */
export function parseClaudeAgent(raw: unknown): ClaudeAgent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const kind =
    r["kind"] === "background" ? "background" : r["kind"] === "interactive" ? "interactive" : null;
  const cwd = str(r["cwd"]);
  if (!kind || !cwd) return null;
  return {
    id: str(r["id"]),
    cwd,
    kind,
    startedAt: typeof r["startedAt"] === "number" ? new Date(r["startedAt"]).toISOString() : null,
    sessionId: str(r["sessionId"]),
    name: str(r["name"]),
    state: str(r["state"]),
    status: str(r["status"]),
    waitingFor: str(r["waitingFor"]),
    pid: typeof r["pid"] === "number" ? r["pid"] : null,
  };
}

export function parseClaudeAgents(text: string): ClaudeAgent[] {
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) throw new Error("expected a JSON array");
  return parsed.map(parseClaudeAgent).filter((a): a is ClaudeAgent => a !== null);
}

export interface ListClaudeAgentsOptions {
  cliPath: string;
  env: Record<string, string>;
  timeoutMs?: number;
}

/** Runs `claude agents --json --all`. Never throws; failures are reported in the result. */
export function listClaudeAgents(opts: ListClaudeAgentsOptions): Promise<ClaudeAgentsReport> {
  const checkedAt = new Date().toISOString();
  return new Promise((resolve) => {
    execFile(
      opts.cliPath,
      ["agents", "--json", "--all"],
      { env: opts.env, timeout: opts.timeoutMs ?? 15_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve({
            ok: false,
            agents: [],
            error: error.killed
              ? "claude agents --json timed out"
              : `claude agents --json failed: ${error.message}`,
            checkedAt,
          });
          return;
        }
        try {
          resolve({ ok: true, agents: parseClaudeAgents(String(stdout)), error: null, checkedAt });
        } catch (e) {
          resolve({
            ok: false,
            agents: [],
            error: `unparseable output: ${(e as Error).message}`,
            checkedAt,
          });
        }
      },
    );
  });
}

/** Maps the JSON status of a background session to Ensemble's session status and pending inputs. */
export function statusFromAgent(agent: ClaudeAgent): {
  status: SessionStatus;
  pending: PendingInputs;
} {
  const pending: PendingInputs = { ...EMPTY_PENDING, perm: {} };
  // `status` (busy|waiting|idle) is the live process indicator and wins; `state` is the job state.
  if (agent.status === "waiting") {
    const w = (agent.waitingFor ?? "").toLowerCase();
    if (w.includes("input")) pending.agentInput = true;
    else pending.prompt = true;
    return { status: "needs_input", pending };
  }
  if (agent.status === "busy") return { status: "working", pending };
  if (agent.status === "idle") return { status: "idle", pending };
  if (agent.state === "working") return { status: "working", pending };
  if (agent.state === "blocked") {
    pending.prompt = true;
    return { status: "needs_input", pending };
  }
  return { status: "idle", pending };
}
