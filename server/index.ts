import { execFile } from "node:child_process";
import { buildApp } from "./app.js";
import { defaultStateDir, loadConfig, rotateToken, statePaths } from "./config.js";
import { openDb } from "./db/index.js";
import { DEFAULT_UI_HOST, DEFAULT_UI_PORT, PRODUCT_NAME } from "../shared/brand.js";

export interface StartOptions {
  host: string;
  port: number;
  open: boolean;
  command: "start" | "token";
  rotate: boolean;
}

export function parseArgs(argv: string[]): StartOptions {
  const opts: StartOptions = {
    host: DEFAULT_UI_HOST,
    port: DEFAULT_UI_PORT,
    open: true,
    command: "start",
    rotate: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "start" || arg === "token") {
      opts.command = arg;
    } else if (arg === "--rotate") {
      opts.rotate = true;
    } else if (arg === "--no-open") {
      opts.open = false;
    } else if (arg === "--host") {
      const value = argv[++i];
      if (!value) throw new Error("--host requires a value");
      opts.host = value;
    } else if (arg === "--port") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new Error("--port requires an integer between 1 and 65535");
      }
      opts.port = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function loginUrl(host: string, port: number, token: string): string {
  const h =
    host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  return `http://${h}:${port}/login?token=${token}`;
}

export async function main(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  const stateDir = defaultStateDir();
  let config = await loadConfig(stateDir);

  if (opts.command === "token") {
    if (opts.rotate) {
      config = rotateToken(stateDir, config);
      console.log("Access token rotated. Existing browser logins are invalid after restart.");
    }
    console.log(loginUrl(opts.host, opts.port, config.uiToken));
    return;
  }

  const db = openDb(statePaths(stateDir).db);
  const app = await buildApp({ config, db, stateDir, host: opts.host, port: opts.port });
  await app.services.workspaces
    .reconcile()
    .catch((e: Error) => console.error(`reconcile: ${e.message}`));
  await app.fastify.listen({ host: opts.host, port: opts.port });
  const url = loginUrl(opts.host, opts.port, config.uiToken);
  console.log(`${PRODUCT_NAME} listening on http://${opts.host}:${opts.port}`);
  console.log(`Login URL: ${url}`);
  if (opts.host !== DEFAULT_UI_HOST) {
    console.log(
      "Warning: bound to a non-loopback address. Anyone who can reach it and has the token can run commands as you.",
    );
  }
  if (opts.open && process.platform === "darwin") {
    execFile("open", [url], () => undefined);
  }
}
