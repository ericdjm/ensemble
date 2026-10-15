import http from "node:http";
import { isEnvelope, type HookIngest } from "./ingest.js";

export interface HookListenerState {
  ok: boolean;
  port: number;
  error: string | null;
}

/** Loopback-only listener for hook and launcher envelopes (docs/architecture.md §5.2). */
export class HookListener {
  private server: http.Server | null = null;
  readonly state: HookListenerState;

  constructor(
    private readonly port: number,
    private readonly ingest: HookIngest,
    private readonly maxBodyBytes: number,
    private readonly onStateChange: (state: HookListenerState) => void = () => undefined,
  ) {
    this.state = { ok: false, port, error: "not started" };
  }

  private setState(ok: boolean, error: string | null): void {
    this.state.ok = ok;
    this.state.error = error;
    this.onStateChange({ ...this.state });
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.keepAliveTimeout = 5000;
      server.once("error", (e: NodeJS.ErrnoException) => {
        this.setState(false, `cannot bind 127.0.0.1:${this.port}: ${e.code ?? e.message}`);
        resolve();
      });
      server.listen({ host: "127.0.0.1", port: this.port, exclusive: true }, () => {
        this.server = server;
        this.setState(true, null);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    await new Promise<void>((r) => {
      s.closeAllConnections();
      s.close(() => r());
    });
    this.setState(false, "stopped");
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify(body));
    };
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`)
      return json(421, { error: "misdirected" });
    const m = /^\/api\/hooks\/([A-Za-z0-9-]{1,64})$/.exec(req.url ?? "");
    if (!m || req.method !== "POST") return json(404, { error: "not_found" });
    const sessionId = m[1] as string;
    const auth = req.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    if (!this.ingest.verifyToken(sessionId, token)) return json(401, { error: "unauthorized" });

    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > this.maxBodyBytes) {
        tooLarge = true;
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("error", () => undefined);
    req.on("end", () => {
      if (tooLarge) return json(413, { error: "too_large" });
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return json(400, { error: "bad_json" });
      }
      if (!isEnvelope(body) || body.sessionId !== sessionId)
        return json(400, { error: "bad_envelope" });
      try {
        const result = this.ingest.ingest(body, { replay: false });
        return json(result.status, {
          ok: result.committed,
          committed: result.committed,
          reason: result.reason,
        });
      } catch (e) {
        return json(500, { ok: false, committed: false, error: (e as Error).message });
      }
    });
  }
}
