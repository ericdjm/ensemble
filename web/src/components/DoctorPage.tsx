import { useEffect, useState } from "react";
import type { DoctorReport } from "../../../shared/types.js";
import { api } from "../api.js";

export function DoctorPage() {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setError(null);
    api<DoctorReport>("GET", "/api/doctor")
      .then(setReport)
      .catch((e: Error) => setError(e.message));
  };
  useEffect(load, []);

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 text-sm">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Doctor</h1>
        <button className="btn-ghost" onClick={load}>
          Refresh
        </button>
      </div>
      {error && <p className="text-red-600">{error}</p>}
      {!report && !error && <p className="text-neutral-500">Checking…</p>}
      {report && (
        <>
          <table className="w-full text-left">
            <thead>
              <tr className="text-xs uppercase text-neutral-500">
                <th className="py-1">Tool</th>
                <th>Version</th>
                <th>Path</th>
              </tr>
            </thead>
            <tbody>
              {report.tools.map((t) => (
                <tr key={t.name} className="border-t border-neutral-200 dark:border-neutral-800">
                  <td className="py-1 font-medium">{t.name}</td>
                  <td>{t.version ?? <span className="text-red-600">{t.error}</span>}</td>
                  <td className="font-mono text-xs text-neutral-500">
                    {t.path}
                    {t.resolvedFrom === "override" && " (settings override)"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <section>
            <h2 className="font-semibold">GitHub CLI</h2>
            <p>{report.gh.summary ?? "gh not available"}</p>
          </section>
          <section>
            <h2 className="font-semibold">Hook listener</h2>
            <p>
              127.0.0.1:{report.hookListener.port} —{" "}
              {report.hookListener.ok ? (
                "listening"
              ) : (
                <span className="text-red-600">{report.hookListener.error}</span>
              )}
            </p>
            <p className="text-neutral-500">tmux socket: {report.tmuxSocket}</p>
          </section>
          <section>
            <h2 className="font-semibold">Authentication modes (last launcher report)</h2>
            <ul>
              {report.authModes.map((a) => (
                <li key={a.agent}>
                  <span className="font-medium">{a.agent}</span>: {a.mode}
                  {a.label ? ` — ${a.label}` : ""}
                  {a.checkedAt ? (
                    <span className="text-neutral-500">
                      {" "}
                      ({new Date(a.checkedAt).toLocaleString()})
                    </span>
                  ) : (
                    ""
                  )}
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2 className="font-semibold">Notes</h2>
            <ul className="list-disc pl-5 text-neutral-600 dark:text-neutral-400">
              {report.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
