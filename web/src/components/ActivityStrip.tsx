import type { Session } from "../../../shared/types.js";
import { SessionStatusBadge } from "./SessionBadges.js";

export function sessionTitle(s: Session): string {
  return s.label ? s.label : s.agent;
}

/** Sorts pinned sessions first, then running before finished, then by creation time. */
export function orderSessions(list: Session[]): Session[] {
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const ar = a.processState === "running" ? 0 : 1;
    const br = b.processState === "running" ? 0 : 1;
    if (ar !== br) return ar - br;
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });
}

/** Each session's status and latest answer side by side (docs/plan-v2.md Phase 4). */
export function ActivityStrip({
  sessions,
  selectedId,
  onSelect,
}: {
  sessions: Session[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const shown = orderSessions(sessions).filter(
    (s) => s.processState === "running" || s.pinned || s.lastAnswerAt !== null,
  );
  if (shown.length < 2) return null;
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {shown.map((s) => (
        <button
          key={s.id}
          className={`rounded-md border p-2 text-left text-xs hover:bg-neutral-50 dark:hover:bg-neutral-900 ${selectedId === s.id ? "border-neutral-900 dark:border-neutral-100" : "border-neutral-200 dark:border-neutral-800"}`}
          onClick={() => onSelect(s.id)}
          title={s.notes ?? undefined}
        >
          <div className="flex items-center gap-2">
            {s.pinned && <span title="pinned">📌</span>}
            <span className="truncate font-medium">{sessionTitle(s)}</span>
            {s.label && <span className="text-neutral-500">{s.agent}</span>}
            <span className="ml-auto">
              <SessionStatusBadge session={s} />
            </span>
          </div>
          <p className="mt-1 line-clamp-2 min-h-8 text-neutral-600 dark:text-neutral-400">
            {s.lastAnswerPreview ?? (s.processState === "running" ? "No answer yet." : "")}
          </p>
          {s.lastAnswerAt && (
            <p className="mt-1 text-[10px] text-neutral-400">
              {new Date(s.lastAnswerAt).toLocaleTimeString()}
            </p>
          )}
        </button>
      ))}
    </div>
  );
}
