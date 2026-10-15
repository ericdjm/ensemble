import { buildApp } from "./app.js";
import { DEFAULT_UI_HOST, DEFAULT_UI_PORT, PRODUCT_NAME } from "../shared/brand.js";

export interface StartOptions {
  host: string;
  port: number;
}

export function parseArgs(argv: string[]): StartOptions {
  const opts: StartOptions = { host: DEFAULT_UI_HOST, port: DEFAULT_UI_PORT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--host") {
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

export async function main(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  const app = await buildApp();
  const address = await app.listen({ host: opts.host, port: opts.port });
  console.log(`${PRODUCT_NAME} listening on ${address}`);
}
