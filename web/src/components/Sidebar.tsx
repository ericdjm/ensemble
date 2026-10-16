import { useState } from "react";
import type { Repo, Session, Workspace } from "../../../shared/types.js";
import { navigateToWorkspace } from "../route.js";
import { effectiveStatus } from "./SessionBadges.js";
import { StatusBadge } from "./StatusBadge.js";

export interface SidebarProps {
  repos: Repo[];
  workspaces: Workspace[];
  sessions: Session[];
  selectedId: string | null;
  onAddRepo: () => void;
  onNewWorkspace: (repoId: string) => void;
  onClaudeAgents: () => void;
  onNavigate: () => void;
}

function SessionDots({ sessions }: { sessions: Session[] }) {
  const live = sessions.filter((s) => s.processState === "running");
  if (live.length === 0) return null;
  const statuses = live.map(effectiveStatus);
  const cls = statuses.includes("needs_input")
    ? "bg-amber-500"
    : statuses.includes("working")
      ? "bg-blue-500 animate-pulse"
      : statuses.includes("error")
        ? "bg-red-500"
        : "bg-emerald-500";
  const title = statuses.includes("needs_input")
    ? "needs input"
    : statuses.includes("working")
      ? "working"
      : "idle";
  return (
    <span
      className="flex items-center gap-1"
      title={`${live.length} session${live.length === 1 ? "" : "s"}: ${title}`}
    >
      <span className={`inline-block h-2 w-2 rounded-full ${cls}`} />
      {live.length > 1 && <span className="text-[10px] text-neutral-500">{live.length}</span>}
    </span>
  );
}

export function Sidebar({
  repos,
  workspaces,
  sessions,
  selectedId,
  onAddRepo,
  onNewWorkspace,
  onClaudeAgents,
  onNavigate,
}: SidebarProps) {
  const [showArchived, setShowArchived] = useState(false);
  return (
    <nav className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Repos
        </span>
        <button className="btn-ghost text-sm" onClick={onAddRepo}>
          + Add repo
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-2">
        {repos.length === 0 && (
          <p className="px-2 py-4 text-sm text-neutral-500">Add a local git repo to get started.</p>
        )}
        {repos.map((repo) => {
          const list = workspaces.filter(
            (w) => w.repoId === repo.id && (showArchived || w.status !== "archived"),
          );
          return (
            <div key={repo.id} className="mb-3">
              <div className="flex items-center justify-between px-2 py-1">
                <span className="truncate text-sm font-medium" title={repo.path}>
                  {repo.name}
                </span>
                <button
                  className="btn-ghost text-xs"
                  title="New workspace (⌘N)"
                  onClick={() => onNewWorkspace(repo.id)}
                >
                  + ws
                </button>
              </div>
              <ul>
                {list.map((ws) => (
                  <li key={ws.id}>
                    <button
                      className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800 ${selectedId === ws.id ? "bg-neutral-100 dark:bg-neutral-800" : ""}`}
                      onClick={() => {
                        navigateToWorkspace(ws.id);
                        onNavigate();
                      }}
                    >
                      <span className="min-w-0">
                        <span className="block truncate">
                          {ws.name}
                          {ws.kind === "inplace" && (
                            <span
                              className="ml-1.5 rounded bg-neutral-200 px-1 text-[10px] font-medium uppercase tracking-wide text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200"
                              title="Your own checkout, launched with `ensemble claude` or `ensemble codex`; not an isolated worktree"
                            >
                              checkout
                            </span>
                          )}
                        </span>
                        <span className="block truncate text-xs text-neutral-500">
                          {ws.pr ? (
                            <>
                              <span
                                className={
                                  ws.pr.state === "MERGED"
                                    ? "text-purple-500"
                                    : ws.pr.state === "OPEN"
                                      ? "text-emerald-600"
                                      : ""
                                }
                              >
                                PR #{ws.pr.number}
                              </span>{" "}
                              {ws.pr.title || ws.branch}
                            </>
                          ) : (
                            ws.branch
                          )}
                        </span>
                      </span>
                      <span className="flex items-center gap-2">
                        <SessionDots sessions={sessions.filter((s) => s.workspaceId === ws.id)} />
                        <StatusBadge status={ws.status} />
                      </span>
                    </button>
                  </li>
                ))}
                {list.length === 0 && (
                  <li className="px-2 py-1 text-xs text-neutral-500">No workspaces</li>
                )}
              </ul>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-neutral-500">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show archived
        </label>
        <button
          className="btn-ghost ml-auto text-xs"
          onClick={onClaudeAgents}
          title="List and attach Claude background sessions (claude --bg)"
        >
          Claude agents…
        </button>
      </div>
    </nav>
  );
}
