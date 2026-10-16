// Capture of a session's "last answer" (docs/plan-v2.md Phase 2).
// Sources, in order of preference: the Stop/notify payload itself, else the tail of the CLI's own
// transcript file, read-only. The transcript format is the CLI's and may change; parsing fails soft.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export const LAST_ANSWER_CAP = 16 * 1024;
export const LAST_ANSWER_PREVIEW_CHARS = 240;
export const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;

export type AnswerSource = "stop-payload" | "codex-notify" | "transcript";

export interface CapturedAnswer {
  text: string;
  source: AnswerSource;
}

/** Caps an answer to LAST_ANSWER_CAP characters, marking the cut. */
export function capAnswer(text: string): string {
  const t = text.trim();
  if (t.length <= LAST_ANSWER_CAP) return t;
  return `${t.slice(0, LAST_ANSWER_CAP)}\n… [truncated by Ensemble at ${LAST_ANSWER_CAP} characters]`;
}

export function answerPreview(text: string | null): string | null {
  if (!text) return null;
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > LAST_ANSWER_PREVIEW_CHARS
    ? `${one.slice(0, LAST_ANSWER_PREVIEW_CHARS - 1)}…`
    : one;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Text of an assistant transcript entry: joined text blocks, or null when it has none (e.g. tool_use only). */
export function assistantText(entry: unknown): string | null {
  const e = rec(entry);
  if (e["type"] !== "assistant") return null;
  if (e["isSidechain"] === true) return null;
  const message = rec(e["message"]);
  if (message["role"] !== undefined && message["role"] !== "assistant") return null;
  const content = message["content"];
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    const b = rec(block);
    if (b["type"] === "text" && typeof b["text"] === "string") parts.push(b["text"]);
  }
  const text = parts.join("\n").trim();
  return text || null;
}

/** Reads up to `maxBytes` from the end of a file; the first (possibly partial) line is dropped when cut. */
export function readTail(file: string, maxBytes = TRANSCRIPT_TAIL_BYTES): string {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    let off = 0;
    while (off < len) {
      const n = readSync(fd, buf, off, len - off, start + off);
      if (n === 0) break;
      off += n;
    }
    let text = buf.subarray(0, off).toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    return text;
  } finally {
    closeSync(fd);
  }
}

/**
 * Last assistant message with text content in a Claude Code transcript (JSONL, one entry per line).
 * Returns null when the file is unreadable or has no such entry.
 */
export function lastAssistantTextFromTranscript(file: string): string | null {
  let tail: string;
  try {
    tail = readTail(file);
  } catch {
    return null;
  }
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const text = assistantText(entry);
    if (text) return text;
  }
  return null;
}

/** Captures the answer carried by (or reachable from) a turn-completion event; null when none. */
export function captureAnswer(type: string, payload: unknown): CapturedAnswer | null {
  const p = rec(payload);
  if (type === "agent-turn-complete") {
    const text = p["last-assistant-message"];
    return typeof text === "string" && text.trim()
      ? { text: capAnswer(text), source: "codex-notify" }
      : null;
  }
  if (type !== "Stop") return null;
  const direct = p["last_assistant_message"];
  if (typeof direct === "string" && direct.trim())
    return { text: capAnswer(direct), source: "stop-payload" };
  const transcript = p["transcript_path"];
  if (typeof transcript === "string" && transcript.startsWith("/")) {
    const text = lastAssistantTextFromTranscript(transcript);
    if (text) return { text: capAnswer(text), source: "transcript" };
  }
  return null;
}
