import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { BRANCH_PREFIX_DEFAULT, PRODUCT_SLUG, STATE_DIR_NAME } from "../shared/brand.js";

export interface Config {
  version: 1;
  /** Random token exchanged for the browser cookie at /login. */
  uiToken: string;
  /** Loopback port of the hook listener; chosen once and never changed automatically. */
  hookPort: number;
  /** Parent directory for worktrees: <workspaceRoot>/<repo-slug>/<workspace-name>. */
  workspaceRoot: string;
  branchPrefix: string;
  portBase: number;
  cliPaths: { claude?: string; codex?: string };
  billingOptIn: boolean;
  remoteControlDefault: boolean;
  /** Extra Host header values accepted by the UI listener (for --host setups). */
  allowedHosts: string[];
  spool: { payloadCapBytes: number; totalCapBytes: number };
}

export const HOOK_PORT_MIN = 49152;
export const HOOK_PORT_MAX = 65535;

export function defaultStateDir(): string {
  return process.env["ENSEMBLE_STATE_DIR"] ?? path.join(os.homedir(), STATE_DIR_NAME);
}

export function statePaths(stateDir: string) {
  return {
    root: stateDir,
    config: path.join(stateDir, "config.json"),
    db: path.join(stateDir, "ensemble.db"),
    logs: path.join(stateDir, "logs"),
    sessions: path.join(stateDir, "sessions"),
    archives: path.join(stateDir, "archives"),
  };
}

/** Creates the private state directory tree (0700) if needed. */
export function ensureStateDirs(stateDir: string): void {
  const p = statePaths(stateDir);
  for (const dir of [p.root, p.logs, p.sessions, p.archives]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
}

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

function randomPort(): number {
  return HOOK_PORT_MIN + Math.floor(Math.random() * (HOOK_PORT_MAX - HOOK_PORT_MIN + 1));
}

/** Resolves to true when the port can be bound on 127.0.0.1 right now. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}

export async function pickFreeHookPort(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const port = randomPort();
    if (await isPortFree(port)) return port;
  }
  throw new Error("could not find a free loopback port for the hook listener");
}

export function defaultConfig(uiToken: string, hookPort: number): Config {
  return {
    version: 1,
    uiToken,
    hookPort,
    workspaceRoot: path.join(os.homedir(), PRODUCT_SLUG),
    branchPrefix: BRANCH_PREFIX_DEFAULT,
    portBase: 41000,
    cliPaths: {},
    billingOptIn: false,
    remoteControlDefault: false,
    allowedHosts: [],
    spool: { payloadCapBytes: 256 * 1024, totalCapBytes: 64 * 1024 * 1024 },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validates a parsed config.json, filling defaults for optional keys. Throws on bad values. */
export function validateConfig(raw: unknown): Config {
  if (!isRecord(raw)) throw new Error("config.json must be an object");
  if (raw["version"] !== 1) throw new Error("config.json: unsupported version");
  const token = raw["uiToken"];
  if (typeof token !== "string" || token.length < 16) throw new Error("config.json: bad uiToken");
  const hookPort = raw["hookPort"];
  if (!Number.isInteger(hookPort) || (hookPort as number) < 1 || (hookPort as number) > 65535) {
    throw new Error("config.json: bad hookPort");
  }
  const base = defaultConfig(token, hookPort as number);
  const str = (k: keyof Config, fallback: string): string => {
    const v = raw[k];
    if (v === undefined) return fallback;
    if (typeof v !== "string" || v.length === 0) throw new Error(`config.json: bad ${k}`);
    return v;
  };
  const bool = (k: keyof Config, fallback: boolean): boolean => {
    const v = raw[k];
    if (v === undefined) return fallback;
    if (typeof v !== "boolean") throw new Error(`config.json: bad ${k}`);
    return v;
  };
  const int = (v: unknown, name: string, fallback: number): number => {
    if (v === undefined) return fallback;
    if (!Number.isInteger(v) || (v as number) < 0) throw new Error(`config.json: bad ${name}`);
    return v as number;
  };
  const cliPaths: Config["cliPaths"] = {};
  const rawCli = raw["cliPaths"];
  if (rawCli !== undefined) {
    if (!isRecord(rawCli)) throw new Error("config.json: bad cliPaths");
    for (const key of ["claude", "codex"] as const) {
      const v = rawCli[key];
      if (v === undefined) continue;
      if (typeof v !== "string" || !path.isAbsolute(v)) {
        throw new Error(`config.json: cliPaths.${key} must be an absolute path`);
      }
      cliPaths[key] = v;
    }
  }
  const rawHosts = raw["allowedHosts"];
  const allowedHosts: string[] = [];
  if (rawHosts !== undefined) {
    if (!Array.isArray(rawHosts) || rawHosts.some((h) => typeof h !== "string")) {
      throw new Error("config.json: bad allowedHosts");
    }
    allowedHosts.push(...(rawHosts as string[]));
  }
  const rawSpool = raw["spool"];
  const spool = { ...base.spool };
  if (rawSpool !== undefined) {
    if (!isRecord(rawSpool)) throw new Error("config.json: bad spool");
    spool.payloadCapBytes = int(
      rawSpool["payloadCapBytes"],
      "spool.payloadCapBytes",
      spool.payloadCapBytes,
    );
    spool.totalCapBytes = int(
      rawSpool["totalCapBytes"],
      "spool.totalCapBytes",
      spool.totalCapBytes,
    );
  }
  return {
    version: 1,
    uiToken: token,
    hookPort: hookPort as number,
    workspaceRoot: str("workspaceRoot", base.workspaceRoot),
    branchPrefix: str("branchPrefix", base.branchPrefix),
    portBase: int(raw["portBase"], "portBase", base.portBase),
    cliPaths,
    billingOptIn: bool("billingOptIn", base.billingOptIn),
    remoteControlDefault: bool("remoteControlDefault", base.remoteControlDefault),
    allowedHosts,
    spool,
  };
}

/** Writes config.json atomically with mode 0600. */
export function saveConfig(stateDir: string, config: Config): void {
  const file = statePaths(stateDir).config;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** Loads config.json, creating it with a fresh token and hook port on first run. */
export async function loadConfig(stateDir: string): Promise<Config> {
  ensureStateDirs(stateDir);
  const file = statePaths(stateDir).config;
  if (!existsSync(file)) {
    const config = defaultConfig(generateToken(), await pickFreeHookPort());
    saveConfig(stateDir, config);
    return config;
  }
  const config = validateConfig(JSON.parse(readFileSync(file, "utf8")));
  chmodSync(file, 0o600);
  return config;
}

export function rotateToken(stateDir: string, config: Config): Config {
  const next = { ...config, uiToken: generateToken() };
  saveConfig(stateDir, next);
  return next;
}
