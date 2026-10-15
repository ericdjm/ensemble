import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { PRODUCT_NAME } from "../shared/brand.js";
import { webDistDir } from "./paths.js";

export interface AppOptions {
  /** Directory with the built web assets; serving is skipped when it does not exist. */
  webDist?: string;
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.get("/api/health", async () => ({ ok: true, name: PRODUCT_NAME }));

  const webDist = opts.webDist ?? webDistDir();
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: "/" });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
