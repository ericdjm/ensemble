import { execFile } from "node:child_process";
import type { Agent, DoctorReport, DoctorTool } from "../shared/types.js";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import type { HookListenerState } from "./hooks/listener.js";
import { loginShellWhich, type SessionRow } from "./sessions.js";
import type { Tmux } from "./tmux.js";

function run(cmd: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
      },
      (error, stdout) => {
        const code = error ? (((error as { code?: unknown }).code as number | null) ?? 1) : 0;
        resolve({ code: typeof code === "number" ? code : 1, stdout: String(stdout ?? "") });
      },
    );
  });
}

async function tool(
  name: string,
  override: string | undefined,
  versionArgs: string[],
): Promise<DoctorTool> {
  const found = override ?? (await loginShellWhich(name));
  if (!found)
    return {
      name,
      path: null,
      resolvedFrom: null,
      version: null,
      error: `${name} not found on the login-shell PATH`,
    };
  const v = await run(found, versionArgs);
  const firstLine = v.stdout.trim().split("\n")[0] ?? "";
  return {
    name,
    path: found,
    resolvedFrom: override ? "override" : "login-shell PATH",
    version: v.code === 0 ? firstLine.slice(0, 120) : null,
    error: v.code === 0 ? null : `${name} ${versionArgs.join(" ")} exited with ${v.code}`,
  };
}

/** Read-only environment report. Never runs auth-status commands or inspects credential files. */
export async function doctorReport(
  config: Config,
  db: Db,
  tmux: Tmux,
  listener: HookListenerState,
): Promise<DoctorReport> {
  const tools = await Promise.all([
    tool("git", undefined, ["--version"]),
    tool("tmux", undefined, ["-V"]),
    tool("claude", config.cliPaths.claude, ["--version"]),
    tool("codex", config.cliPaths.codex, ["--version"]),
    tool("gh", undefined, ["--version"]),
  ]);
  let gh: DoctorReport["gh"] = { loggedIn: null, summary: null };
  const ghTool = tools.find((t) => t.name === "gh");
  if (ghTool?.path) {
    const r = await run(ghTool.path, ["auth", "status"]);
    const line =
      r.stdout
        .split("\n")
        .find((l) => /Logged in to/i.test(l))
        ?.trim() ?? null;
    gh = {
      loggedIn: r.code === 0,
      summary: line
        ? line.replace(/\s+/g, " ").slice(0, 160)
        : r.code === 0
          ? "logged in"
          : "not logged in",
    };
  }
  const authModes = (["claude", "codex"] as Agent[]).map((agent) => {
    const row = db
      .prepare(
        "SELECT auth_mode, auth_label, auth_checked_at FROM sessions WHERE agent = ? AND auth_mode != 'unchecked' ORDER BY auth_checked_at DESC LIMIT 1",
      )
      .get(agent) as Pick<SessionRow, "auth_mode" | "auth_label" | "auth_checked_at"> | undefined;
    return {
      agent,
      mode: row?.auth_mode ?? "unchecked",
      label: row?.auth_label ?? null,
      checkedAt: row?.auth_checked_at ?? null,
    };
  });
  const notes = [
    "Version checks prove a binary runs, not that it is logged in or that hooks work.",
    "Authentication modes are the launcher's last report for each CLI; Ensemble never reads credential files or runs status commands outside a launch.",
    "Codex launches are refused by default until its login-status output contract is verified (see docs/cli-notes.md).",
  ];
  if (!tools.find((t) => t.name === "tmux")?.path)
    notes.unshift("tmux is required: brew install tmux");
  return {
    tools,
    gh,
    hookListener: { ok: listener.ok, port: listener.port, error: listener.error },
    tmuxSocket: tmux.socketName,
    authModes,
    notes,
  };
}
