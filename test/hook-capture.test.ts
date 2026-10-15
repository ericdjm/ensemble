import { spawn } from "node:child_process";
import { chmodSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeHookServer, type FakeHookServer } from "./hook-server.js";
import { HELPERS, makeSessionDir, type FakeSessionDir } from "./helpers-session.js";

const CAPTURE = path.join(HELPERS, "hook-capture.mjs");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Spawns asynchronously: the fake listener lives in this process, so a blocking spawnSync would deadlock it. */
export function runProcess(
  args: string[],
  input: string | Buffer,
  env: Record<string, string>,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn(process.execPath, args, { env });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    p.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    p.on("close", (status) => resolve({ status, stdout, stderr, ms: Date.now() - started }));
    p.stdin.on("error", () => undefined);
    p.stdin.end(input);
  });
}

function runCapture(
  sess: FakeSessionDir,
  input: string | Buffer,
  adapter = "claude",
): Promise<RunResult> {
  return runProcess([CAPTURE, adapter], input, {
    PATH: process.env["PATH"] ?? "",
    ENSEMBLE_SESSION_DIR: sess.dir,
  });
}

function spoolRecords(sess: FakeSessionDir): string[] {
  return readdirSync(path.join(sess.dir, "spool")).filter((n) => /^\d+-\d{10}\.json$/.test(n));
}

const EVENT = JSON.stringify({
  hook_event_name: "PreToolUse",
  session_id: "abc",
  transcript_path: "/t.jsonl",
  tool_name: "Bash",
  tool_input: { command: "ls" },
});

describe("hook-capture helper", () => {
  let server: FakeHookServer;
  let sess: FakeSessionDir;
  beforeEach(async () => {
    server = await startFakeHookServer();
    sess = makeSessionDir(server.port);
  });
  afterEach(async () => {
    await server.close();
    rmSync(sess.dir, { recursive: true, force: true });
  });

  it("delivers an envelope with the session token and removes the spool record after commit", async () => {
    const r = await runCapture(sess, EVENT);
    expect(r).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(server.received).toHaveLength(1);
    expect(server.received[0]?.sessionId).toBe(sess.sessionId);
    expect(server.received[0]?.auth).toBe(`Bearer ${sess.token}`);
    expect(server.received[0]?.body).toMatchObject({
      type: "PreToolUse",
      tool: "Bash",
      generation: 1,
      seq: 1,
      source: "claude-hook",
    });
    expect(spoolRecords(sess)).toEqual([]);
  });

  it("keeps the spool record when the server errors, and stays silent", async () => {
    server.mode = "error";
    const r = await runCapture(sess, EVENT);
    expect(r).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(spoolRecords(sess)).toEqual(["1-0000000001.json"]);
  });

  it("keeps the record when the response is not a commit", async () => {
    server.mode = "json-no-commit";
    const r = await runCapture(sess, EVENT);
    expect(r).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(spoolRecords(sess)).toHaveLength(1);
  });

  it("gives up within the time budget when the server hangs", async () => {
    server.mode = "hang";
    const r = await runCapture(sess, EVENT);
    expect(r).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(r.ms).toBeLessThan(4500);
    expect(spoolRecords(sess)).toHaveLength(1);
  });

  it("spools when no server is listening", async () => {
    await server.close();
    const r = await runCapture(sess, EVENT);
    expect(r).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(spoolRecords(sess)).toHaveLength(1);
    const rec = JSON.parse(readFileSync(path.join(sess.dir, "spool", "1-0000000001.json"), "utf8"));
    expect(rec).toMatchObject({ type: "PreToolUse", seq: 1, generation: 1 });
  });

  it("handles malformed input silently and still records something", async () => {
    const r = await runCapture(
      sess,
      '{"hook_event_name": "Stop", "session_id": "zzz", this is broken',
    );
    expect(r).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(server.received[0]?.body).toMatchObject({
      type: "Stop",
      payload: { session_id: "zzz" },
    });
  });

  it("truncates oversized payloads but keeps identity", async () => {
    const big = JSON.stringify({
      hook_event_name: "PostToolUse",
      session_id: "s1",
      tool_name: "Read",
      tool_response: "x".repeat(600 * 1024),
    });
    const r = await runCapture(sess, big);
    expect(r).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(server.received[0]?.body).toMatchObject({
      type: "PostToolUse",
      tool: "Read",
      truncated: true,
    });
  });

  it("stays silent and exits 0 when the spool is unwritable", async () => {
    chmodSync(path.join(sess.dir, "spool"), 0o500);
    try {
      const r = await runCapture(sess, EVENT);
      expect(r).toMatchObject({ status: 0, stdout: "", stderr: "" });
      expect(server.received).toHaveLength(1); // direct delivery is still attempted
    } finally {
      chmodSync(path.join(sess.dir, "spool"), 0o700);
    }
  });

  it("does nothing harmful without a session dir", async () => {
    const r = await runProcess([CAPTURE, "claude"], EVENT, { PATH: process.env["PATH"] ?? "" });
    expect(r).toMatchObject({ status: 0, stdout: "", stderr: "" });
  });

  it("allocates distinct sequence numbers under concurrent writers", async () => {
    await server.close();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        runCapture(sess, JSON.stringify({ hook_event_name: "PreToolUse", tool_name: `T${i}` })),
      ),
    );
    const names = spoolRecords(sess).sort();
    expect(names).toHaveLength(8);
    expect(names[7]).toBe("1-0000000008.json");
  });

  it("writes a bounded gap marker instead of records when the spool is full", async () => {
    await server.close();
    rmSync(sess.dir, { recursive: true, force: true });
    sess = makeSessionDir(1, { totalCapBytes: 400 });
    for (let i = 0; i < 5; i++) await runCapture(sess, EVENT);
    const files = readdirSync(path.join(sess.dir, "spool"));
    expect(files).toContain("gap.json");
    const gap = JSON.parse(readFileSync(path.join(sess.dir, "spool", "gap.json"), "utf8"));
    expect(gap.reason).toBe("spool_full");
    expect(gap.count).toBeGreaterThanOrEqual(3);
    expect(spoolRecords(sess).length).toBeLessThanOrEqual(2);
  });
});
