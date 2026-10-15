import type { WorkspaceStatus } from "../../../shared/types.js";

const LABELS: Record<WorkspaceStatus, { text: string; cls: string; spin?: boolean }> = {
  pending_approval: {
    text: "needs approval",
    cls: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
  },
  creating: {
    text: "creating",
    cls: "bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-200",
    spin: true,
  },
  copying: {
    text: "copying",
    cls: "bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-200",
    spin: true,
  },
  setting_up: {
    text: "setting up",
    cls: "bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-200",
    spin: true,
  },
  ready: {
    text: "ready",
    cls: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200",
  },
  setup_failed: {
    text: "setup failed",
    cls: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200",
  },
  archived: {
    text: "archived",
    cls: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  },
};

export function StatusBadge({ status }: { status: WorkspaceStatus }) {
  const l = LABELS[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${l.cls}`}
    >
      {l.spin && (
        <span className="inline-block h-2 w-2 animate-spin rounded-full border border-current border-t-transparent" />
      )}
      {l.text}
    </span>
  );
}
