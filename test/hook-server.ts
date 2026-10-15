import http from "node:http";

export interface ReceivedHook {
  sessionId: string;
  auth: string | undefined;
  body: unknown;
}

export interface FakeHookServer {
  port: number;
  received: ReceivedHook[];
  mode: "commit" | "error" | "hang" | "json-no-commit";
  close: () => Promise<void>;
}

/** Minimal stand-in for the loopback hook listener. */
export function startFakeHookServer(): Promise<FakeHookServer> {
  const state: FakeHookServer = {
    port: 0,
    received: [],
    mode: "commit",
    close: async () => undefined,
  };
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c: Buffer) => (data += c.toString()));
    req.on("end", () => {
      const m = /^\/api\/hooks\/([^/]+)$/.exec(req.url ?? "");
      let body: unknown;
      try {
        body = JSON.parse(data);
      } catch {
        body = data;
      }
      state.received.push({ sessionId: m?.[1] ?? "", auth: req.headers.authorization, body });
      if (state.mode === "hang") return; // never respond
      if (state.mode === "error") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "boom" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(state.mode === "commit" ? { ok: true, committed: true } : { ok: true }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      state.port = typeof addr === "object" && addr ? addr.port : 0;
      state.close = () =>
        new Promise((r) => {
          server.closeAllConnections();
          server.close(() => r());
        });
      resolve(state);
    });
  });
}
