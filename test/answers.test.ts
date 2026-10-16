import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LAST_ANSWER_CAP,
  answerPreview,
  capAnswer,
  captureAnswer,
  lastAssistantTextFromTranscript,
  readTail,
} from "../server/answers.js";

const line = (v: unknown) => JSON.stringify(v) + "\n";
const assistant = (blocks: unknown, extra: Record<string, unknown> = {}) =>
  line({ type: "assistant", message: { role: "assistant", content: blocks }, ...extra });

describe("last-answer capture", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "ensemble-answers-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("prefers the Stop payload's last_assistant_message", () => {
    const file = path.join(dir, "t.jsonl");
    writeFileSync(file, assistant([{ type: "text", text: "from transcript" }]));
    expect(
      captureAnswer("Stop", { last_assistant_message: "  from payload ", transcript_path: file }),
    ).toEqual({ text: "from payload", source: "stop-payload" });
  });

  it("falls back to the transcript tail when the payload has no message", () => {
    const file = path.join(dir, "t.jsonl");
    writeFileSync(
      file,
      line({ type: "user", message: { role: "user", content: "hi" } }) +
        assistant([{ type: "text", text: "first" }]) +
        assistant([{ type: "tool_use", id: "x", name: "Bash", input: {} }]) +
        line({ type: "user", message: { role: "user", content: [{ type: "tool_result" }] } }) +
        assistant([
          { type: "text", text: "final " },
          { type: "text", text: "answer" },
        ]) +
        assistant([{ type: "text", text: "side" }], { isSidechain: true }) +
        line({ type: "summary", summary: "s" }),
    );
    expect(captureAnswer("Stop", { transcript_path: file })).toEqual({
      text: "final \nanswer",
      source: "transcript",
    });
    expect(captureAnswer("Stop", { transcript_path: "/nope/missing.jsonl" })).toBeNull();
    expect(captureAnswer("Stop", { transcript_path: "relative.jsonl" })).toBeNull();
  });

  it("handles string content, malformed lines, and a cut first line", () => {
    const file = path.join(dir, "t.jsonl");
    const big = "x".repeat(3 * 1024 * 1024);
    writeFileSync(
      file,
      assistant([{ type: "text", text: big }]) +
        "not json\n" +
        line({ type: "assistant", message: { role: "assistant", content: "plain string" } }),
    );
    expect(lastAssistantTextFromTranscript(file)).toBe("plain string");
    // The tail cut drops the partial first line instead of mis-parsing it.
    const last = line({
      type: "assistant",
      message: { role: "assistant", content: "plain string" },
    });
    expect(readTail(file, last.length + 3)).toBe(last);
    expect(readTail(file, 8)).toBe("");
  });

  it("captures Codex notify and ignores other events", () => {
    expect(captureAnswer("agent-turn-complete", { "last-assistant-message": "ok" })).toEqual({
      text: "ok",
      source: "codex-notify",
    });
    expect(captureAnswer("agent-turn-complete", { "last-assistant-message": "   " })).toBeNull();
    expect(captureAnswer("PostToolUse", { last_assistant_message: "x" })).toBeNull();
    expect(captureAnswer("Stop", "garbage")).toBeNull();
  });

  it("caps and previews", () => {
    const long = "a".repeat(LAST_ANSWER_CAP + 10);
    const capped = capAnswer(long);
    expect(capped.length).toBeGreaterThan(LAST_ANSWER_CAP);
    expect(capped).toContain("truncated by Ensemble");
    expect(capped.slice(0, LAST_ANSWER_CAP)).toBe("a".repeat(LAST_ANSWER_CAP));
    expect(answerPreview(null)).toBeNull();
    expect(answerPreview("  two\n\nlines  ")).toBe("two lines");
    expect(answerPreview("b".repeat(500))?.length).toBe(240);
  });
});
