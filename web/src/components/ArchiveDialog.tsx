import { useCallback, useEffect, useState } from "react";
import type { ArchiveInventory, ArchiveRecord, Workspace } from "../../../shared/types.js";
import { api, ApiError } from "../api.js";
import { navigateToWorkspace } from "../route.js";
import { Dialog } from "./Dialog.js";

const DEPENDENCY_DIRS = new Set([
  "node_modules",
  ".venv",
  "venv",
  "vendor",
  "target",
  "dist",
  "build",
  ".cache",
  ".next",
  ".turbo",
]);

export function ArchiveDialog({
  workspace,
  onClose,
}: {
  workspace: Workspace;
  onClose: () => void;
}) {
  const [inv, setInv] = useState<ArchiveInventory | null>(null);
  const [decisions, setDecisions] = useState<Record<string, "keep" | "discard">>({});
  const [forceDirty, setForceDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ record: ArchiveRecord | null } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const i = await api<ArchiveInventory>(
      "GET",
      `/api/workspaces/${workspace.id}/archive-preflight`,
    );
    setInv(i);
    const d: Record<string, "keep" | "discard"> = {};
    for (const e of i.ignored) {
      if (e.symlink) continue;
      d[e.path] =
        e.directory && DEPENDENCY_DIRS.has(e.path.split("/").pop() ?? "") ? "discard" : "keep";
    }
    setDecisions(d);
    setForceDirty(false);
  }, [workspace.id]);

  const inplace = workspace.kind === "inplace";
  useEffect(() => {
    if (inplace) return;
    load().catch((e: Error) => setError(e.message));
  }, [load, inplace]);

  const forget = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/api/workspaces/${workspace.id}/archive`, {
        inventoryHash: "",
        forceDirty: false,
        ignored: {},
      });
      finish();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!inv) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ workspace: Workspace; archive: ArchiveRecord | null }>(
        "POST",
        `/api/workspaces/${workspace.id}/archive`,
        {
          inventoryHash: inv.hash,
          forceDirty,
          ignored: decisions,
        },
      );
      setDone({ record: res.archive });
    } catch (e) {
      if (
        e instanceof ApiError &&
        e.status === 409 &&
        e.body &&
        typeof e.body === "object" &&
        "inventory" in e.body
      ) {
        setError(`${e.message} The list below has been refreshed.`);
        await load().catch(() => undefined);
      } else {
        setError((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  const deleteBranch = async () => {
    setBusy(true);
    try {
      await api("DELETE", `/api/workspaces/${workspace.id}/branch`);
      finish();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const finish = () => {
    navigateToWorkspace(null);
    onClose();
  };

  if (inplace) {
    return (
      <Dialog title={`Forget ${workspace.name}`} onClose={onClose}>
        <div className="space-y-3 text-sm">
          <p>
            This is your own checkout at <code className="break-all">{workspace.path}</code>.
            Forgetting it stops any running sessions and removes the workspace from Ensemble.
          </p>
          <p className="font-medium">No files are touched and the branch is not changed.</p>
          <p className="text-neutral-500">
            Run <code>ensemble claude</code> or <code>ensemble codex</code> in that directory again
            to bring it back.
          </p>
          {error && <p className="text-red-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <button className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn-danger" disabled={busy} onClick={forget}>
              Forget workspace
            </button>
          </div>
        </div>
      </Dialog>
    );
  }

  if (done) {
    return (
      <Dialog title="Workspace archived" onClose={finish}>
        <div className="space-y-3 text-sm">
          {done.record ? (
            <p>
              {done.record.manifest.length} file{done.record.manifest.length === 1 ? "" : "s"}{" "}
              preserved under <code className="break-all">{done.record.recoveryDir}</code>. Restore
              them later from the archive list.
            </p>
          ) : (
            <p>Nothing was preserved.</p>
          )}
          <p>
            The branch <code>{workspace.branch}</code> was kept.
          </p>
          {error && <p className="text-red-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <button className="btn-ghost" onClick={finish}>
              Keep branch
            </button>
            <button className="btn-danger" disabled={busy} onClick={deleteBranch}>
              Delete branch
            </button>
          </div>
        </div>
      </Dialog>
    );
  }

  const dirty = inv ? inv.tracked.length + inv.untracked.length > 0 : false;
  const files = inv ? inv.ignored.filter((e) => !e.symlink) : [];
  const allDecided = files.every((e) => decisions[e.path] !== undefined);
  const setAllDirs = (v: "keep" | "discard") =>
    setDecisions((d) => {
      const next = { ...d };
      for (const e of files) if (e.directory) next[e.path] = v;
      return next;
    });

  return (
    <Dialog title={`Archive ${workspace.name}`} onClose={onClose} wide>
      {!inv && !error && <p className="text-sm text-neutral-500">Inspecting the worktree…</p>}
      {inv && (
        <div className="space-y-4 text-sm">
          <p>
            This removes the worktree at <code className="break-all">{workspace.path}</code>.
            Running processes in it will be stopped first. The branch is kept.
          </p>

          <section>
            <h3 className="font-semibold">Tracked changes and untracked files</h3>
            {dirty ? (
              <>
                <ul className="mt-1 max-h-40 overflow-auto rounded bg-neutral-100 p-2 font-mono text-xs dark:bg-neutral-800">
                  {inv.tracked.map((p) => (
                    <li key={`t-${p}`}>M {p}</li>
                  ))}
                  {inv.untracked.map((p) => (
                    <li key={`u-${p}`}>?? {p}</li>
                  ))}
                </ul>
                <label className="mt-2 flex items-center gap-2 text-red-700 dark:text-red-300">
                  <input
                    type="checkbox"
                    checked={forceDirty}
                    onChange={(e) => setForceDirty(e.target.checked)}
                  />
                  Permanently delete these uncommitted changes
                </label>
              </>
            ) : (
              <p className="text-neutral-500">
                None. The worktree is clean as far as git is concerned.
              </p>
            )}
          </section>

          <section>
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Ignored files (not protected by git)</h3>
              {files.some((e) => e.directory) && (
                <span className="flex gap-2 text-xs">
                  <button className="btn-ghost" onClick={() => setAllDirs("discard")}>
                    discard all directories
                  </button>
                  <button className="btn-ghost" onClick={() => setAllDirs("keep")}>
                    keep all
                  </button>
                </span>
              )}
            </div>
            {files.length === 0 ? (
              <p className="text-neutral-500">None.</p>
            ) : (
              <ul className="mt-1 max-h-64 divide-y divide-neutral-200 overflow-auto rounded border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
                {files.map((e) => (
                  <li key={e.path} className="flex items-center justify-between gap-2 px-2 py-1">
                    <span className="min-w-0 truncate font-mono text-xs">
                      {e.path}
                      {e.directory ? "/" : ""}
                      {e.fromCopyManifest && (
                        <span className="ml-2 rounded bg-blue-100 px-1 text-[10px] text-blue-900 dark:bg-blue-900/40 dark:text-blue-200">
                          copied at setup
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 gap-3 text-xs">
                      {(["keep", "discard"] as const).map((v) => (
                        <label key={v} className="flex items-center gap-1">
                          <input
                            type="radio"
                            name={`d-${e.path}`}
                            checked={decisions[e.path] === v}
                            onChange={() => setDecisions((d) => ({ ...d, [e.path]: v }))}
                          />
                          {v}
                        </label>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1 text-xs text-neutral-500">
              Kept files are copied to a private recovery directory under ~/.ensemble/archives
              before anything is removed.
            </p>
          </section>

          {inv.symlinks.length > 0 && (
            <section>
              <h3 className="font-semibold">Symlinks</h3>
              <p className="text-xs text-neutral-500">
                Never copied; the links themselves are removed with the worktree, their targets are
                untouched: {inv.symlinks.join(", ")}
              </p>
            </section>
          )}

          {error && <p className="text-red-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <button className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn-danger"
              disabled={busy || !allDecided || (dirty && !forceDirty)}
              onClick={submit}
            >
              Archive workspace
            </button>
          </div>
        </div>
      )}
      {error && !inv && <p className="text-sm text-red-600">{error}</p>}
    </Dialog>
  );
}
