import { useCallback, useEffect, useState } from "react";
import type { ClaudeAgentView, ClaudeAgentsView, Session } from "../../../shared/types.js";
import { api } from "../api.js";
import { navigateToWorkspace } from "../route.js";
import { Dialog } from "./Dialog.js";

type Report = ClaudeAgentsView;

/** Lists `claude agents --json --all` and attaches background sessions into Ensemble (plan v2 Phase 3). */
export function ClaudeAgentsDialog({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setReport(await api<Report>("GET", "/api/claude-agents"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  const attach = async (a: ClaudeAgentView) => {
    if (!a.id) return;
    setBusy(a.id);
    setError(null);
    try {
      const s = await api<Session>("POST", `/api/claude-agents/${encodeURIComponent(a.id)}/attach`);
      navigateToWorkspace(s.workspaceId);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const background = report?.agents.filter((a) => a.kind === "background") ?? [];
  const interactive = report?.agents.filter((a) => a.kind === "interactive") ?? [];
  return (
    <Dialog title="Claude background sessions" onClose={onClose} wide>
      <div className="space-y-3 text-sm">
        <p className="text-neutral-500">
          Sessions started with <code>claude --bg</code>, read from{" "}
          <code>claude agents --json</code>. Attaching runs <code>claude attach</code> inside an
          Ensemble terminal in that session&apos;s checkout; status then comes from the same
          listing, not from hooks, so needs-input detection is weaker than for sessions Ensemble
          started.
        </p>
        {report && !report.ok && (
          <p className="rounded bg-amber-50 p-2 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            {report.error}
          </p>
        )}
        {error && <p className="text-red-600">{error}</p>}
        {!report && !error && <p className="text-neutral-500">Asking claude…</p>}
        {report && background.length === 0 && (
          <p className="text-neutral-500">No background sessions.</p>
        )}
        {background.length > 0 && (
          <ul className="divide-y divide-neutral-200 rounded border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {background.map((a) => (
              <li
                key={a.id ?? a.sessionId ?? a.cwd}
                className="flex items-center gap-3 px-2 py-1.5"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    <span className="font-mono text-xs">{a.id}</span>
                    {a.name && <span className="ml-2 font-medium">{a.name}</span>}
                    <span className="ml-2 rounded bg-neutral-200 px-1 text-[10px] uppercase dark:bg-neutral-700">
                      {a.state ?? "?"}
                      {a.status ? ` · ${a.status}` : ""}
                      {a.waitingFor ? ` · ${a.waitingFor}` : ""}
                    </span>
                  </span>
                  <span className="block truncate font-mono text-xs text-neutral-500" title={a.cwd}>
                    {a.cwd}
                  </span>
                </span>
                {a.ensembleSessionId ? (
                  <button
                    className="btn-ghost text-xs"
                    onClick={() => {
                      navigateToWorkspace(a.workspaceId);
                      onClose();
                    }}
                  >
                    Attached · open
                  </button>
                ) : (
                  <button
                    className="btn-primary text-xs"
                    disabled={busy !== null || !a.id}
                    onClick={() => attach(a)}
                  >
                    Attach
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {interactive.length > 0 && (
          <p className="text-xs text-neutral-500">
            {interactive.length} interactive session{interactive.length === 1 ? "" : "s"} running in
            other terminals (not adoptable; start them with <code>ensemble claude</code> instead):{" "}
            {interactive.map((a) => a.cwd.split("/").pop()).join(", ")}
          </p>
        )}
        <div className="flex justify-end">
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Dialog>
  );
}
