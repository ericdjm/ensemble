import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "../shared/types.js";
import { initialTurnState, reduce, shouldNotify, type TurnState } from "../server/hooks/reducer.js";

let seq = 0;
function ev(
  type: string,
  payload: Record<string, unknown> = {},
  tool: string | null = null,
): EventEnvelope {
  return {
    id: `e${++seq}`,
    sessionId: "s",
    generation: 1,
    seq,
    source: "test",
    type,
    tool,
    sourceTs: new Date().toISOString(),
    truncated: false,
    payload,
  };
}

function play(events: EventEnvelope[], start: TurnState = initialTurnState()): TurnState {
  return events.reduce((s, e) => reduce(s, e), start);
}

describe("status reducer", () => {
  it("captures identity on SessionStart and goes idle", () => {
    const s = play([ev("SessionStart", { session_id: "abc", transcript_path: "/t.jsonl" })]);
    expect(s).toMatchObject({
      status: "idle",
      cliSessionId: "abc",
      transcriptPath: "/t.jsonl",
      freshness: "current",
    });
  });

  it("works through a turn and stops", () => {
    const s = play([
      ev("SessionStart"),
      ev("UserPromptSubmit"),
      ev("PreToolUse", {}, "Bash"),
      ev("PostToolUse", {}, "Bash"),
    ]);
    expect(s.status).toBe("working");
    expect(play([ev("Stop")], s).status).toBe("idle");
  });

  it("counts permission requests per tool and resolves one per completion", () => {
    let s = play([
      ev("SessionStart"),
      ev("UserPromptSubmit"),
      ev("PermissionRequest", {}, "Bash"),
      ev("PermissionRequest", {}, "Bash"),
    ]);
    expect(s.status).toBe("needs_input");
    expect(s.pending.perm["Bash"]).toBe(2);
    s = play([ev("PostToolUse", {}, "Bash")], s);
    expect(s.status).toBe("needs_input");
    s = play([ev("PostToolUse", {}, "Bash")], s);
    expect(s.status).toBe("working");
    expect(s.pending.perm["Bash"]).toBeUndefined();
  });

  it("does not let an unrelated tool event clear another tool's open permission request", () => {
    const s = play([
      ev("SessionStart"),
      ev("UserPromptSubmit"),
      ev("PermissionRequest", {}, "Bash"),
      ev("PostToolUse", {}, "Read"),
    ]);
    expect(s.status).toBe("needs_input");
    expect(s.pending.perm["Bash"]).toBe(1);
  });

  it("maps only attention notifications to needs_input and resolves the prompt flag on tool progress", () => {
    const base = play([ev("SessionStart"), ev("UserPromptSubmit")]);
    for (const kind of [
      "idle_prompt",
      "auth_success",
      "agent_completed",
      "quota_auto_resume_fired",
      "something_new",
    ]) {
      expect(play([ev("Notification", { notification_type: kind })], base).status).toBe("working");
    }
    let s = play([ev("Notification", { notification_type: "permission_prompt" })], base);
    expect(s.status).toBe("needs_input");
    s = play([ev("PreToolUse", {}, "Bash")], s);
    expect(s.status).toBe("working");
    s = play([ev("Notification", { notification_type: "elicitation_dialog" })], s);
    expect(s.status).toBe("needs_input");
    s = play([ev("Notification", { notification_type: "elicitation_complete" })], s);
    expect(s.status).toBe("working");
    s = play([ev("Elicitation")], s);
    expect(s.status).toBe("needs_input");
    s = play([ev("ElicitationResult")], s);
    expect(s.status).toBe("working");
  });

  it("idle_prompt never turns an idle turn into needs_input", () => {
    const s = play([
      ev("SessionStart"),
      ev("UserPromptSubmit"),
      ev("Stop"),
      ev("Notification", { notification_type: "idle_prompt" }),
    ]);
    expect(s.status).toBe("idle");
  });

  it("keeps agent_needs_input across Stop until the next prompt", () => {
    let s = play([
      ev("SessionStart"),
      ev("UserPromptSubmit"),
      ev("Notification", { notification_type: "agent_needs_input" }),
      ev("Stop"),
    ]);
    expect(s.status).toBe("needs_input");
    s = play([ev("UserPromptSubmit")], s);
    expect(s.status).toBe("working");
  });

  it("records launcher reports and refusals", () => {
    let s = play([
      ev("ensemble.preflight", {
        mode: "api",
        label: "API key billing",
        checkedAt: "2026-10-14T00:00:00Z",
      }),
    ]);
    expect(s).toMatchObject({ authMode: "api", authLabel: "API key billing", status: "starting" });
    s = play([ev("ensemble.refused", { reason: "only subscription logins are allowed" })], s);
    expect(s).toMatchObject({
      status: "error",
      refusalReason: "only subscription logins are allowed",
    });
    const launched = play([
      ev("ensemble.preflight", { mode: "subscription" }),
      ev("ensemble.launch", { remoteControl: true }),
    ]);
    expect(launched.remoteControl).toBe(true);
  });

  it("marks SessionEnd as exited and StopFailure as error", () => {
    expect(play([ev("SessionStart"), ev("SessionEnd")]).status).toBe("exited");
    expect(
      play([ev("SessionStart"), ev("UserPromptSubmit"), ev("StopFailure", { error: "api" })])
        .status,
    ).toBe("error");
  });

  it("treats Codex agent-turn-complete like Stop", () => {
    expect(
      play([ev("SessionStart"), ev("UserPromptSubmit"), ev("agent-turn-complete")]).status,
    ).toBe("idle");
  });

  it("notifies only on live transitions into needs_input or turn completion", () => {
    const idle = play([ev("SessionStart")]);
    const working = play([ev("UserPromptSubmit")], idle);
    const needs = play([ev("PermissionRequest", {}, "Bash")], working);
    expect(shouldNotify(working, needs)).toBe(true);
    expect(shouldNotify(working, play([ev("Stop")], working))).toBe(true);
    expect(shouldNotify(idle, working)).toBe(false);
    expect(shouldNotify(needs, needs)).toBe(false);
  });
});
