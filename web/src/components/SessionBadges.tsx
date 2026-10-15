import type { Session } from "../../../shared/types.js";

const STATUS: Record<Session["status"], { text: string; cls: string; spin?: boolean }> = {
  starting: {
    text: "starting",
    cls: "bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-200",
    spin: true,
  },
  working: {
    text: "working",
    cls: "bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-200",
    spin: true,
  },
  needs_input: {
    text: "needs input",
    cls: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
  },
  idle: {
    text: "idle",
    cls: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200",
  },
  exited: {
    text: "exited",
    cls: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  },
  error: { text: "error", cls: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200" },
};

/** What the sidebar and session list show: liveness overrides turn status. */
export function effectiveStatus(s: Session): Session["status"] {
  if (s.processState === "dead" || s.processState === "missing")
    return s.status === "error" ? "error" : "exited";
  return s.status;
}

export function SessionStatusBadge({ session }: { session: Session }) {
  const status = effectiveStatus(session);
  const l = STATUS[status];
  const suffix = status === "exited" && session.exitCode !== null ? ` (${session.exitCode})` : "";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${l.cls}`}
    >
      {l.spin && session.processState === "running" && (
        <span className="inline-block h-2 w-2 animate-spin rounded-full border border-current border-t-transparent" />
      )}
      {status === "needs_input" && (
        <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
      )}
      {l.text}
      {suffix}
      {session.freshness !== "current" && session.processState === "running" && (
        <span title={`status freshness: ${session.freshness}`} className="opacity-70">
          ?
        </span>
      )}
    </span>
  );
}

export function AuthBadge({ session }: { session: Session }) {
  if (session.authMode === "unchecked") return null;
  const cls =
    session.authMode === "subscription"
      ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200"
      : "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200";
  const text =
    session.authMode === "subscription"
      ? "subscription"
      : session.authMode === "api"
        ? "API billing"
        : `unverified: ${session.authLabel ?? session.authMode}`;
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs ${cls}`}
      title={session.authLabel ?? undefined}
    >
      {text}
    </span>
  );
}
