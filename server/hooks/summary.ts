/** One-line, secret-light summaries for the event timeline. Payloads stay in the DB and are fetched on demand. */
function trim(s: unknown, n = 100): string {
  if (typeof s !== "string") return "";
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function summarizeEvent(type: string, toolName: string | null, payload: unknown): string {
  const p = rec(payload);
  const input = rec(p["tool_input"]);
  switch (type) {
    case "UserPromptSubmit":
      return trim(p["prompt"]);
    case "PreToolUse":
    case "PermissionRequest":
    case "PermissionDenied":
    case "PostToolUse":
    case "PostToolUseFailure": {
      const detail =
        trim(input["command"]) ||
        trim(input["file_path"]) ||
        trim(input["pattern"]) ||
        trim(input["url"]) ||
        trim(input["description"]);
      const err = type === "PostToolUseFailure" ? trim(p["error"], 60) : "";
      return [toolName ?? "", detail, err].filter(Boolean).join(" · ");
    }
    case "Notification":
      return trim(p["notification_type"]) || trim(p["message"]);
    case "Stop":
    case "agent-turn-complete":
      return "turn complete";
    case "StopFailure":
      return trim(p["error"]) || "turn failed";
    case "SessionStart":
      return `source=${trim(p["source"])}`;
    case "SessionEnd":
      return trim(p["reason"]);
    case "ensemble.preflight":
      return `${trim(p["mode"])} — ${trim(p["label"])}`;
    case "ensemble.refused":
      return trim(p["reason"]);
    case "ensemble.launch":
      return p["remoteControl"] === true ? "launched with Remote Control" : "launched";
    case "SubagentStart":
    case "SubagentStop":
      return trim(p["agent_type"]) || trim(p["agent_id"]);
    default:
      return "";
  }
}
