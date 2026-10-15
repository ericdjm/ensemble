import { useCallback, useEffect, useState } from "react";
import type { RunState, Workspace } from "../../../shared/types.js";
import { api } from "../api.js";
import { Terminal } from "./Terminal.js";

export function RunTab({ workspace }: { workspace: Workspace }) {
  const [state, setState] = useState<RunState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  const load = useCallback(async () => {
    try {
      setState(await api<RunState>("GET", `/api/workspaces/${workspace.id}/run`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [workspace.id]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [load]);

  const call = async (method: "POST" | "DELETE") => {
    setError(null);
    try {
      setState(await api<RunState>(method, `/api/workspaces/${workspace.id}/run`));
      setGeneration((g) => g + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="flex h-full flex-col gap-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {state?.script ? (
          <code className="truncate rounded bg-neutral-100 px-2 py-1 font-mono text-xs dark:bg-neutral-800">
            {state.script}
          </code>
        ) : (
          <span className="text-neutral-500">
            This repo has no run script. Add one to .ensemble.json.
          </span>
        )}
        <span className="text-xs text-neutral-500">
          ENSEMBLE_PORT={workspace.port} ·{" "}
          <a
            className="underline"
            href={`http://localhost:${workspace.port}`}
            target="_blank"
            rel="noreferrer"
          >
            localhost:{workspace.port}
          </a>
        </span>
        <span className="ml-auto flex gap-1">
          {state?.running ? (
            <button className="btn-ghost text-red-600" onClick={() => call("DELETE")}>
              Stop
            </button>
          ) : (
            <button
              className="btn-primary"
              disabled={!state?.script || !state.approved || workspace.status !== "ready"}
              onClick={() => call("POST")}
            >
              Start
            </button>
          )}
        </span>
      </div>
      {state && state.script && !state.approved && (
        <p className="text-xs text-amber-600">
          The run script is not approved yet; approve it from the Sessions tab prompt or repo
          settings.
        </p>
      )}
      {state && !state.running && state.exitCode !== null && (
        <p className="text-xs text-neutral-500">Last run exited with {state.exitCode}.</p>
      )}
      {error && <p className="text-red-600">{error}</p>}
      <div className="min-h-0 flex-1">
        {state?.running || (state && state.exitCode !== null) ? (
          <Terminal key={`${workspace.id}-${generation}`} target={`run:${workspace.id}`} />
        ) : (
          <p className="p-4 text-xs text-neutral-500">Not running.</p>
        )}
      </div>
    </div>
  );
}
