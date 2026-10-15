import type { Db } from "./db/index.js";

export const PORT_BLOCK_SIZE = 10;

/** Lowest free block of PORT_BLOCK_SIZE ports at or above `base`, judged by non-archived workspaces only. */
export function allocatePortBlock(db: Db, base: number): number {
  const used = new Set(
    (
      db.prepare("SELECT port FROM workspaces WHERE status != 'archived'").all() as Array<{
        port: number;
      }>
    ).map((r) => r.port),
  );
  for (let port = base; port + PORT_BLOCK_SIZE - 1 <= 65535; port += PORT_BLOCK_SIZE) {
    if (!used.has(port)) return port;
  }
  throw new Error("no free port block");
}
