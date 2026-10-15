import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { Db } from "./db/index.js";
import { nowIso } from "./db/index.js";
import { git } from "./git.js";
import { repoSlug } from "./names.js";
import {
  applyOverrides,
  parseRepoConfig,
  readRepoConfigFile,
  SCRIPT_KINDS,
  scriptHash,
  type RepoConfig,
  type RepoConfigOverrides,
  type ScriptKind,
} from "./repo-config.js";

export interface Repo {
  id: string;
  path: string;
  name: string;
  slug: string;
  defaultBase: string;
  createdAt: string;
}

interface RepoRow {
  id: string;
  path: string;
  name: string;
  slug: string;
  default_base: string;
  created_at: string;
}

function rowToRepo(r: RepoRow): Repo {
  return {
    id: r.id,
    path: r.path,
    name: r.name,
    slug: r.slug,
    defaultBase: r.default_base,
    createdAt: r.created_at,
  };
}

export function listRepos(db: Db): Repo[] {
  return (db.prepare("SELECT * FROM repos ORDER BY name").all() as RepoRow[]).map(rowToRepo);
}

export function getRepo(db: Db, id: string): Repo | undefined {
  const row = db.prepare("SELECT * FROM repos WHERE id = ?").get(id) as RepoRow | undefined;
  return row ? rowToRepo(row) : undefined;
}

async function detectDefaultBase(repoPath: string): Promise<string> {
  try {
    const ref = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      cwd: repoPath,
    });
    return ref.replace(/^origin\//, "");
  } catch {
    /* no origin HEAD */
  }
  try {
    const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath });
    if (head !== "HEAD") return head;
  } catch {
    /* unborn */
  }
  return "main";
}

/** Registers a local git repository (its top-level directory). */
export async function registerRepo(db: Db, inputPath: string): Promise<Repo> {
  const resolved = realpathSync(inputPath);
  const top = await git(["rev-parse", "--show-toplevel"], { cwd: resolved });
  if (realpathSync(top) !== resolved) {
    throw new Error(`${inputPath} is inside a repository; add its top level ${top} instead`);
  }
  const existing = db.prepare("SELECT * FROM repos WHERE path = ?").get(resolved) as
    RepoRow | undefined;
  if (existing) return rowToRepo(existing);

  const baseSlug = repoSlug(resolved);
  let slug = baseSlug;
  for (let i = 2; db.prepare("SELECT 1 FROM repos WHERE slug = ?").get(slug); i++)
    slug = `${baseSlug}-${i}`;

  const repo: Repo = {
    id: randomUUID(),
    path: resolved,
    name: resolved.split("/").pop() ?? resolved,
    slug,
    defaultBase: await detectDefaultBase(resolved),
    createdAt: nowIso(),
  };
  db.prepare(
    "INSERT INTO repos (id, path, name, slug, default_base, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(repo.id, repo.path, repo.name, repo.slug, repo.defaultBase, repo.createdAt);
  return repo;
}

export function removeRepo(db: Db, id: string): void {
  const active = db
    .prepare("SELECT COUNT(*) AS n FROM workspaces WHERE repo_id = ? AND status != 'archived'")
    .get(id) as { n: number };
  if (active.n > 0) throw new Error("archive the repo's workspaces before removing it");
  db.prepare("DELETE FROM repos WHERE id = ?").run(id);
}

const overridesKey = (repoId: string) => `repo:${repoId}:config`;

export function getOverrides(db: Db, repoId: string): RepoConfigOverrides {
  const row = db
    .prepare("SELECT value_json FROM settings WHERE key = ?")
    .get(overridesKey(repoId)) as { value_json: string } | undefined;
  if (!row) return {};
  const parsed = JSON.parse(row.value_json) as Record<string, unknown>;
  // Validate through the same parser so bad overrides cannot sneak in.
  const full = parseRepoConfig(parsed);
  const out: RepoConfigOverrides = {};
  for (const key of ["setup", "run", "archive", "copy", "defaultAgent"] as const) {
    if (key in parsed) (out as Record<string, unknown>)[key] = full[key];
  }
  return out;
}

export function setOverrides(db: Db, repoId: string, overrides: RepoConfigOverrides): void {
  parseRepoConfig(overrides); // throws on invalid values
  db.prepare(
    "INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
  ).run(overridesKey(repoId), JSON.stringify(overrides));
}

export interface ScriptApprovalState {
  kind: ScriptKind;
  script: string | null;
  hash: string | null;
  approved: boolean;
}

export interface EffectiveRepoConfig {
  file: ReturnType<typeof readRepoConfigFile>;
  overrides: RepoConfigOverrides;
  config: RepoConfig;
  scripts: ScriptApprovalState[];
  needsApproval: boolean;
}

/** The repo's file config merged with per-user overrides, plus approval state per script. */
export function effectiveRepoConfig(db: Db, repo: Repo): EffectiveRepoConfig {
  const file = readRepoConfigFile(repo.path);
  const overrides = getOverrides(db, repo.id);
  const config = applyOverrides(file.config, overrides);
  const approvals = new Map(
    (
      db
        .prepare("SELECT kind, script_hash FROM script_approvals WHERE repo_id = ?")
        .all(repo.id) as Array<{
        kind: ScriptKind;
        script_hash: string;
      }>
    ).map((r) => [r.kind, r.script_hash]),
  );
  const scripts = SCRIPT_KINDS.map((kind): ScriptApprovalState => {
    const script = config[kind];
    const hash = script === null ? null : scriptHash(script);
    return { kind, script, hash, approved: script === null || approvals.get(kind) === hash };
  });
  return { file, overrides, config, scripts, needsApproval: scripts.some((s) => !s.approved) };
}

/** Records approval of the given scripts; the hash must match the current effective text. */
export function approveScripts(
  db: Db,
  repo: Repo,
  approvals: Array<{ kind: ScriptKind; hash: string }>,
): void {
  const eff = effectiveRepoConfig(db, repo);
  const stmt = db.prepare(
    "INSERT INTO script_approvals (repo_id, kind, script_hash, script_text, approved_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(repo_id, kind) DO UPDATE SET script_hash = excluded.script_hash, script_text = excluded.script_text, approved_at = excluded.approved_at",
  );
  const run = db.transaction(() => {
    for (const a of approvals) {
      const current = eff.scripts.find((s) => s.kind === a.kind);
      if (!current || current.script === null || current.hash !== a.hash) {
        throw new Error(`${a.kind} script changed since it was shown; review it again`);
      }
      stmt.run(repo.id, a.kind, current.hash, current.script, nowIso());
    }
  });
  run();
}
