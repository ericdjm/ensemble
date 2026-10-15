import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { PRODUCT_NAME } from "../shared/brand.js";
import { computeAllowedHosts, registerAuth } from "./auth.js";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import { webDistDir } from "./paths.js";
import { registerRoutes, snapshot, type Services } from "./routes.js";
import { Tmux } from "./tmux.js";
import { WorkspaceService } from "./workspaces.js";
import { ArchiveService } from "./archive.js";
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
}

export interface App {
  fastify: FastifyInstance;
  hub: StateHub;
  services: Services;
  allowedHosts: Set<string>;
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
  const services: Services = { db: opts.db, workspaces, archive };

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
  workspaces.on("changed", (item) => hub.broadcast({ t: "workspace.changed", item }));
  workspaces.on("setup-output", (workspaceId: string, chunk: string) =>
    hub.broadcast({ t: "script.output", workspaceId, kind: "setup", chunk }),
  );
  fastify.addHook("onClose", async () => hub.close());

  return { fastify, hub, services, allowedHosts };
}
