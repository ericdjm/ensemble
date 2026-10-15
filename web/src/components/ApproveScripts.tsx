import { useEffect, useState } from "react";
import type { EffectiveRepoConfig, Repo } from "../../../shared/types.js";
import { api } from "../api.js";

export function ApproveScripts({ repo, onApproved }: { repo: Repo; onApproved: () => void }) {
  const [cfg, setCfg] = useState<EffectiveRepoConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<EffectiveRepoConfig>("GET", `/api/repos/${repo.id}/config`)
      .then(setCfg)
      .catch((e: Error) => setError(e.message));
  }, [repo.id]);

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!cfg) return <p className="text-sm text-neutral-500">Loading repo config…</p>;

  const pending = cfg.scripts.filter((s) => !s.approved && s.script !== null);

  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/api/repos/${repo.id}/approve-scripts`, {
        approvals: pending.map((s) => ({ kind: s.kind, hash: s.hash })),
      });
      onApproved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm">
        <strong>{repo.name}</strong> defines scripts in <code>.ensemble.json</code>
        {Object.keys(cfg.overrides).length > 0 && " (with your overrides)"}. They run with your
        shell and your permissions. Review them before approving.
      </p>
      {cfg.file.error && (
        <p className="text-sm text-red-600">.ensemble.json is invalid: {cfg.file.error}</p>
      )}
      {cfg.scripts
        .filter((s) => s.script !== null)
        .map((s) => (
          <div key={s.kind}>
            <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase text-neutral-500">
              {s.kind}
              {s.approved ? (
                <span className="text-emerald-600">approved</span>
              ) : (
                <span className="text-amber-600">new or changed</span>
              )}
            </div>
            <pre className="overflow-x-auto rounded bg-neutral-100 p-2 font-mono text-xs dark:bg-neutral-800">
              {s.script}
            </pre>
          </div>
        ))}
      {cfg.config.copy.length > 0 && (
        <p className="text-xs text-neutral-500">
          Copy patterns (validated and contained regardless of approval):{" "}
          {cfg.config.copy.join(", ")}
        </p>
      )}
      {pending.length > 0 ? (
        <button className="btn-primary" disabled={busy} onClick={approve}>
          Approve {pending.length === 1 ? "script" : `${pending.length} scripts`} and continue
        </button>
      ) : (
        <p className="text-sm text-emerald-600">All scripts approved.</p>
      )}
    </div>
  );
}
