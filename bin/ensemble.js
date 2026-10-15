#!/usr/bin/env node
// CLI entry. `pnpm start` runs this; it builds first when the build output is missing.
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(root, "dist", "server", "index.js");
const webIndex = path.join(root, "web", "dist", "index.html");

if (!existsSync(serverEntry) || !existsSync(webIndex)) {
  console.log("Build output missing; running `pnpm build`...");
  const result = spawnSync("pnpm", ["build"], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    console.error("Build failed. Run `pnpm install && pnpm build` and try again.");
    process.exit(result.status ?? 1);
  }
}

const { main } = await import(serverEntry);
await main(process.argv.slice(2));
