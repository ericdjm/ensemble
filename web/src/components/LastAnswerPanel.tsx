import { useEffect, useState } from "react";
import type { LastAnswer, Session } from "../../../shared/types.js";
import { api } from "../api.js";

/** Fetches the session's captured last answer whenever lastAnswerAt changes. */
export function useLastAnswer(session: Session): LastAnswer | null {
  const [answer, setAnswer] = useState<LastAnswer | null>(null);
  const at = session.lastAnswerAt;
  useEffect(() => {
    let cancelled = false;
    if (!at) {
      setAnswer(null);
      return;
    }
    api<LastAnswer>("GET", `/api/sessions/${session.id}/last-answer`)
      .then((a) => {
        if (!cancelled) setAnswer(a);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session.id, at]);
  return answer;
}

const SOURCE_LABEL: Record<NonNullable<Session["lastAnswerSource"]>, string> = {
  "stop-payload": "from the Stop hook",
  "codex-notify": "from Codex notify",
  transcript: "from the transcript file (fallback; may lag)",
};

export function LastAnswerPanel({
  session,
  answer,
  onSend,
}: {
  session: Session;
  answer: LastAnswer | null;
  onSend: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!session.lastAnswerAt) return null;
  const when = new Date(session.lastAnswerAt).toLocaleTimeString();
  return (
    <div className="rounded border border-neutral-200 text-xs dark:border-neutral-800">
      <div className="flex items-center gap-2 px-2 py-1">
        <button className="btn-ghost text-xs" onClick={() => setOpen((o) => !o)}>
          {open ? "▾" : "▸"} Last answer
        </button>
        <span
          className="min-w-0 flex-1 truncate text-neutral-500"
          title={session.lastAnswerSource ? SOURCE_LABEL[session.lastAnswerSource] : undefined}
        >
          {when} · {session.lastAnswerPreview}
        </span>
        <button className="btn-ghost text-xs" onClick={onSend} disabled={!answer?.text}>
          Send to…
        </button>
      </div>
      {open && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-neutral-200 bg-neutral-50 p-2 font-mono text-[11px] dark:border-neutral-800 dark:bg-neutral-900">
          {answer?.text ?? "loading…"}
        </pre>
      )}
    </div>
  );
}
