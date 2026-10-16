import { useMemo, useState } from "react";
import type { Relay, Session } from "../../../shared/types.js";
import { api } from "../api.js";
import { useUiState } from "../store.js";
import { Dialog } from "./Dialog.js";
import { sessionLabel } from "./HandoffDialog.js";

export function RelayDialog({ from, onClose }: { from: Session; onClose: () => void }) {
  const ui = useUiState();
  const others = useMemo(
    () =>
      (ui.snapshot?.sessions ?? []).filter((s) => s.id !== from.id && s.processState === "running"),
    [ui.snapshot, from.id],
  );
  const [otherId, setOtherId] = useState(others[0]?.id ?? "");
  const [kickoff, setKickoff] = useState("");
  const [maxRounds, setMaxRounds] = useState(4);
  const [marker, setMarker] = useState("RELAY_DONE");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/api/relays", {
        aSessionId: from.id,
        bSessionId: otherId,
        kickoff,
        maxRounds,
        doneMarker: marker.trim(),
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Start a bounded relay" onClose={onClose} wide>
      <form className="space-y-3 text-sm" onSubmit={start}>
        <p className="text-neutral-500">
          Your kickoff goes to this session ({from.agent}). Each time one of the two sessions
          finishes a turn, its answer is sent verbatim to the other, at most the number of hops
          below, until an answer contains the done marker, or you stop it. Both sessions must be
          idle to start; the relay ends with an error if a target is busy.
        </p>
        <label className="block">
          Other session
          <select className="input" value={otherId} onChange={(e) => setOtherId(e.target.value)}>
            {others.map((s) => (
              <option key={s.id} value={s.id}>
                {sessionLabel(s, ui)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          Kickoff prompt (to {from.agent})
          <textarea
            className="input min-h-28"
            value={kickoff}
            onChange={(e) => setKickoff(e.target.value)}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            Max hops (1–20)
            <input
              className="input"
              type="number"
              min={1}
              max={20}
              value={maxRounds}
              onChange={(e) => setMaxRounds(Number(e.target.value))}
            />
          </label>
          <label className="block">
            Done marker (one word)
            <input
              className="input font-mono"
              value={marker}
              onChange={(e) => setMarker(e.target.value)}
            />
          </label>
        </div>
        {error && <p className="text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn-primary"
            disabled={busy || !otherId || !kickoff.trim() || !marker.trim()}
          >
            Start relay
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function RelayBanner({ relay, session }: { relay: Relay; session: Session }) {
  const ui = useUiState();
  const other = (ui.snapshot?.sessions ?? []).find(
    (s) => s.id === (relay.aSessionId === session.id ? relay.bSessionId : relay.aSessionId),
  );
  const running = relay.status === "running";
  const cls = running
    ? "bg-blue-50 text-blue-900 dark:bg-blue-950/40 dark:text-blue-200"
    : relay.status === "done"
      ? "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
      : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";
  return (
    <div className={`flex flex-wrap items-center gap-2 rounded p-2 text-xs ${cls}`}>
      <span>
        Relay with {other ? sessionLabel(other, ui, false) : "another session"}: {relay.status}
        {running && relay.awaitingSessionId === session.id ? ", waiting for this session" : ""}, hop{" "}
        {relay.roundsDone} of {relay.maxRounds}
        {relay.error ? ` (${relay.error})` : ""}
      </span>
      {running && (
        <button
          className="btn-ghost ml-auto text-xs"
          onClick={() => api("POST", `/api/relays/${relay.id}/stop`).catch(() => undefined)}
        >
          Stop relay
        </button>
      )}
    </div>
  );
}
