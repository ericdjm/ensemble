import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import type { EventEnvelope, Session } from "../shared/types.js";
import { PRODUCT_NAME } from "../shared/brand.js";
import { ArchiveService } from "./archive.js";
import { computeAllowedHosts, registerAuth } from "./auth.js";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import { HookIngest } from "./hooks/ingest.js";
import { HookListener } from "./hooks/listener.js";
import { drainSpools } from "./hooks/spool.js";
import { summarizeEvent } from "./hooks/summary.js";
import { webDistDir } from "./paths.js";
import { registerRoutes, snapshot, type Services } from "./routes.js";
import { SessionService } from "./sessions.js";
import { PrService } from "./pr.js";
import { RelayService } from "./relay.js";
import { registerTerminalBridge } from "./terminal.js";
import { Tmux } from "./tmux.js";
import { WorkspaceService } from "./workspaces.js";
import { WorkspaceWatcher } from "./watch.js";
import { StateHub } from "./ws.js";

export interface AppOptions {
  config: Config;
  db: Db;
  stateDir: string;
  host: string;
  port: number;
  /** Directory with the built web assets; serving is skipped when it does not exist. */
  webDist?: string;
  tmux?: Tmux;
  /** Test-only: extra variables placed in every agent's tmux environment. */
  extraAgentEnv?: Record<string, string>;
  /** Test-only: path of a fake gh binary and its environment. */
  ghBinary?: string;
  ghEnv?: Record<string, string>;
}

export interface App {
  fastify: FastifyInstance;
  hub: StateHub;
  services: Services;
  allowedHosts: Set<string>;
  /** Binds the hook listener, drains spools, and starts liveness polling. */
  start: () => Promise<void>;
}

export async function buildApp(opts: AppOptions): Promise<App> {
  const fastify = Fastify({ logger: false, trustProxy: false });
  const allowedHosts = computeAllowedHosts(opts.host, opts.port, opts.config.allowedHosts);

  const browserSessions = await registerAuth(fastify, {
    db: opts.db,
    getToken: () => opts.config.uiToken,
    allowedHosts,
  });

  const tmux = opts.tmux ?? new Tmux();
  const workspaces = new WorkspaceService({
    db: opts.db,
    config: opts.config,
    stateDir: opts.stateDir,
    tmux,
  });
  const archive = new ArchiveService({
    db: opts.db,
    config: opts.config,
    stateDir: opts.stateDir,
    tmux,
    workspaces,
  });
  const sessions = new SessionService({
    db: opts.db,
    config: opts.config,
    stateDir: opts.stateDir,
    tmux,
    workspaces,
    ...(opts.extraAgentEnv ? { extraAgentEnv: opts.extraAgentEnv } : {}),
  });
  archive.registerStopper((workspaceId) => sessions.stopForWorkspace(workspaceId));
  const pr = new PrService({
    db: opts.db,
    workspaces,
    ...(opts.ghBinary ? { ghBinary: opts.ghBinary } : {}),
    ...(opts.ghEnv ? { ghEnv: opts.ghEnv } : {}),
  });
  const ingest = new HookIngest(opts.db, sessions);
  const relays = new RelayService({
    db: opts.db,
    config: opts.config,
    sessions,
    appendEvent: (sessionId, type, payload) => {
      try {
        ingest.appendInternal(sessionId, type, payload);
      } catch {
        /* best-effort history */
      }
    },
  });

  const pendingBroadcasts: Array<() => void> = [];
  let hubRef: StateHub | null = null;
  const broadcastListenerState = (state: { ok: boolean; port: number; error: string | null }) => {
    const send = () =>
      hubRef?.broadcast({
        t: "hooks.listener",
        ok: state.ok,
        port: state.port,
        ...(state.error ? { error: state.error } : {}),
      });
    if (hubRef) send();
    else pendingBroadcasts.push(send);
  };
  const listener = new HookListener(
    opts.config.hookPort,
    ingest,
    opts.config.spool.payloadCapBytes + 64 * 1024,
    broadcastListenerState,
  );

  const services: Services = {
    db: opts.db,
    workspaces,
    archive,
    sessions,
    pr,
    relays,
    ingest,
    listener,
    tmux,
    config: opts.config,
    stateDir: opts.stateDir,
  };

  fastify.get("/api/health", async () => ({ ok: true, name: PRODUCT_NAME }));
  registerRoutes(fastify, services);

  const webDist = opts.webDist ?? webDistDir();
  if (existsSync(webDist)) {
    await fastify.register(fastifyStatic, { root: webDist, prefix: "/" });
    fastify.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.sendFile("index.html");
    });
  }

  const hub = new StateHub(fastify, {
    browserSessions,
    allowedHosts,
    getState: () => snapshot(services),
  });
  hubRef = hub;
  for (const send of pendingBroadcasts) send();

  workspaces.on("changed", (item) => hub.broadcast({ t: "workspace.changed", item }));
  workspaces.on("setup-output", (workspaceId: string, chunk: string) =>
    hub.broadcast({ t: "script.output", workspaceId, kind: "setup", chunk }),
  );
  sessions.on("changed", (item: Session) => hub.broadcast({ t: "session.changed", item }));
  sessions.on("status", (item: Session, notify: boolean) =>
    hub.broadcast({
      t: "session.status",
      sessionId: item.id,
      status: item.status,
      processState: item.processState,
      freshness: item.freshness,
      pendingInputs: item.pendingInputs,
      notify,
    }),
  );
  sessions.on("event", (envelope: EventEnvelope) =>
    hub.broadcast({
      t: "event.appended",
      sessionId: envelope.sessionId,
      event: {
        eventId: envelope.id,
        seq: envelope.seq,
        generation: envelope.generation,
        type: envelope.type,
        toolName: envelope.tool,
        sourceTs: envelope.sourceTs,
        ingestedAt: new Date().toISOString(),
        truncated: envelope.truncated,
        summary: summarizeEvent(envelope.type, envelope.tool, envelope.payload),
      },
    }),
  );
  const watcher = new WorkspaceWatcher((workspaceId) =>
    hub.broadcast({ t: "diff.changed", workspaceId }),
  );
  const syncWatchers = () => {
    for (const ws of workspaces.list()) {
      if (ws.status === "ready" || ws.status === "setup_failed") watcher.watch(ws.id, ws.path);
      else void watcher.unwatch(ws.id);
    }
  };
  workspaces.on("changed", syncWatchers);
  syncWatchers();
  sessions.on("stop", (sessionId: string) => {
    try {
      hub.broadcast({ t: "diff.changed", workspaceId: sessions.get(sessionId).workspaceId });
    } catch {
      /* session gone */
    }
  });
  pr.on("changed", (workspaceId: string, info) =>
    hub.broadcast({ t: "pr.changed", workspaceId, pr: info }),
  );
  relays.on("changed", (item) => hub.broadcast({ t: "relay.changed", item }));
  registerTerminalBridge(hub, { tmux, sessions, workspaces });

  let drainTimer: NodeJS.Timeout | null = null;
  const drain = () => {
    try {
      drainSpools(opts.stateDir, ingest, (sessionId) => {
        try {
          sessions.emitChanged(sessionId, false);
        } catch {
          /* row gone */
        }
      });
    } catch {
      /* drain errors are non-fatal */
    }
  };
  const start = async () => {
    relays.interruptAll();
    await listener.start();
    drain();
    drainTimer = setInterval(drain, 15_000);
    drainTimer.unref();
    sessions.ensureLiveness();
    pr.startPolling();
    await sessions.refreshLiveness().catch(() => undefined);
  };

  fastify.addHook("onClose", async () => {
    if (drainTimer) clearInterval(drainTimer);
    sessions.stopLiveness();
    pr.stopPolling();
    await watcher.closeAll();
    await listener.stop();
    hub.close();
  });

  return { fastify, hub, services, allowedHosts, start };
}
