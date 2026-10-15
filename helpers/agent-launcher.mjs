#!/usr/bin/env node
// Final launch boundary inside the tmux pane (docs/architecture.md §7.2–7.3).
// Usage: agent-launcher.mjs <launch.json>
// 1. builds the agent environment from its own env with API-key variables stripped,
// 2. runs the authentication preflight with that exact env and cwd,
// 3. applies the launch policy (refuse with exit 78, or exec the official CLI),
// reporting each step to Ensemble through the session spool / loopback listener.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import { enqueueAndDeliver, loadSessionConfig, makeEnvelope } from "./hook-common.mjs";

export const EXIT_REFUSED = 78;

export function filteredEnv(base, strip) {
  const env = {};
  const conflicts = [];
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (strip.includes(k)) {
      conflicts.push(k);
      continue;
    }
    env[k] = v;
  }
  return { env, conflicts };
}

const CLAUDE_MODES = {
  "claude.ai": ["subscription", "Claude subscription"],
  api_key: ["api", "API key billing"],
  api_key_helper: ["api", "API key helper billing"],
  oauth_token: ["other", "unsupported token-based authentication"],
  third_party: ["other", "third-party provider"],
  none: ["unknown", "not logged in: run `claude` and use /login"],
};

export function classifyClaude(authMethod) {
  const m = CLAUDE_MODES[authMethod];
  return m
    ? { mode: m[0], label: m[1], authMethod }
    : { mode: "unknown", label: `unrecognised authMethod ${String(authMethod)}`, authMethod: null };
}

function runStatus(cliPath, args, env, cwd) {
  return new Promise((resolve) => {
    execFile(
      cliPath,
      args,
      { env, cwd, timeout: 10_000, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          error,
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
        });
      },
    );
  });
}

/** Codex 0.160.1 prints "Logged in using ChatGPT" on stderr (verified once, docs/cli-notes.md); other forms fail closed. */
export function classifyCodex(text) {
  if (/logged in using chatgpt/i.test(text)) {
    return { mode: "subscription", label: "ChatGPT subscription", authMethod: "chatgpt" };
  }
  if (/api key/i.test(text))
    return { mode: "api", label: "API key billing", authMethod: "api_key" };
  if (/not logged in/i.test(text)) {
    return { mode: "unknown", label: "not logged in: run `codex login`", authMethod: "none" };
  }
  return { mode: "unknown", label: "unrecognised Codex login status output", authMethod: null };
}

/** Returns { mode, label, authMethod } using only the documented non-secret field. Raw output never leaves this function. */
export async function preflight(manifest, env) {
  if (manifest.agent === "claude") {
    const { error, stdout } = await runStatus(
      manifest.cliPath,
      ["auth", "status", "--json"],
      env,
      manifest.cwd,
    );
    try {
      const parsed = JSON.parse(stdout);
      if (parsed && typeof parsed === "object" && typeof parsed.authMethod === "string")
        return classifyClaude(parsed.authMethod);
    } catch {
      /* fall through */
    }
    if (error && error.killed)
      return { mode: "unknown", label: "authentication check timed out", authMethod: null };
    return {
      mode: "unknown",
      label: "authentication mode could not be determined",
      authMethod: null,
    };
  }
  const { error, stdout, stderr } = await runStatus(
    manifest.cliPath,
    ["login", "status"],
    env,
    manifest.cwd,
  );
  if (error && error.killed)
    return { mode: "unknown", label: "authentication check timed out", authMethod: null };
  return classifyCodex(`${stdout}\n${stderr}`.slice(0, 4096));
}

export function decide(policy, mode) {
  if (mode === "subscription") return { allowed: true };
  if (!policy.optIn) {
    return {
      allowed: false,
      reason:
        "only subscription logins are allowed; enable the API billing opt-in in settings to override",
    };
  }
  if (mode === "api") return { allowed: true };
  if (policy.ack) return { allowed: true };
  return {
    allowed: false,
    reason: "authentication mode is unverified; relaunch with an explicit acknowledgement",
  };
}

async function report(manifest, cfg, type, payload) {
  try {
    await enqueueAndDeliver(
      manifest.sessionDir,
      cfg,
      makeEnvelope(cfg, { source: "launcher", type, payload }),
    );
  } catch {
    /* never block the launch on reporting */
  }
}

export async function main(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const cfg = loadSessionConfig(manifest.sessionDir);
  const { env, conflicts } = filteredEnv(process.env, manifest.env.strip ?? []);
  Object.assign(env, manifest.env.set ?? {});

  const result = await preflight(manifest, env);
  await report(manifest, cfg, "ensemble.preflight", {
    ...result,
    conflicts,
    checkedAt: new Date().toISOString(),
  });

  const decision = decide(manifest.auth, result.mode);
  if (!decision.allowed) {
    process.stdout.write(
      `Ensemble refused to start ${manifest.agent}: ${result.label}. ${decision.reason}.\n`,
    );
    await report(manifest, cfg, "ensemble.refused", {
      mode: result.mode,
      label: result.label,
      reason: decision.reason,
    });
    process.exit(EXIT_REFUSED);
  }

  const args = [...(manifest.options ?? [])];
  if (manifest.remoteControlName && result.mode === "subscription")
    args.push("--remote-control", manifest.remoteControlName);
  if (typeof manifest.prompt === "string" && manifest.prompt.length > 0) args.push(manifest.prompt);

  const child = spawn(manifest.cliPath, args, { stdio: "inherit", env, cwd: manifest.cwd });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => child.kill(sig));
  }
  await report(manifest, cfg, "ensemble.launch", {
    mode: result.mode,
    label: result.label,
    remoteControl: args.includes("--remote-control"),
    pid: child.pid ?? null,
  });
  child.on("error", (e) => {
    process.stdout.write(`Ensemble could not start ${manifest.cliPath}: ${e.message}\n`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 128 + (os_signal(signal) || 0) : 1));
  });
}

function os_signal(name) {
  return { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 }[name] ?? 0;
}

if (process.argv[1] && process.argv[1].endsWith("agent-launcher.mjs")) {
  main(process.argv[2]).catch((e) => {
    process.stdout.write(`Ensemble launcher error: ${e && e.message ? e.message : String(e)}\n`);
    process.exit(70);
  });
}
