import chokidar, { type FSWatcher } from "chokidar";
import path from "node:path";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "target",
  "__pycache__",
]);

/** Debounced per-workspace file watching; emits one "changed" callback per burst. */
export class WorkspaceWatcher {
  private watchers = new Map<string, { watcher: FSWatcher; timer: NodeJS.Timeout | null }>();

  constructor(
    private readonly onChanged: (workspaceId: string) => void,
    private readonly debounceMs = 300,
  ) {}

  watch(workspaceId: string, root: string): void {
    if (this.watchers.has(workspaceId)) return;
    const watcher = chokidar.watch(root, {
      ignoreInitial: true,
      ignored: (p: string) => {
        const rel = path.relative(root, p);
        if (!rel || rel.startsWith("..")) return false;
        return rel.split(path.sep).some((c) => IGNORED_DIRS.has(c));
      },
      persistent: true,
      ignorePermissionErrors: true,
    });
    const entry = { watcher, timer: null as NodeJS.Timeout | null };
    const bump = () => {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        this.onChanged(workspaceId);
      }, this.debounceMs);
      entry.timer.unref();
    };
    watcher.on("all", bump);
    watcher.on("error", () => undefined);
    this.watchers.set(workspaceId, entry);
  }

  async unwatch(workspaceId: string): Promise<void> {
    const entry = this.watchers.get(workspaceId);
    if (!entry) return;
    this.watchers.delete(workspaceId);
    if (entry.timer) clearTimeout(entry.timer);
    await entry.watcher.close();
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.watchers.keys()]) await this.unwatch(id);
  }
}
