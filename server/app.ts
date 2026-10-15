import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { PRODUCT_NAME } from "../shared/brand.js";
import { computeAllowedHosts, registerAuth } from "./auth.js";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import { webDistDir } from "./paths.js";
import { StateHub } from "./ws.js";

export interface AppOptions {
  config: Config;
  db: Db;
  host: string;
  port: number;
  /** Directory with the built web assets; serving is skipped when it does not exist. */
  webDist?: string;
}

export interface App {
  fastify: FastifyInstance;
  hub: StateHub;
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

  fastify.get("/api/health", async () => ({ ok: true, name: PRODUCT_NAME }));
  fastify.get("/api/state", async () => getState());

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

  const getState = () => ({ repos: [], workspaces: [], sessions: [] });
  const hub = new StateHub(fastify, { browserSessions, allowedHosts, getState });
  fastify.addHook("onClose", async () => hub.close());

  return { fastify, hub, allowedHosts };
}
