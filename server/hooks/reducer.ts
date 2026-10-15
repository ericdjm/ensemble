import type {
  AuthMode,
  EventEnvelope,
  Freshness,
  PendingInputs,
  SessionStatus,
} from "../../shared/types.js";

export interface TurnState {
  status: SessionStatus;
  turnActive: boolean;
  pending: PendingInputs;
  cliSessionId: string | null;
  transcriptPath: string | null;
  freshness: Freshness;
  authMode: AuthMode;
  authLabel: string | null;
  authCheckedAt: string | null;
  refusalReason: string | null;
  remoteControl: boolean | null;
}

export const EMPTY_PENDING: PendingInputs = {
  perm: {},
  prompt: false,
  elicitation: false,
  agentInput: false,
};

export function initialTurnState(): TurnState {
  return {
    status: "starting",
    turnActive: false,
    pending: { ...EMPTY_PENDING, perm: {} },
    cliSessionId: null,
    transcriptPath: null,
    freshness: "unknown",
    authMode: "unchecked",
    authLabel: null,
    authCheckedAt: null,
    refusalReason: null,
    remoteControl: null,
  };
}

export const ATTENTION_NOTIFICATIONS = new Set([
  "permission_prompt",
  "elicitation_dialog",
  "elicitation_url_dialog",
  "agent_needs_input",
]);
export const ELICITATION_DONE_NOTIFICATIONS = new Set([
  "elicitation_complete",
  "elicitation_response",
]);

export function hasPending(p: PendingInputs): boolean {
  return p.prompt || p.elicitation || p.agentInput || Object.values(p.perm).some((n) => n > 0);
}

function derive(s: TurnState, base: SessionStatus): SessionStatus {
  if (base === "exited" || base === "error") return base;
  if (hasPending(s.pending)) return "needs_input";
  return s.turnActive ? "working" : "idle";
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function decPerm(perm: Record<string, number>, tool: string | null): Record<string, number> {
  const current = tool ? perm[tool] : undefined;
  if (!tool || !current) return perm;
  const next = { ...perm, [tool]: current - 1 };
  if (current - 1 <= 0) delete next[tool];
  return next;
}

/** Pure status reducer (docs/architecture.md §7.6). Never throws on unexpected payloads. */
export function reduce(prev: TurnState, ev: EventEnvelope): TurnState {
  const s: TurnState = { ...prev, pending: { ...prev.pending, perm: { ...prev.pending.perm } } };
  const payload = (ev.payload && typeof ev.payload === "object" ? ev.payload : {}) as Record<
    string,
    unknown
  >;
  const tool = ev.tool ?? str(payload["tool_name"]);
  let base: SessionStatus =
    prev.status === "exited" || prev.status === "error" ? prev.status : "idle";

  switch (ev.type) {
    case "ensemble.preflight": {
      s.authMode = (str(payload["mode"]) as AuthMode | null) ?? "unknown";
      s.authLabel = str(payload["label"]);
      s.authCheckedAt = str(payload["checkedAt"]) ?? ev.sourceTs;
      return s;
    }
    case "ensemble.refused": {
      s.refusalReason = str(payload["reason"]) ?? str(payload["label"]) ?? "refused";
      s.status = "error";
      return s;
    }
    case "ensemble.launch": {
      s.remoteControl = payload["remoteControl"] === true;
      return s;
    }
    case "SessionStart":
      s.cliSessionId = str(payload["session_id"]) ?? s.cliSessionId;
      s.transcriptPath = str(payload["transcript_path"]) ?? s.transcriptPath;
      s.freshness = "current";
      s.turnActive = false;
      s.pending = { ...EMPTY_PENDING, perm: {} };
      base = "idle";
      break;
    case "UserPromptSubmit":
      s.turnActive = true;
      s.pending = { ...EMPTY_PENDING, perm: {} };
      break;
    case "PreToolUse":
      s.turnActive = true;
      s.pending.prompt = false;
      break;
    case "PermissionRequest":
      if (tool) s.pending.perm[tool] = (s.pending.perm[tool] ?? 0) + 1;
      else s.pending.prompt = true;
      s.turnActive = true;
      break;
    case "PostToolUse":
    case "PostToolUseFailure":
    case "PermissionDenied":
      s.pending.perm = decPerm(s.pending.perm, tool);
      s.pending.prompt = false;
      s.pending.agentInput = false;
      s.turnActive = true;
      break;
    case "Notification": {
      const kind = str(payload["notification_type"]) ?? str(payload["matcher"]);
      if (kind === "permission_prompt") s.pending.prompt = true;
      else if (kind === "elicitation_dialog" || kind === "elicitation_url_dialog")
        s.pending.elicitation = true;
      else if (kind === "agent_needs_input") s.pending.agentInput = true;
      else if (kind && ELICITATION_DONE_NOTIFICATIONS.has(kind)) s.pending.elicitation = false;
      break;
    }
    case "Elicitation":
      s.pending.elicitation = true;
      break;
    case "ElicitationResult":
      s.pending.elicitation = false;
      break;
    case "Stop":
    case "agent-turn-complete":
      s.turnActive = false;
      s.pending = { ...EMPTY_PENDING, perm: {}, agentInput: s.pending.agentInput };
      break;
    case "StopFailure":
      s.turnActive = false;
      s.pending = { ...EMPTY_PENDING, perm: {} };
      s.refusalReason = null;
      s.status = "error";
      return s;
    case "SessionEnd":
      s.turnActive = false;
      s.pending = { ...EMPTY_PENDING, perm: {} };
      s.status = "exited";
      return s;
    default:
      return s;
  }
  s.status = derive(s, base);
  return s;
}

/** True when a live transition should raise a browser notification. */
export function shouldNotify(before: TurnState, after: TurnState): boolean {
  if (after.status === before.status) return false;
  return after.status === "needs_input" || (after.status === "idle" && before.status === "working");
}
