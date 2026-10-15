import { useEffect, useState } from "react";
import { PRODUCT_NAME } from "../../shared/brand.js";
import { AddRepoDialog } from "./components/AddRepoDialog.js";
import { ArchiveDialog } from "./components/ArchiveDialog.js";
import { NewWorkspaceDialog } from "./components/NewWorkspaceDialog.js";
import { Sidebar } from "./components/Sidebar.js";
import { WorkspaceView } from "./components/WorkspaceView.js";
import { useRoute } from "./route.js";
import { connect, loadSnapshot, useUiState } from "./store.js";

type DialogState =
  | { kind: "none" }
  | { kind: "add-repo" }
  | { kind: "new-workspace"; repoId: string | null }
  | { kind: "archive"; workspaceId: string };

export function App() {
  const ui = useUiState();
  const route = useRoute();
  const [dialog, setDialog] = useState<DialogState>({ kind: "none" });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    loadSnapshot().catch((e: Error) => setLoadError(e.message));
    connect();
  }, []);

  const workspaces = ui.snapshot?.workspaces ?? [];
  const repos = ui.snapshot?.repos ?? [];
  const selected = workspaces.find((w) => w.id === route.workspaceId) ?? null;
  const selectedRepo = selected ? (repos.find((r) => r.id === selected.repoId) ?? null) : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n" && repos.length > 0) {
        e.preventDefault();
        setDialog({ kind: "new-workspace", repoId: selected?.repoId ?? null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [repos.length, selected?.repoId]);

  if (ui.authLost) {
    return (
      <main className="mx-auto max-w-md p-8 text-sm">
        <h1 className="text-lg font-semibold">{PRODUCT_NAME}</h1>
        <p className="mt-2">
          Your login is no longer valid. Open the login URL printed by the server (or run{" "}
          <code>ensemble token</code>).
        </p>
      </main>
    );
  }

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside
        className={`fixed inset-y-0 left-0 z-30 w-72 transform border-r border-neutral-200 bg-white transition-transform md:static md:translate-x-0 dark:border-neutral-800 dark:bg-neutral-950 ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
          <span
            className={`h-2 w-2 rounded-full ${ui.connected ? "bg-emerald-500" : "bg-neutral-400"}`}
            title={ui.connected ? "connected" : "reconnecting"}
          />
          <span className="font-semibold">{PRODUCT_NAME}</span>
          <button
            className="btn-ghost ml-auto md:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close sidebar"
          >
            ✕
          </button>
        </div>
        <div className="h-[calc(100%-2.75rem)]">
          <Sidebar
            repos={repos}
            workspaces={workspaces}
            selectedId={selected?.id ?? null}
            onAddRepo={() => setDialog({ kind: "add-repo" })}
            onNewWorkspace={(repoId) => setDialog({ kind: "new-workspace", repoId })}
            onNavigate={() => setSidebarOpen(false)}
          />
        </div>
      </aside>
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/30 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-neutral-200 px-2 py-1 md:hidden dark:border-neutral-800">
          <button
            className="btn-ghost"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open sidebar"
          >
            ☰
          </button>
          <span className="truncate text-sm font-medium">{selected?.name ?? PRODUCT_NAME}</span>
        </div>
        {loadError && <p className="p-4 text-sm text-red-600">{loadError}</p>}
        {selected && selectedRepo ? (
          <WorkspaceView
            key={selected.id}
            workspace={selected}
            repo={selectedRepo}
            onArchive={() => setDialog({ kind: "archive", workspaceId: selected.id })}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-neutral-500">
            {repos.length === 0
              ? "Add a repo from the sidebar to begin."
              : "Select a workspace, or press ⌘N to create one."}
          </div>
        )}
      </main>

      {dialog.kind === "add-repo" && <AddRepoDialog onClose={() => setDialog({ kind: "none" })} />}
      {dialog.kind === "new-workspace" && (
        <NewWorkspaceDialog
          repos={repos}
          initialRepoId={dialog.repoId}
          onClose={() => setDialog({ kind: "none" })}
        />
      )}
      {dialog.kind === "archive" && selected && selected.id === dialog.workspaceId && (
        <ArchiveDialog workspace={selected} onClose={() => setDialog({ kind: "none" })} />
      )}
    </div>
  );
}
