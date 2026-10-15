import { afterAll, describe, expect, it } from "vitest";
import { Tmux } from "../server/tmux.js";

const tmux = new Tmux({ socketName: `ensemble-tmux-test-${process.pid}` });

describe("tmux wrapper", () => {
  afterAll(async () => {
    await tmux.killServer();
  });

  it("reports a version", async () => {
    expect(await tmux.version()).toMatch(/^tmux \d/);
  });

  it("starts a detached session, keeps the dead pane, and reads its exit code", async () => {
    await tmux.newSession({
      name: "t-exit",
      cwd: "/",
      env: { ENS_X: "1" },
      command: ["/bin/sh", "-c", "exit 7"],
    });
    const code = await tmux.waitForExit("t-exit", { timeoutMs: 10_000 });
    expect(code).toBe(7);
    expect(await tmux.hasSession("t-exit")).toBe(true);
    await tmux.killSession("t-exit");
    expect(await tmux.hasSession("t-exit")).toBe(false);
  });

  it("strips API-key variables from the client environment", () => {
    process.env["ANTHROPIC_API_KEY"] = "x";
    try {
      expect(tmux.clientEnv()["ANTHROPIC_API_KEY"]).toBeUndefined();
      expect(tmux.clientEnv()["PATH"]).toBeDefined();
    } finally {
      delete process.env["ANTHROPIC_API_KEY"];
    }
  });

  it("delivers quick replies with send-keys -l", async () => {
    await tmux.newSession({
      name: "t-read",
      cwd: "/",
      env: {},
      command: ["/bin/sh", "-c", "read -r line; [ \"$line\" = 'hello world' ] && exit 0 || exit 3"],
    });
    await new Promise((r) => setTimeout(r, 300));
    await tmux.sendLine("t-read", "hello world");
    expect(await tmux.waitForExit("t-read", { timeoutMs: 10_000 })).toBe(0);
    await tmux.killSession("t-read");
  });

  it("rejects invalid environment names", async () => {
    await expect(
      tmux.newSession({ name: "t-bad", cwd: "/", env: { "BAD NAME": "1" }, command: ["/bin/sh"] }),
    ).rejects.toThrow(/invalid environment/);
  });
});
