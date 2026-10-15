#!/usr/bin/env node
// Codex `notify` fallback: receives one JSON argument (agent-turn-complete) and records it as a Stop-like event.
import {
  enqueueAndDeliver,
  loadSessionConfig,
  makeEnvelope,
  sessionDirFromEnv,
  silence,
} from "./hook-common.mjs";

silence();
setTimeout(() => process.exit(0), 4000).unref();

async function main() {
  const sessionDir = sessionDirFromEnv(process.argv.slice(2));
  if (!sessionDir) return;
  const cfg = loadSessionConfig(sessionDir);
  const raw = process.argv.find((a) => a.startsWith("{")) ?? "{}";
  let payload;
  try {
    payload = JSON.parse(raw.slice(0, cfg?.limits?.payloadCapBytes ?? 256 * 1024));
  } catch {
    payload = { raw: raw.slice(0, 4096) };
  }
  const type = typeof payload.type === "string" ? payload.type : "unknown";
  await enqueueAndDeliver(
    sessionDir,
    cfg,
    makeEnvelope(cfg, { source: "codex-notify", type, payload }),
  );
}

main()
  .catch(() => undefined)
  .finally(() => process.exit(0));
