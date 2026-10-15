import cookie from "@fastify/cookie";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "./db/index.js";
import { nowIso } from "./db/index.js";

export const COOKIE_NAME = "ensemble_session";

export interface AuthOptions {
  db: Db;
  getToken: () => string;
  allowedHosts: ReadonlySet<string>;
}

/** Computes the Host header values accepted for a given bind address. */
export function computeAllowedHosts(host: string, port: number, extra: string[] = []): Set<string> {
  const hosts = new Set<string>([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (host !== "127.0.0.1" && host !== "localhost") {
    hosts.add(
      host.includes(":") && !host.startsWith("[") ? `[${host}]:${port}` : `${host}:${port}`,
    );
  }
  for (const h of extra) hosts.add(h);
  return hosts;
}

export function tokensMatch(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Origin header check for WebSocket upgrades: must be http(s)://<allowed host>. */
export function originAllowed(
  origin: string | undefined,
  allowedHosts: ReadonlySet<string>,
): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return allowedHosts.has(url.host);
}

export class BrowserSessions {
  private cache = new Set<string>();
  constructor(private db: Db) {
    for (const row of db.prepare("SELECT id FROM browser_sessions").all() as Array<{
      id: string;
    }>) {
      this.cache.add(row.id);
    }
  }
  create(): string {
    const id = randomBytes(32).toString("base64url");
    this.db
      .prepare("INSERT INTO browser_sessions (id, created_at) VALUES (?, ?)")
      .run(id, nowIso());
    this.cache.add(id);
    return id;
  }
  has(id: string | undefined): boolean {
    return id !== undefined && this.cache.has(id);
  }
  clear(): void {
    this.db.prepare("DELETE FROM browser_sessions").run();
    this.cache.clear();
  }
}

const LOGIN_REQUIRED_HTML =
  "<!doctype html><meta charset=utf-8><title>Ensemble</title>" +
  "<p style='font:14px system-ui;margin:2em'>Login required. Open the login URL printed by the Ensemble server.</p>";

export async function registerAuth(
  app: FastifyInstance,
  opts: AuthOptions,
): Promise<BrowserSessions> {
  await app.register(cookie);
  const sessions = new BrowserSessions(opts.db);

  // Host allowlist (DNS-rebinding protection) before anything else.
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const host = request.headers.host;
    if (!host || !opts.allowedHosts.has(host)) {
      return reply.code(421).send({ error: "misdirected_request" });
    }
  });

  app.get("/login", async (request, reply) => {
    const token = (request.query as Record<string, unknown>)["token"];
    if (typeof token !== "string" || !tokensMatch(token, opts.getToken())) {
      return reply.code(401).type("text/html").send(LOGIN_REQUIRED_HTML);
    }
    const id = sessions.create();
    reply.setCookie(COOKIE_NAME, id, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      secure: request.protocol === "https",
    });
    return reply.redirect("/");
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions.url === "/login") return;
    const id = request.cookies[COOKIE_NAME];
    if (sessions.has(id)) return;
    if (request.url.startsWith("/api/")) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return reply.code(401).type("text/html").send(LOGIN_REQUIRED_HTML);
  });

  return sessions;
}
