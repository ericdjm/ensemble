import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { validatePattern } from "./copy/plan.js";

export const REPO_CONFIG_FILENAME = ".ensemble.json";
export type ScriptKind = "setup" | "run" | "archive";
export const SCRIPT_KINDS: readonly ScriptKind[] = ["setup", "run", "archive"];

export interface RepoConfig {
  setup: string | null;
  run: string | null;
  archive: string | null;
  copy: string[];
  defaultAgent: "claude" | "codex" | null;
}

export const EMPTY_REPO_CONFIG: RepoConfig = {
  setup: null,
  run: null,
  archive: null,
  copy: [],
  defaultAgent: null,
};

/** Per-user overrides stored in app settings; any key present replaces the repo's value. */
export type RepoConfigOverrides = Partial<RepoConfig>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function scriptField(raw: Record<string, unknown>, key: ScriptKind): string | null {
  const v = raw[key];
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new Error(`${key} must be a string`);
  if (v.length > 64 * 1024) throw new Error(`${key} is too long`);
  return v;
}

/** Validates a parsed .ensemble.json object. Unknown keys are ignored. */
export function parseRepoConfig(raw: unknown): RepoConfig {
  if (!isRecord(raw)) throw new Error(`${REPO_CONFIG_FILENAME} must be a JSON object`);
  const copy: string[] = [];
  const rawCopy = raw["copy"];
  if (rawCopy !== undefined) {
    if (!Array.isArray(rawCopy)) throw new Error("copy must be an array of patterns");
    for (const p of rawCopy) {
      const err = validatePattern(p);
      if (err) throw new Error(`copy pattern ${JSON.stringify(p)}: ${err}`);
      copy.push(p as string);
    }
  }
  let defaultAgent: RepoConfig["defaultAgent"] = null;
  const rawAgent = raw["defaultAgent"];
  if (rawAgent !== undefined && rawAgent !== null) {
    if (rawAgent !== "claude" && rawAgent !== "codex")
      throw new Error("defaultAgent must be 'claude' or 'codex'");
    defaultAgent = rawAgent;
  }
  return {
    setup: scriptField(raw, "setup"),
    run: scriptField(raw, "run"),
    archive: scriptField(raw, "archive"),
    copy,
    defaultAgent,
  };
}

export interface RepoConfigFile {
  exists: boolean;
  config: RepoConfig;
  error: string | null;
}

/** Reads <repo>/.ensemble.json; a missing file yields the empty config, a broken one yields an error. */
export function readRepoConfigFile(repoPath: string): RepoConfigFile {
  let text: string;
  try {
    text = readFileSync(path.join(repoPath, REPO_CONFIG_FILENAME), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { exists: false, config: EMPTY_REPO_CONFIG, error: null };
    return { exists: true, config: EMPTY_REPO_CONFIG, error: (e as Error).message };
  }
  try {
    return { exists: true, config: parseRepoConfig(JSON.parse(text)), error: null };
  } catch (e) {
    return { exists: true, config: EMPTY_REPO_CONFIG, error: (e as Error).message };
  }
}

export function applyOverrides(config: RepoConfig, overrides: RepoConfigOverrides): RepoConfig {
  return { ...config, ...overrides };
}

export function scriptHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
