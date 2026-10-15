#!/usr/bin/env node
// Passive hook collector for Claude Code and Codex (docs/architecture.md §7.6).
// Usage: hook-capture.mjs <claude|codex> [--session-dir=<dir>]  (dir defaults to $ENSEMBLE_SESSION_DIR)
// Reads the hook's stdin JSON, spools it, delivers it once, and ALWAYS exits 0 with no output.
import {
  enqueueAndDeliver,
  loadSessionConfig,
  makeEnvelope,
  readStdinCapped,
  sessionDirFromEnv,
  silence,
} from "./hook-common.mjs";

silence();
setTimeout(() => process.exit(0), 4000).unref();

async function main() {
  const adapter = process.argv[2] === "codex" ? "codex" : "claude";
  const sessionDir = sessionDirFromEnv(process.argv.slice(3));
  if (!sessionDir) return;
  const cfg = loadSessionConfig(sessionDir);
  const cap = cfg?.limits?.payloadCapBytes ?? 256 * 1024;
  const { text, truncated } = readStdinCapped(cap);
  let payload;
  let type = "unknown";
  let tool = null;
  try {
    payload = JSON.parse(text);
    type = String(payload.hook_event_name ?? payload.hookEventName ?? payload.type ?? "unknown");
    tool = typeof payload.tool_name === "string" ? payload.tool_name : null;
  } catch {
    // Truncated or malformed: keep the prefix and whatever identity can be scraped from it.
    payload = { raw: text };
    const m = /"hook_event_name"\s*:\s*"([^"]+)"/.exec(text);
    if (m) type = m[1];
    const t = /"tool_name"\s*:\s*"([^"]+)"/.exec(text);
    if (t) tool = t[1];
    const s = /"session_id"\s*:\s*"([^"]+)"/.exec(text);
    if (s) payload.session_id = s[1];
    const tp = /"transcript_path"\s*:\s*"([^"]+)"/.exec(text);
    if (tp) payload.transcript_path = tp[1];
  }
  const envelope = makeEnvelope(cfg, { source: `${adapter}-hook`, type, tool, truncated, payload });
  await enqueueAndDeliver(sessionDir, cfg, envelope);
}

main()
  .catch(() => undefined)
  .finally(() => process.exit(0));
