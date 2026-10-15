import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import type { PrCheck, PrInfo } from "../shared/types.js";
import type { Db } from "./db/index.js";
import { git } from "./git.js";
import { WorkspaceError, type WorkspaceService } from "./workspaces.js";

export type MergeMethod = "squash" | "merge" | "rebase";

const PR_FIELDS =
  "number,url,state,title,isDraft,mergeable,reviewDecision,statusCheckRollup,mergedAt,baseRefName,headRefName";

function run(
  bin: string,
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd,
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          PATH: process.env["PATH"] ?? "",
          HOME: process.env["HOME"] ?? "",
          GH_PROMPT_DISABLED: "1",
          GH_NO_UPDATE_NOTIFIER: "1",
          ...extraEnv,
        },
      },
      (error, stdout, stderr) => {
        const code = error
          ? typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code as number)
            : 1
          : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Normalises `gh pr view --json` output into PrInfo; tolerant of missing fields. */
export function parsePrView(raw: unknown): PrInfo {
  const p = rec(raw);
  const rollup = Array.isArray(p["statusCheckRollup"]) ? (p["statusCheckRollup"] as unknown[]) : [];
  const checks: PrCheck[] = rollup.map((c) => {
    const r = rec(c);
    const name = String(r["name"] ?? r["context"] ?? r["workflowName"] ?? "check");
    const status = String(r["status"] ?? r["state"] ?? "").toUpperCase();
    const conclusion = String(r["conclusion"] ?? r["state"] ?? "").toUpperCase();
    let result: PrCheck["result"] = "pending";
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) result = "passed";
    else if (
      ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(
        conclusion,
      )
    )
      result = "failed";
    else if (status === "COMPLETED" && conclusion) result = "failed";
    return {
      name,
      result,
      url:
        typeof r["detailsUrl"] === "string"
          ? r["detailsUrl"]
          : typeof r["targetUrl"] === "string"
            ? r["targetUrl"]
            : null,
    };
  });
  return {
    number: Number(p["number"] ?? 0),
    url: String(p["url"] ?? ""),
    state: String(p["state"] ?? "UNKNOWN"),
    title: String(p["title"] ?? ""),
    isDraft: p["isDraft"] === true,
    mergeable: typeof p["mergeable"] === "string" ? p["mergeable"] : null,
    reviewDecision:
      typeof p["reviewDecision"] === "string" && p["reviewDecision"] ? p["reviewDecision"] : null,
    checks,
    mergedAt: typeof p["mergedAt"] === "string" ? p["mergedAt"] : null,
    baseRefName: typeof p["baseRefName"] === "string" ? p["baseRefName"] : null,
    fetchedAt: new Date().toISOString(),
  };
}

export interface PrServiceDeps {
  db: Db;
  workspaces: WorkspaceService;
  ghBinary?: string;
  pollMs?: number;
  /** Test-only: extra environment for the fake gh. */
  ghEnv?: Record<string, string>;
}

/** GitHub flow through the user's own `gh` CLI (docs/architecture.md §8.2). Tokens are never handled here. */
export class PrService extends EventEmitter {
  private readonly db: Db;
  private readonly workspaces: WorkspaceService;
  private readonly gh: string;
  private readonly ghEnv: Record<string, string>;
  private readonly pollMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: PrServiceDeps) {
    super();
    this.db = deps.db;
    this.workspaces = deps.workspaces;
    this.gh = deps.ghBinary ?? "gh";
    this.ghEnv = deps.ghEnv ?? {};
    this.pollMs = deps.pollMs ?? 60_000;
  }

  async ghAuth(): Promise<{ ok: boolean; summary: string }> {
    const r = await run(this.gh, ["auth", "status"], process.env["HOME"] ?? "/", this.ghEnv);
    const line =
      `${r.stdout}\n${r.stderr}`
        .split("\n")
        .find((l) => /Logged in to/i.test(l))
        ?.trim() ?? null;
    return {
      ok: r.code === 0,
      summary: line
        ? line.replace(/\s+/g, " ").slice(0, 160)
        : r.code === 0
          ? "logged in"
          : "gh is not logged in (run `gh auth login`)",
    };
  }

  private async requireGh(): Promise<void> {
    const auth = await this.ghAuth();
    if (!auth.ok) throw new WorkspaceError(auth.summary, 409);
  }

  async push(workspaceId: string): Promise<{ branch: string; output: string }> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws.creation.steps.worktree || ws.status === "archived")
      throw new WorkspaceError("workspace has no worktree", 409);
    try {
      await git(["remote", "get-url", "origin"], { cwd: ws.path });
    } catch {
      throw new WorkspaceError("the repo has no `origin` remote", 409);
    }
    const out = await git(["push", "-u", "origin", `${ws.branch}:${ws.branch}`], {
      cwd: ws.path,
      timeoutMs: 300_000,
    });
    return { branch: ws.branch, output: out };
  }

  async create(
    workspaceId: string,
    input: { title: string; body: string; draft?: boolean },
  ): Promise<PrInfo> {
    const ws = this.workspaces.get(workspaceId);
    if (ws.pr) throw new WorkspaceError(`workspace already has PR #${ws.pr.number}`, 409);
    await this.requireGh();
    await this.push(workspaceId);
    const args = [
      "pr",
      "create",
      "--head",
      ws.branch,
      "--base",
      ws.baseBranch,
      "--title",
      input.title,
      "--body",
      input.body,
    ];
    if (input.draft) args.push("--draft");
    const r = await run(this.gh, args, ws.path, this.ghEnv);
    if (r.code !== 0)
      throw new WorkspaceError(
        `gh pr create failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`,
        409,
      );
    return this.refresh(workspaceId);
  }

  /** Fetches the PR for the workspace branch and persists it; clears a stale record if none exists. */
  async refresh(workspaceId: string): Promise<PrInfo> {
    const ws = this.workspaces.get(workspaceId);
    const r = await run(
      this.gh,
      ["pr", "view", ws.branch, "--json", PR_FIELDS],
      ws.path,
      this.ghEnv,
    );
    if (r.code !== 0) {
      if (/no pull requests found|could not find|not found/i.test(r.stderr))
        throw new WorkspaceError("no pull request for this branch", 404);
      throw new WorkspaceError(`gh pr view failed: ${r.stderr.trim().slice(0, 500)}`, 409);
    }
    let info: PrInfo;
    try {
      info = parsePrView(JSON.parse(r.stdout));
    } catch {
      throw new WorkspaceError("gh pr view returned unparsable JSON", 409);
    }
    this.db
      .prepare(
        "UPDATE workspaces SET pr_number = ?, pr_url = ?, pr_state = ?, pr_json = ? WHERE id = ?",
      )
      .run(info.number, info.url, info.state, JSON.stringify(info), ws.id);
    this.workspaces.emitChanged(ws.id);
    this.emit("changed", ws.id, info);
    return info;
  }

  async merge(workspaceId: string, method: MergeMethod): Promise<PrInfo> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws.pr) throw new WorkspaceError("no pull request to merge", 409);
    await this.requireGh();
    const flag = method === "squash" ? "--squash" : method === "rebase" ? "--rebase" : "--merge";
    const r = await run(this.gh, ["pr", "merge", String(ws.pr.number), flag], ws.path, this.ghEnv);
    if (r.code !== 0)
      throw new WorkspaceError(
        `gh pr merge failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`,
        409,
      );
    return this.refresh(workspaceId);
  }

  /** Polls open PRs (docs §8.2: ~60 s). */
  startPolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pollOnce(), this.pollMs);
    this.timer.unref();
  }

  stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async pollOnce(): Promise<void> {
    for (const ws of this.workspaces.list()) {
      if (ws.status === "archived" || !ws.pr || ws.pr.state !== "OPEN") continue;
      await this.refresh(ws.id).catch(() => undefined);
    }
  }
}
