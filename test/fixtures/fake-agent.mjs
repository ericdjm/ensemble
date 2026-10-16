#!/usr/bin/env node
// Fake interactive CLI used by tests instead of the real `claude`/`codex` binaries.
// - `auth status --json` prints {authMethod: $FAKE_AUTH_METHOD ?? "claude.ai"} (exit 1 when "none")
// - otherwise: records argv to $FAKE_ARGV_FILE, fires hooks from the --settings file the way Claude Code
//   would (command via /bin/sh with JSON on stdin), prints ENVCHECK lines, then reads stdin commands:
//   "exit" (SessionEnd + exit 0), "crash" (exit 2), "tool <name>" (PreToolUse/PostToolUse), anything else echoes.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import readline from "node:readline";

const argv = process.argv.slice(2);

if (argv[0] === "login" && argv[1] === "status") {
  // Codex form: one line on stderr, nothing on stdout.
  const mode = process.env.FAKE_CODEX_STATUS ?? "chatgpt";
  if (mode === "chatgpt") process.stderr.write("Logged in using ChatGPT\n");
  else if (mode === "apikey") process.stderr.write("Logged in using an API key\n");
  else if (mode === "out") process.stderr.write("Not logged in\n");
  else process.stderr.write("something unexpected\n");
  process.exit(mode === "out" ? 1 : 0);
} else if (argv[0] === "auth" && argv[1] === "status") {
  const authMethod = process.env.FAKE_AUTH_METHOD ?? "claude.ai";
  if (authMethod === "garbage") {
    process.stdout.write("not json at all\n");
    process.exit(1);
  }
  if (authMethod === "hang") {
    setTimeout(() => process.exit(0), 20_000);
  } else {
    process.stdout.write(JSON.stringify({ authMethod, configDirectory: "/fake/.claude" }) + "\n");
    process.exit(authMethod === "none" ? 1 : 0);
  }
} else {
  if (process.env.FAKE_ARGV_FILE)
    fs.writeFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify(argv));
  const valueFlags = new Set(["--settings", "--resume", "--remote-control"]);
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    if (valueFlags.has(argv[i])) {
      flags[argv[i]] = argv[i + 1];
      i++;
    } else if (!argv[i].startsWith("--")) {
      positionals.push(argv[i]);
    }
  }
  let hooks = {};
  if (flags["--settings"]) {
    try {
      hooks = JSON.parse(fs.readFileSync(flags["--settings"], "utf8")).hooks ?? {};
    } catch {
      hooks = {};
    }
  }
  const resumed = flags["--resume"] !== undefined;
  const sessionId = resumed
    ? flags["--resume"]
    : (process.env.FAKE_SESSION_ID ?? crypto.randomUUID());
  const prompt = positionals.pop();

  const fire = (hook_event_name, extra = {}) => {
    const payload = {
      hook_event_name,
      session_id: sessionId,
      transcript_path: `/fake/${sessionId}.jsonl`,
      cwd: process.cwd(),
      ...extra,
    };
    for (const group of hooks[hook_event_name] ?? []) {
      for (const h of group.hooks ?? []) {
        if (h.type !== "command") continue;
        const r = spawnSync("/bin/sh", ["-c", h.command], {
          input: JSON.stringify(payload),
          env: process.env,
          timeout: (h.timeout ?? 5) * 1000,
        });
        if (process.env.FAKE_HOOK_OUTPUT_FILE) {
          fs.appendFileSync(
            process.env.FAKE_HOOK_OUTPUT_FILE,
            JSON.stringify({
              event: hook_event_name,
              status: r.status,
              stdout: String(r.stdout ?? ""),
              stderr: String(r.stderr ?? ""),
            }) + "\n",
          );
        }
      }
    }
  };

  process.stdout.write(`fake-agent ready session=${sessionId}\n`);
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY"]) {
    process.stdout.write(`ENVCHECK ${k}=${k in process.env ? "present" : "absent"}\n`);
  }
  if (process.env.FAKE_ENV_FILE) {
    const keys = [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "OPENAI_API_KEY",
      "ENSEMBLE_SESSION_ID",
      "ENSEMBLE_INSIDE",
    ];
    fs.writeFileSync(
      process.env.FAKE_ENV_FILE,
      JSON.stringify(Object.fromEntries(keys.map((k) => [k, k in process.env]))),
    );
  }
  if (prompt) process.stdout.write(`PROMPT: ${prompt}\n`);
  fire("SessionStart", { source: resumed ? "resume" : "startup" });

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const cmd = line.trim();
    if (cmd === "exit") {
      fire("SessionEnd", { reason: "prompt_input_exit" });
      process.exit(0);
    } else if (cmd === "crash") {
      process.exit(2);
    } else if (cmd.startsWith("tool ")) {
      const name = cmd.slice(5);
      fire("PreToolUse", { tool_name: name, tool_input: {}, tool_use_id: crypto.randomUUID() });
      fire("PostToolUse", { tool_name: name, tool_input: {}, tool_response: {} });
      process.stdout.write(`ran ${name}\n`);
    } else if (cmd.startsWith("fire ")) {
      const m = /^fire (\S+)\s*(.*)$/.exec(cmd);
      if (m) fire(m[1], m[2] ? JSON.parse(m[2]) : {});
    } else {
      process.stdout.write(`> ${cmd}\n`);
    }
  });
  rl.on("close", () => process.exit(0));
}
