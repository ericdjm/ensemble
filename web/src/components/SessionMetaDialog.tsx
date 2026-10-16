import { useState } from "react";
import type { Session } from "../../../shared/types.js";
import { api } from "../api.js";
import { Dialog } from "./Dialog.js";

/** Label, notes, and pin for one session (docs/plan-v2.md Phase 4). */
export function SessionMetaDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const [label, setLabel] = useState(session.label ?? "");
  const [notes, setNotes] = useState(session.notes ?? "");
  const [pinned, setPinned] = useState(session.pinned);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("PATCH", `/api/sessions/${session.id}`, { label, notes, pinned });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Label and notes" onClose={onClose}>
      <form className="space-y-3 text-sm" onSubmit={save}>
        <label className="block">
          Label <span className="text-neutral-500">(shown instead of the agent name)</span>
          <input
            className="input"
            autoFocus
            maxLength={80}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={session.agent}
          />
        </label>
        <label className="block">
          Notes <span className="text-neutral-500">(for you; never sent to the agent)</span>
          <textarea
            className="input min-h-28"
            maxLength={20000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
          Pin to the top of this workspace&apos;s session list
        </label>
        {error && <p className="text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}
