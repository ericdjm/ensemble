import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeHookServer, type FakeHookServer } from "./hook-server.js";
import { FAKE_AGENT, HELPERS, makeSessionDir, type FakeSessionDir } from "./helpers-session.js";

const LAUNCHER = path.join(HELPERS, "agent-launcher.mjs");

interface ManifestOverrides {
  optIn?: boolean;
  ack?: boolean;
  prompt?: string;
  options?: string[];
  remoteControlName?: string;
  agent?: "claude" | "codex";
}

describe("agent-launcher", () => {
  let server: FakeHookServer;
  let sess: FakeSessionDir;
  let work: string;
  beforeEach(async () => {
    server = await startFakeHookServer();
    sess = makeSessionDir(server.port);
    work = mkdtempSync(path.join(os.tmpdir(), "ensemble-launch-"));
  });
  afterEach(async () => {
    await server.close();
    rmSync(sess.dir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  function writeManifest(o: ManifestOverrides = {}): string {
    const file = path.join(work, "launch.json");
    writeFileSync(
      file,
      JSON.stringify({
        agent: o.agent ?? "claude",
        cliPath: FAKE_AGENT,
        cwd: work,
        options: o.options ?? [],
        prompt: o.prompt,
        remoteControlName: o.remoteControlName,
        env: {
          strip: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY"],
          set: { ENSEMBLE_SESSION_DIR: sess.dir },
        },
        auth: { require: "subscription", optIn: o.optIn ?? false, ack: o.ack ?? false },
        sessionDir: sess.dir,
        sessionId: sess.sessionId,
      }),
    );
    return file;
  }

  /** Spawns asynchronously so the fake listener in this process can answer. */
  async function run(manifest: string, env: Record<string, string> = {}, input = "exit\n") {
    const argvFile = path.join(work, "argv.json");
    const envFile = path.join(work, "env.json");
    const r = await new Promise<{ status: number | null; stdout: string }>((resolve) => {
      const p = spawn(process.execPath, [LAUNCHER, manifest], {
        env: {
          PATH: process.env["PATH"] ?? "",
          FAKE_ARGV_FILE: argvFile,
          FAKE_ENV_FILE: envFile,
          ...env,
        },
      });
      let stdout = "";
      p.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      p.stderr.on("data", () => undefined);
      p.on("close", (status) => resolve({ status, stdout }));
      p.stdin.on("error", () => undefined);
      p.stdin.on("error", () => undefined);
      p.stdin.end(input);
    });
    const read = (f: string) => {
      try {
        return JSON.parse(readFileSync(f, "utf8")) as unknown;
      } catch {
        return null;
      }
    };
    return {
      status: r.status,
      stdout: r.stdout,
      argv: read(argvFile) as string[] | null,
      env: read(envFile) as Record<string, boolean> | null,
    };
  }

  const types = () => server.received.map((r) => (r.body as { type: string }).type);

  it("strips API-key variables, reports preflight and launch, and propagates the exit code", async () => {
    const r = await run(writeManifest({ prompt: "hello world" }), {
      ANTHROPIC_API_KEY: "sk-test",
      OPENAI_API_KEY: "x",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ENVCHECK ANTHROPIC_API_KEY=absent");
    expect(r.stdout).toContain("ENVCHECK OPENAI_API_KEY=absent");
    expect(r.stdout).toContain("PROMPT: hello world");
    expect(r.env).toMatchObject({ ANTHROPIC_API_KEY: false, OPENAI_API_KEY: false });
    expect(types()).toEqual(["ensemble.preflight", "ensemble.launch"]);
    const preflight = server.received[0]?.body as {
      payload: { mode: string; conflicts: string[] };
    };
    expect(preflight.payload.mode).toBe("subscription");
    expect(preflight.payload.conflicts.sort()).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
    expect(JSON.stringify(server.received)).not.toContain("sk-test");
  });

  it("propagates a non-zero exit", async () => {
    expect((await run(writeManifest(), {}, "crash\n")).status).toBe(2);
  });

  it("refuses api_key logins by default with exit 78 and a visible reason", async () => {
    const r = await run(writeManifest(), { FAKE_AUTH_METHOD: "api_key" });
    expect(r.status).toBe(78);
    expect(r.stdout).toMatch(/refused to start claude: API key billing/);
    expect(r.argv).toBeNull();
    expect(types()).toEqual(["ensemble.preflight", "ensemble.refused"]);
  });

  it("allows api mode only with the opt-in", async () => {
    expect(
      (await run(writeManifest({ optIn: true }), { FAKE_AUTH_METHOD: "api_key_helper" })).status,
    ).toBe(0);
  });

  it("treats setup tokens as unsupported, requiring opt-in plus acknowledgement, and never adds Remote Control", async () => {
    expect(
      (
        await run(writeManifest({ optIn: true, remoteControlName: "r/w" }), {
          FAKE_AUTH_METHOD: "oauth_token",
        })
      ).status,
    ).toBe(78);
    const r = await run(writeManifest({ optIn: true, ack: true, remoteControlName: "r/w" }), {
      FAKE_AUTH_METHOD: "oauth_token",
    });
    expect(r.status).toBe(0);
    expect(r.argv).not.toContain("--remote-control");
    const pre = server.received.find(
      (x) => (x.body as { type: string }).type === "ensemble.preflight",
    )?.body as {
      payload: { label: string };
    };
    expect(pre.payload.label).toBe("unsupported token-based authentication");
  });

  it("adds --remote-control before the prompt for subscription logins", async () => {
    const r = await run(
      writeManifest({
        options: ["--settings", "/dev/null"],
        prompt: "go",
        remoteControlName: "repo/ws",
      }),
    );
    expect(r.argv).toEqual(["--settings", "/dev/null", "--remote-control", "repo/ws", "go"]);
  });

  it("refuses when the status output is not JSON, when not logged in, and when it hangs", async () => {
    expect(
      (await run(writeManifest({ optIn: true }), { FAKE_AUTH_METHOD: "garbage" })).status,
    ).toBe(78);
    expect((await run(writeManifest({ optIn: true }), { FAKE_AUTH_METHOD: "none" })).status).toBe(
      78,
    );
    const r = await run(writeManifest({ optIn: true }), { FAKE_AUTH_METHOD: "hang" });
    expect(r.status).toBe(78);
    expect(r.stdout).toMatch(/timed out/);
  }, 30_000);

  it("classifies Codex from its login-status line and fails closed otherwise", async () => {
    expect((await run(writeManifest({ agent: "codex" }))).status).toBe(0);
    const pre = server.received.find(
      (x) => (x.body as { type: string }).type === "ensemble.preflight",
    )?.body as {
      payload: { mode: string; label: string };
    };
    expect(pre.payload).toMatchObject({ mode: "subscription", label: "ChatGPT subscription" });
    expect(
      (await run(writeManifest({ agent: "codex" }), { FAKE_CODEX_STATUS: "apikey" })).status,
    ).toBe(78);
    expect(
      (await run(writeManifest({ agent: "codex", optIn: true }), { FAKE_CODEX_STATUS: "apikey" }))
        .status,
    ).toBe(0);
    expect(
      (await run(writeManifest({ agent: "codex", optIn: true }), { FAKE_CODEX_STATUS: "out" }))
        .status,
    ).toBe(78);
    expect(
      (await run(writeManifest({ agent: "codex", optIn: true }), { FAKE_CODEX_STATUS: "weird" }))
        .status,
    ).toBe(78);
    expect(
      (
        await run(writeManifest({ agent: "codex", optIn: true, ack: true }), {
          FAKE_CODEX_STATUS: "weird",
        })
      ).status,
    ).toBe(0);
  });

  it("still launches when the listener is down, leaving reports in the spool", async () => {
    await server.close();
    const r = await run(writeManifest());
    expect(r.status).toBe(0);
    const records = readdirSync(path.join(sess.dir, "spool")).filter((n) =>
      /^\d+-\d{10}\.json$/.test(n),
    );
    expect(records).toHaveLength(2);
  });
});
