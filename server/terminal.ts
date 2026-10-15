import { chmodSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import * as pty from "node-pty";
import { WebSocket, WebSocketServer } from "ws";
import type { SessionService } from "./sessions.js";
import type { Tmux } from "./tmux.js";
import type { StateHub } from "./ws.js";
import { runSessionName, setupSessionName, type WorkspaceService } from "./workspaces.js";

/** node-pty's prebuilt spawn-helper can lose its execute bit when installed through pnpm; restore it. */
export function ensurePtyHelperExecutable(): void {
  try {
    const require = createRequire(import.meta.url);
    const pkgDir = path.dirname(require.resolve("node-pty/package.json"));
    const prebuilds = path.join(pkgDir, "prebuilds");
    for (const arch of readdirSync(prebuilds)) {
      const helper = path.join(prebuilds, arch, "spawn-helper");
      try {
        if ((statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
      } catch {
        /* no helper for this arch */
      }
    }
  } catch {
    /* node-pty not installed as expected; spawning will fail loudly later */
  }
}

export interface TerminalDeps {
  tmux: Tmux;
  sessions: SessionService;
  workspaces: WorkspaceService;
}

function resolveTarget(target: string | null, deps: TerminalDeps): string | null {
  if (!target) return null;
  const m = /^(session|setup|run):([A-Za-z0-9-]{1,64})$/.exec(target);
  if (!m) return null;
  const [, kind, id] = m as unknown as [string, string, string];
  try {
    if (kind === "session") return deps.sessions.get(id).tmuxName;
    deps.workspaces.get(id);
    return kind === "setup" ? setupSessionName(id) : runSessionName(id);
  } catch {
    return null;
  }
}

/** Bridges /ws/term sockets to `tmux attach` clients through node-pty (docs/architecture.md §5.4). */
export function registerTerminalBridge(hub: StateHub, deps: TerminalDeps): void {
  ensurePtyHelperExecutable();
  const wss = new WebSocketServer({ noServer: true });
  hub.upgradeHandlers.set(
    "/ws/term",
    async (req: IncomingMessage, socket: Duplex, head: Buffer, url: URL) => {
      const name = resolveTarget(url.searchParams.get("target"), deps);
      if (!name || !(await deps.tmux.hasSession(name))) {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const cols = Math.min(500, Math.max(20, Number(url.searchParams.get("cols")) || 120));
      const rows = Math.min(200, Math.max(5, Number(url.searchParams.get("rows")) || 32));
      wss.handleUpgrade(req, socket, head, (ws) => attach(ws, name, cols, rows, deps.tmux));
    },
  );
}

function attach(ws: WebSocket, name: string, cols: number, rows: number, tmux: Tmux): void {
  let term: pty.IPty;
  try {
    term = pty.spawn("tmux", tmux.attachArgs(name), {
      name: "xterm-256color",
      cols,
      rows,
      cwd: os.homedir(),
      env: {
        ...tmux.clientEnv(),
        TERM: "xterm-256color",
        LANG: process.env["LANG"] ?? "en_US.UTF-8",
      },
    });
  } catch (e) {
    ws.send(JSON.stringify({ t: "error", message: (e as Error).message }));
    ws.close();
    return;
  }
  ws.send(JSON.stringify({ t: "ready" }));
  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from(data, "utf8"));
  });
  term.onExit(() => {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  });
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      term.write(data.toString());
      return;
    }
    try {
      const msg = JSON.parse(data.toString()) as {
        t?: string;
        cols?: number;
        rows?: number;
        data?: string;
      };
      if (msg.t === "resize" && msg.cols && msg.rows)
        term.resize(Math.min(500, Math.max(20, msg.cols)), Math.min(200, Math.max(5, msg.rows)));
      else if (msg.t === "input" && typeof msg.data === "string") term.write(msg.data);
    } catch {
      /* ignore */
    }
  });
  ws.on("close", () => {
    try {
      term.kill();
    } catch {
      /* already gone */
    }
  });
}
