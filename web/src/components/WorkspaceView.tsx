import { useState } from "react";
import type { Repo, Workspace } from "../../../shared/types.js";
import { api } from "../api.js";
import { ApproveScripts } from "./ApproveScripts.js";
import { SetupLog } from "./SetupLog.js";
import { StatusBadge } from "./StatusBadge.js";
import { SessionsTab } from "./SessionsTab.js";
import { EventsTab } from "./EventsTab.js";
import { DiffTab } from "./DiffTab.js";
import { RunTab } from "./RunTab.js";
import { useUiState } from "../store.js";

type Tab = "sessions" | "run" | "setup" | "diff" | "events" | "pr";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "sessions", label: "Sessions" },
  { id: "run", label: "Run" },
  { id: "setup", label: "Setup log" },
  { id: "diff", label: "Diff" },
  { id: "events", label: "Events" },
  { id: "pr", label: "PR" },
];

export function WorkspaceView({
  workspace,
  repo,
  onArchive,
}: {
  workspace: Workspace;
  repo: Repo;
  onArchive: () => void;
}) {
  const [tab, setTab] = useState<Tab>(workspace.status === "ready" ? "sessions" : "setup");
  const ui = useUiState();
  const latestSession =
    (ui.snapshot?.sessions ?? []).filter((s) => s.workspaceId === workspace.id).at(-1) ?? null;
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(workspace.name);
  const [error, setError] = useState<string | null>(null);

  const call = async (method: string, url: string, body?: unknown) => {
    setError(null);
    try {
      await api(method, url, body);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const rename = async () => {
    setRenaming(false);
    if (name.trim() && name.trim() !== workspace.name)
      await call("PATCH", `/api/workspaces/${workspace.id}`, { name: name.trim() });
  };

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {renaming ? (
            <input
              className="input w-48"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={rename}
              onKeyDown={(e) => {
                if (e.key === "Enter") rename();
                if (e.key === "Escape") setRenaming(false);
              }}
            />
          ) : (
            <h1
              className="cursor-text text-lg font-semibold"
              title="Click to rename"
              onClick={() => setRenaming(true)}
            >
              {workspace.name}
            </h1>
          )}
          <StatusBadge status={workspace.status} />
          <span className="font-mono text-xs text-neutral-500">{workspace.branch}</span>
          <span className="text-xs text-neutral-500">port {workspace.port}</span>
          <span className="ml-auto flex gap-1">
            <button
              className="btn-ghost text-xs"
              onClick={() =>
                call("POST", `/api/workspaces/${workspace.id}/open`, { app: "vscode" })
              }
            >
              Open in VS Code
            </button>
            <button
              className="btn-ghost text-xs"
              onClick={() =>
                call("POST", `/api/workspaces/${workspace.id}/open`, { app: "finder" })
              }
            >
              Reveal in Finder
            </button>
            {workspace.status !== "archived" && (
              <button className="btn-ghost text-xs text-red-600" onClick={onArchive}>
                Archive
              </button>
            )}
          </span>
        </div>
        <p className="mt-1 truncate font-mono text-xs text-neutral-500" title={workspace.path}>
          {workspace.path}
        </p>
        {workspace.error && <p className="mt-1 text-sm text-red-600">{workspace.error}</p>}
        {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
      </header>

      {workspace.status === "pending_approval" && (
        <div className="border-b border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30">
          <ApproveScripts
            repo={repo}
            onApproved={() => call("POST", `/api/workspaces/${workspace.id}/continue`)}
          />
        </div>
      )}
      {workspace.status === "setup_failed" && (
        <div className="border-b border-red-200 bg-red-50 p-4 text-sm dark:border-red-900 dark:bg-red-950/30">
          Setup failed. The worktree was kept.{" "}
          <button
            className="btn-primary ml-2"
            onClick={() => call("POST", `/api/workspaces/${workspace.id}/continue`)}
          >
            Retry
          </button>
        </div>
      )}

      <div className="flex gap-1 overflow-x-auto border-b border-neutral-200 px-2 dark:border-neutral-800">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`px-3 py-2 text-sm ${tab === t.id ? "border-b-2 border-neutral-900 font-medium dark:border-neutral-100" : "text-neutral-500"}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {tab === "setup" && <SetupLog workspaceId={workspace.id} />}
        {tab === "sessions" && (
          <SessionsTab workspace={workspace} defaultAgent={workspace.creation.request.agent} />
        )}
        {tab === "diff" && <DiffTab workspace={workspace} />}
        {tab === "run" && <RunTab workspace={workspace} />}
        {tab === "events" &&
          (latestSession ? (
            <EventsTab session={latestSession} />
          ) : (
            <p className="p-4 text-sm text-neutral-500">No sessions yet.</p>
          ))}
        {tab !== "setup" &&
          tab !== "sessions" &&
          tab !== "events" &&
          tab !== "diff" &&
          tab !== "run" && (
            <p className="p-4 text-sm text-neutral-500">
              {TABS.find((t) => t.id === tab)?.label} arrives in a later milestone.
            </p>
          )}
      </div>
    </div>
  );
}
