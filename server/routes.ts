import type { FastifyInstance } from "fastify";
import type { Db } from "./db/index.js";
import type { StateSnapshot } from "../shared/types.js";
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
import { ArchiveConflict, type ArchiveDecisions, type ArchiveService } from "./archive.js";
import type { SessionService } from "./sessions.js";
import type { HookListener } from "./hooks/listener.js";
import type { Tmux } from "./tmux.js";
import { doctorReport } from "./doctor.js";
import { summarizeEvent } from "./hooks/summary.js";
import { saveConfig, type Config } from "./config.js";
import type { SettingsView } from "../shared/types.js";
import { writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";

export interface Services {
  db: Db;
  workspaces: WorkspaceService;
  archive: ArchiveService;
  sessions: SessionService;
  listener: HookListener;
  tmux: Tmux;
  config: Config;
  stateDir: string;
}

function safeJson(v: unknown): unknown {
  try {
    return typeof v === "string" ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}

export function snapshot(s: Services): StateSnapshot {
  return { repos: listRepos(s.db), workspaces: s.workspaces.list(), sessions: s.sessions.list() };
}

const idParam = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1 } },
} as const;

export function registerRoutes(app: FastifyInstance, s: Services): void {
  app.setErrorHandler((rawError: unknown, _request, reply) => {
    const error = rawError as Error & { statusCode?: number };
    if (error instanceof ArchiveConflict)
      return reply.code(409).send({ error: error.message, inventory: error.inventory });
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
  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/archive-preflight",
    { schema: { params: idParam } },
    async (request) => s.archive.inventory(s.workspaces.get(request.params.id)),
  );

  app.post<{ Params: { id: string }; Body: ArchiveDecisions }>(
    "/api/workspaces/:id/archive",
    {
      schema: {
        params: idParam,
        body: {
          type: "object",
          required: ["inventoryHash", "forceDirty", "ignored"],
          properties: {
            inventoryHash: { type: "string" },
            forceDirty: { type: "boolean" },
            ignored: { type: "object", additionalProperties: { enum: ["keep", "discard"] } },
          },
        },
      },
    },
    async (request) => {
      const record = await s.archive.archive(request.params.id, request.body);
      return { workspace: s.workspaces.get(request.params.id), archive: record };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/workspaces/:id/branch",
    { schema: { params: idParam } },
    async (request, reply) => {
      await s.archive.deleteBranch(request.params.id);
      return reply.code(204).send();
    },
  );

  app.get<{ Querystring: { workspaceId?: string } }>("/api/archives", async (request) =>
    s.archive.listArchives(request.query.workspaceId),
  );

  app.post<{ Params: { id: string }; Body: { targetDir: string } }>(
    "/api/archives/:id/restore",
    {
      schema: {
        params: idParam,
        body: {
          type: "object",
          required: ["targetDir"],
          properties: { targetDir: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request) => ({
      restored: await s.archive.restore(request.params.id, request.body.targetDir),
    }),
  );

  app.delete<{ Params: { id: string } }>(
    "/api/archives/:id",
    { schema: { params: idParam } },
    async (request, reply) => {
      s.archive.deleteArchiveFiles(request.params.id);
      return reply.code(204).send();
    },
  );
  app.post<{ Params: { id: string }; Body: { app: "vscode" | "finder" } }>(
    "/api/workspaces/:id/open",
    {
      schema: {
        params: idParam,
        body: {
          type: "object",
          required: ["app"],
          properties: { app: { enum: ["vscode", "finder"] } },
        },
      },
    },
    async (request, reply) => {
      const ws = s.workspaces.get(request.params.id);
      if (process.platform !== "darwin")
        return reply.code(501).send({ error: "only supported on macOS" });
      const args =
        request.body.app === "vscode" ? ["-a", "Visual Studio Code", ws.path] : ["-R", ws.path];
      await new Promise<void>((resolve, reject) =>
        execFile("open", args, (error) =>
          error ? reject(new WorkspaceError(error.message, 500)) : resolve(),
        ),
      );
      return reply.code(204).send();
    },
  );
  app.post<{
    Body: {
      workspaceId: string;
      agent: "claude" | "codex";
      prompt?: string;
      remoteControl?: boolean;
      billingAck?: boolean;
    };
  }>(
    "/api/sessions",
    {
      schema: {
        body: {
          type: "object",
          required: ["workspaceId", "agent"],
          properties: {
            workspaceId: { type: "string" },
            agent: { enum: ["claude", "codex"] },
            prompt: { type: "string", maxLength: 100000 },
            remoteControl: { type: "boolean" },
            billingAck: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => reply.code(202).send(await s.sessions.launch(request.body)),
  );

  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id",
    { schema: { params: idParam } },
    async (request) => s.sessions.get(request.params.id),
  );

  app.post<{
    Params: { id: string };
    Body: { cliSessionId?: string; billingAck?: boolean; picker?: boolean };
  }>(
    "/api/sessions/:id/resume",
    {
      schema: {
        params: idParam,
        body: {
          type: "object",
          properties: {
            cliSessionId: { type: "string", maxLength: 128 },
            billingAck: { type: "boolean" },
            picker: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body ?? {};
      const session = body.picker
        ? await s.sessions.openPicker(request.params.id)
        : await s.sessions.resume(request.params.id, body);
      return reply.code(202).send(session);
    },
  );

  app.post<{ Params: { id: string }; Body: { text: string } }>(
    "/api/sessions/:id/input",
    {
      schema: {
        params: idParam,
        body: {
          type: "object",
          required: ["text"],
          properties: { text: { type: "string", maxLength: 100000 } },
        },
      },
    },
    async (request, reply) => {
      await s.sessions.input(request.params.id, request.body.text);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/remote-control",
    { schema: { params: idParam } },
    async (request, reply) => {
      await s.sessions.sendCommand(request.params.id, "/remote-control");
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/kill",
    { schema: { params: idParam } },
    async (request) => s.sessions.kill(request.params.id),
  );

  app.get<{
    Params: { id: string };
    Querystring: { after?: number; type?: string; tool?: string; limit?: number };
  }>("/api/sessions/:id/events", { schema: { params: idParam } }, async (request) => {
    const session = s.sessions.get(request.params.id);
    const q = request.query;
    const limit = Math.min(1000, Math.max(1, Number(q.limit) || 200));
    const rows = s.db
      .prepare(
        "SELECT event_id, seq, generation, type, tool_name, source_ts, ingested_at, truncated, payload_json FROM events WHERE session_id = ? AND generation = ? AND seq > ? " +
          "AND (? IS NULL OR type = ?) AND (? IS NULL OR tool_name = ?) ORDER BY seq LIMIT ?",
      )
      .all(
        session.id,
        session.hookGeneration,
        Number(q.after) || 0,
        q.type ?? null,
        q.type ?? null,
        q.tool ?? null,
        q.tool ?? null,
        limit,
      ) as Array<Record<string, unknown>>;
    const gaps = s.db
      .prepare(
        "SELECT from_seq, to_seq, count, reason, recorded_at FROM event_gaps WHERE session_id = ? AND generation = ?",
      )
      .all(session.id, session.hookGeneration);
    return {
      events: rows.map((e) => ({
        eventId: e["event_id"],
        seq: e["seq"],
        generation: e["generation"],
        type: e["type"],
        toolName: e["tool_name"],
        sourceTs: e["source_ts"],
        ingestedAt: e["ingested_at"],
        truncated: e["truncated"] === 1,
        summary: summarizeEvent(
          String(e["type"]),
          (e["tool_name"] as string | null) ?? null,
          safeJson(e["payload_json"]),
        ),
      })),
      gaps,
    };
  });

  app.get<{ Params: { id: string; eventId: string } }>(
    "/api/sessions/:id/events/:eventId",
    async (request, reply) => {
      const row = s.db
        .prepare("SELECT payload_json FROM events WHERE session_id = ? AND event_id = ?")
        .get(request.params.id, request.params.eventId) as { payload_json: string } | undefined;
      if (!row) return reply.code(404).send({ error: "not found" });
      return reply.type("application/json").send(row.payload_json);
    },
  );

  app.get("/api/doctor", async () => doctorReport(s.config, s.db, s.tmux, s.listener.state));

  const settingsView = (): SettingsView => ({
    billingOptIn: s.config.billingOptIn,
    remoteControlDefault: s.config.remoteControlDefault,
    cliPaths: s.config.cliPaths,
    workspaceRoot: s.config.workspaceRoot,
    branchPrefix: s.config.branchPrefix,
    portBase: s.config.portBase,
  });
  app.get("/api/settings", async () => settingsView());
  app.put<{ Body: Partial<SettingsView> }>(
    "/api/settings",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            billingOptIn: { type: "boolean" },
            remoteControlDefault: { type: "boolean" },
            cliPaths: {
              type: "object",
              properties: { claude: { type: "string" }, codex: { type: "string" } },
            },
            workspaceRoot: { type: "string", minLength: 1 },
            branchPrefix: { type: "string", minLength: 1 },
            portBase: { type: "integer", minimum: 1024, maximum: 65000 },
          },
        },
      },
    },
    async (request) => {
      const b = request.body;
      if (b.billingOptIn !== undefined) s.config.billingOptIn = b.billingOptIn;
      if (b.remoteControlDefault !== undefined)
        s.config.remoteControlDefault = b.remoteControlDefault;
      if (b.cliPaths) {
        const next: Config["cliPaths"] = {};
        for (const k of ["claude", "codex"] as const) {
          const v = b.cliPaths[k];
          if (v && v.startsWith("/")) next[k] = v;
          else if (v) throw new WorkspaceError(`cliPaths.${k} must be an absolute path`);
        }
        s.config.cliPaths = next;
      }
      if (b.workspaceRoot) s.config.workspaceRoot = b.workspaceRoot;
      if (b.branchPrefix) s.config.branchPrefix = b.branchPrefix;
      if (b.portBase) s.config.portBase = b.portBase;
      saveConfig(s.stateDir, s.config);
      return settingsView();
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/events.jsonl",
    { schema: { params: idParam } },
    async (request, reply) => {
      const session = s.sessions.get(request.params.id);
      const rows = s.db
        .prepare(
          "SELECT event_id, seq, generation, type, tool_name, source_ts, ingested_at, truncated, payload_json FROM events WHERE session_id = ? AND generation = ? ORDER BY seq",
        )
        .all(session.id, session.hookGeneration) as Array<Record<string, unknown>>;
      const gaps = s.db
        .prepare(
          "SELECT from_seq, to_seq, count, reason, recorded_at FROM event_gaps WHERE session_id = ? AND generation = ? ORDER BY from_seq",
        )
        .all(session.id, session.hookGeneration) as Array<{
        from_seq: number;
        to_seq: number;
        count: number;
        reason: string;
        recorded_at: string;
      }>;
      const gapLine = (gap: (typeof gaps)[number]) =>
        JSON.stringify({
          gap: true,
          fromSeq: gap.from_seq,
          toSeq: gap.to_seq,
          count: gap.count,
          reason: gap.reason,
          recordedAt: gap.recorded_at,
        });
      const lines: string[] = [];
      let gi = 0;
      for (const e of rows) {
        const seq = e["seq"] as number;
        while (gi < gaps.length && (gaps[gi] as (typeof gaps)[number]).to_seq < seq)
          lines.push(gapLine(gaps[gi++] as (typeof gaps)[number]));
        lines.push(
          JSON.stringify({
            id: e["event_id"],
            sessionId: session.id,
            generation: e["generation"],
            seq,
            type: e["type"],
            tool: e["tool_name"],
            sourceTs: e["source_ts"],
            ingestedAt: e["ingested_at"],
            truncated: e["truncated"] === 1,
            payload: safeJson(e["payload_json"]),
          }),
        );
      }
      while (gi < gaps.length) lines.push(gapLine(gaps[gi++] as (typeof gaps)[number]));
      return reply
        .header("content-type", "application/x-ndjson; charset=utf-8")
        .header(
          "content-disposition",
          `attachment; filename="ensemble-events-${session.id.slice(0, 8)}.jsonl"`,
        )
        .send(lines.join("\n") + (lines.length ? "\n" : ""));
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/sessions/:id/events",
    { schema: { params: idParam } },
    async (request) => s.sessions.clearEvents(request.params.id),
  );
}
