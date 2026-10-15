import type { FastifyInstance } from "fastify";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { BrowserSessions, COOKIE_NAME, originAllowed } from "./auth.js";

export type ServerMessage =
  | { t: "snapshot"; state: unknown }
  | { t: "repo.changed"; item: unknown }
  | { t: "workspace.changed"; item: unknown }
  | { t: "session.changed"; item: unknown }
  | {
      t: "session.status";
      sessionId: string;
      status: string;
      processState: string;
      freshness: string;
      pendingInputs: unknown;
      notify: boolean;
    }
  | { t: "event.appended"; sessionId: string; event: unknown }
  | { t: "event.gap"; sessionId: string; gap: unknown }
  | { t: "diff.changed"; workspaceId: string }
  | { t: "pr.changed"; workspaceId: string; pr: unknown }
  | { t: "script.output"; workspaceId: string; kind: "setup" | "run"; chunk: string }
  | { t: "hooks.listener"; ok: boolean; port: number; error?: string };

export interface StateHubOptions {
  browserSessions: BrowserSessions;
  allowedHosts: ReadonlySet<string>;
  getState: () => unknown;
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/** Fan-out of domain events to authenticated browser sockets on /ws. */
export class StateHub {
  private wss = new WebSocketServer({ noServer: true });
  /** Other upgrade handlers (e.g. terminals) register here by pathname. */
  readonly upgradeHandlers = new Map<
    string,
    (req: IncomingMessage, socket: Duplex, head: Buffer, url: URL) => void
  >();

  constructor(
    private app: FastifyInstance,
    private opts: StateHubOptions,
  ) {
    app.server.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head));
    this.wss.on("connection", (ws) => {
      ws.send(
        JSON.stringify({ t: "snapshot", state: this.opts.getState() } satisfies ServerMessage),
      );
      ws.on("message", (data) => {
        if (data.toString() === '{"t":"ping"}') ws.send('{"t":"pong"}');
      });
    });
  }

  /** Validates host, origin and cookie; returns false (after rejecting) when not allowed. */
  authorizeUpgrade(req: IncomingMessage, socket: Duplex): boolean {
    const host = req.headers.host;
    if (!host || !this.opts.allowedHosts.has(host)) {
      rejectUpgrade(socket, 421, "Misdirected Request");
      return false;
    }
    if (!originAllowed(req.headers.origin, this.opts.allowedHosts)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return false;
    }
    const cookies = this.app.parseCookie(req.headers.cookie ?? "");
    if (!this.opts.browserSessions.has(cookies[COOKIE_NAME])) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return false;
    }
    return true;
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!this.authorizeUpgrade(req, socket)) return;
    if (url.pathname === "/ws") {
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
      return;
    }
    const handler = this.upgradeHandlers.get(url.pathname);
    if (handler) {
      handler(req, socket, head, url);
      return;
    }
    rejectUpgrade(socket, 404, "Not Found");
  }

  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  }

  close(): void {
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
  }
}
