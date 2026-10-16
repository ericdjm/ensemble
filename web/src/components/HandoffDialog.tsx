import { useMemo, useState } from "react";
import type { Session } from "../../../shared/types.js";
import { api } from "../api.js";
import { useUiState } from "../store.js";
import { Dialog } from "./Dialog.js";

type Template = "review" | "implement" | "summarize" | "free";
const TEMPLATES: Array<{ id: Template; label: string; preamble: string }> = [
  {
    id: "review",
    label: "Review this",
    preamble:
      "Please review the following and reply with concrete problems and suggested changes:\n\n",
  },
  {
    id: "implement",
    label: "Implement this",
    preamble: "Please implement the following. Reply with a summary of what you changed:\n\n",
  },
  {
    id: "summarize",
    label: "Summarize for the other agent",
    preamble: "Summarize the following for another coding agent in at most ten bullet points:\n\n",
  },
  { id: "free", label: "Free text", preamble: "" },
];

/** Label used in pickers: agent · repo/workspace. */
export function sessionLabel(
  s: Session,
  ui: ReturnType<typeof useUiState>,
  withStatus = true,
): string {
  const ws = ui.snapshot?.workspaces.find((w) => w.id === s.workspaceId);
  const repo = ws ? ui.snapshot?.repos.find((r) => r.id === ws.repoId) : undefined;
  const where = ws ? `${repo ? `${repo.name}/` : ""}${ws.name}` : "workspace";
  return `${s.agent} · ${where}${withStatus ? ` (${s.status})` : ""} · ${s.id.slice(0, 8)}`;
}

export function HandoffDialog({
  from,
  answer,
  onClose,
}: {
  from: Session;
  answer: string;
  onClose: () => void;
}) {
  const ui = useUiState();
  const targets = useMemo(
    () =>
      (ui.snapshot?.sessions ?? []).filter((s) => s.id !== from.id && s.processState === "running"),
    [ui.snapshot, from.id],
  );
  const [targetId, setTargetId] = useState<string>(targets[0]?.id ?? "");
  const [template, setTemplate] = useState<Template>("review");
  const [text, setText] = useState(`${TEMPLATES[0]?.preamble ?? ""}${answer}`);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const target = targets.find((t) => t.id === targetId);

  const pick = (t: Template) => {
    setTemplate(t);
    const pre = TEMPLATES.find((x) => x.id === t)?.preamble ?? "";
    setText(`${pre}${answer}`);
  };
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/api/sessions/${from.id}/handoff`, { targetSessionId: targetId, text });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Send to another session" onClose={onClose} wide>
      <form className="space-y-3 text-sm" onSubmit={send}>
        {targets.length === 0 ? (
          <p className="text-neutral-500">No other running session to send to.</p>
        ) : (
          <label className="block">
            Target
            <select
              className="input"
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
            >
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {sessionLabel(t, ui)}
                </option>
              ))}
            </select>
          </label>
        )}
        {target && target.status !== "idle" && (
          <p className="rounded bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            The target is {target.status}; the text will be queued as its next prompt.
          </p>
        )}
        <fieldset className="flex flex-wrap gap-3">
          {TEMPLATES.map((t) => (
            <label key={t.id} className="flex items-center gap-1">
              <input
                type="radio"
                name="template"
                checked={template === t.id}
                onChange={() => pick(t.id)}
              />
              {t.label}
            </label>
          ))}
        </fieldset>
        <label className="block">
          Message{" "}
          <span className="text-neutral-500">
            (delivered as a prompt prefixed with “From {from.agent} in …”)
          </span>
          <textarea
            className="input min-h-48 font-mono text-xs"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        {error && <p className="text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn-primary"
            disabled={busy || !targetId || !text.trim()}
          >
            Send
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function AskAllDialog({
  workspaceId,
  count,
  onClose,
}: {
  workspaceId: string;
  count: number;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/api/workspaces/${workspaceId}/ask-all`, { text });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={`Ask all ${count} running sessions`} onClose={onClose}>
      <form className="space-y-3 text-sm" onSubmit={send}>
        <p className="text-neutral-500">
          The same prompt is sent to every running session in this workspace. Sessions that are
          working receive it as their next prompt.
        </p>
        <textarea
          className="input min-h-32"
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {error && <p className="text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy || !text.trim()}>
            Send to all
          </button>
        </div>
      </form>
    </Dialog>
  );
}
