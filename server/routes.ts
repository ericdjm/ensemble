import type { FastifyInstance } from "fastify";
import type { Db } from "./db/index.js";
import {
  approveScripts,
  effectiveRepoConfig,
  getRepo,
  listRepos,
  registerRepo,
  removeRepo,
  setOverrides,
} from "./repos.js";
import { REPO_CONFIG_FILENAME, type ScriptKind } from "./repo-config.js";
import { WorkspaceError, type WorkspaceService } from "./workspaces.js";
import { writeFileSync } from "node:fs";
import path from "node:path";

export interface Services {
  db: Db;
  workspaces: WorkspaceService;
}

export function snapshot(s: Services) {
  return { repos: listRepos(s.db), workspaces: s.workspaces.list(), sessions: [] as unknown[] };
}

const idParam = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1 } },
} as const;

export function registerRoutes(app: FastifyInstance, s: Services): void {
  app.setErrorHandler((rawError: unknown, _request, reply) => {
    const error = rawError as Error & { statusCode?: number };
    if (error instanceof WorkspaceError)
      return reply.code(error.statusCode).send({ error: error.message });
    const status = error.statusCode;
    if (status && status < 500) return reply.code(status).send({ error: error.message });
    return reply.code(500).send({ error: error.message });
  });

  app.get("/api/state", async () => snapshot(s));

  app.post<{ Body: { path: string } }>(
    "/api/repos",
    {
      schema: {
        body: {
          type: "object",
          required: ["path"],
          properties: { path: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const repo = await registerRepo(s.db, request.body.path);
      return reply.code(201).send(repo);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/repos/:id",
    { schema: { params: idParam } },
    async (request, reply) => {
      if (!getRepo(s.db, request.params.id))
        return reply.code(404).send({ error: "repo not found" });
      removeRepo(s.db, request.params.id);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/repos/:id/config",
    { schema: { params: idParam } },
    async (request, reply) => {
      const repo = getRepo(s.db, request.params.id);
      if (!repo) return reply.code(404).send({ error: "repo not found" });
      return effectiveRepoConfig(s.db, repo);
    },
  );

  app.put<{
    Params: { id: string };
    Body: { overrides?: Record<string, unknown>; createFile?: Record<string, unknown> };
  }>(
    "/api/repos/:id/config",
    { schema: { params: idParam, body: { type: "object" } } },
    async (request, reply) => {
      const repo = getRepo(s.db, request.params.id);
      if (!repo) return reply.code(404).send({ error: "repo not found" });
      if (request.body.createFile) {
        const eff = effectiveRepoConfig(s.db, repo);
        if (eff.file.exists)
          return reply.code(409).send({ error: `${REPO_CONFIG_FILENAME} already exists` });
        const { parseRepoConfig } = await import("./repo-config.js");
        parseRepoConfig(request.body.createFile);
        writeFileSync(
          path.join(repo.path, REPO_CONFIG_FILENAME),
          JSON.stringify(request.body.createFile, null, 2) + "\n",
          {
            flag: "wx",
          },
        );
      }
      if (request.body.overrides) setOverrides(s.db, repo.id, request.body.overrides);
      return effectiveRepoConfig(s.db, repo);
    },
  );

  app.post<{
    Params: { id: string };
    Body: { approvals: Array<{ kind: ScriptKind; hash: string }> };
  }>(
    "/api/repos/:id/approve-scripts",
    {
      schema: {
        params: idParam,
        body: {
          type: "object",
          required: ["approvals"],
          properties: {
            approvals: {
              type: "array",
              items: {
                type: "object",
                required: ["kind", "hash"],
                properties: {
                  kind: { enum: ["setup", "run", "archive"] },
                  hash: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const repo = getRepo(s.db, request.params.id);
      if (!repo) return reply.code(404).send({ error: "repo not found" });
      approveScripts(s.db, repo, request.body.approvals);
      return effectiveRepoConfig(s.db, repo);
    },
  );

  app.post<{
    Body: {
      repoId: string;
      baseBranch?: string;
      name?: string;
      agent: "claude" | "codex";
      prompt?: string;
      remoteControl?: boolean;
    };
  }>(
    "/api/workspaces",
    {
      schema: {
        body: {
          type: "object",
          required: ["repoId", "agent"],
          properties: {
            repoId: { type: "string" },
            baseBranch: { type: "string" },
            name: { type: "string" },
            agent: { enum: ["claude", "codex"] },
            prompt: { type: "string" },
            remoteControl: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const ws = await s.workspaces.create(request.body);
      void s.workspaces.continue(ws.id).catch(() => undefined);
      return reply.code(202).send(ws);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/workspaces/:id/continue",
    { schema: { params: idParam } },
    async (request, reply) => {
      const ws = s.workspaces.get(request.params.id);
      if (ws.status === "setup_failed") {
        void s.workspaces.retrySetup(ws.id).catch(() => undefined);
      } else {
        void s.workspaces.continue(ws.id).catch(() => undefined);
      }
      return reply.code(202).send(ws);
    },
  );

  app.patch<{ Params: { id: string }; Body: { name: string } }>(
    "/api/workspaces/:id",
    {
      schema: {
        params: idParam,
        body: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
      },
    },
    async (request) => s.workspaces.rename(request.params.id, request.body.name),
  );

  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id",
    { schema: { params: idParam } },
    async (request) => s.workspaces.get(request.params.id),
  );

  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/setup-log",
    { schema: { params: idParam } },
    async (request) => ({
      log: s.workspaces.readSetupLog(request.params.id),
    }),
  );
}
