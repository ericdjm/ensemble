import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Diff,
  Hunk,
  parseDiff,
  type ChangeData,
  type FileData,
  type ViewType,
} from "react-diff-view";
import "react-diff-view/style/index.css";
import type { DiffFile, Session, Workspace, WorkspaceDiff } from "../../../shared/types.js";
import { api } from "../api.js";
import { subscribeDiff, useUiState } from "../store.js";

type Selection = { path: string; from: number; to: number };

function lineOf(change: ChangeData): number {
  if (change.type === "insert") return change.lineNumber;
  if (change.type === "delete") return change.lineNumber;
  return change.newLineNumber;
}

function CommentBox({
  selection,
  sessions,
  onClose,
}: {
  selection: Selection;
  sessions: Session[];
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [sessionId, setSessionId] = useState(sessions[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/api/sessions/${sessionId}/comment`, {
        path: selection.path,
        from: selection.from,
        to: selection.to,
        text,
      });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-md border border-neutral-300 bg-neutral-50 p-2 text-sm dark:border-neutral-700 dark:bg-neutral-900">
      <div className="mb-1 font-mono text-xs text-neutral-500">
        {selection.path}{" "}
        {selection.from === selection.to
          ? `line ${selection.from}`
          : `lines ${selection.from}–${selection.to}`}
      </div>
      <textarea
        className="input mt-0 min-h-16"
        autoFocus
        placeholder="Comment for the agent…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          className="input mt-0 w-auto"
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
        >
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.agent} · {s.tmuxName}
            </option>
          ))}
        </select>
        {sessions.length === 0 && (
          <span className="text-xs text-amber-600">No running session to send to.</span>
        )}
        {error && <span className="text-xs text-red-600">{error}</span>}
        <span className="ml-auto flex gap-2">
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={busy || !text.trim() || !sessionId}
            onClick={send}
          >
            Send to agent
          </button>
        </span>
      </div>
    </div>
  );
}

export function DiffTab({ workspace }: { workspace: Workspace }) {
  const ui = useUiState();
  const [data, setData] = useState<WorkspaceDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [viewType, setViewType] = useState<ViewType>(() => {
    try {
      return (localStorage.getItem("ensemble.diffView") as ViewType) || "unified";
    } catch {
      return "unified";
    }
  });
  const [selection, setSelection] = useState<Selection | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<WorkspaceDiff>("GET", `/api/workspaces/${workspace.id}/diff`);
      setData(d);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [workspace.id]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => subscribeDiff(workspace.id, () => void load()), [workspace.id, load]);

  const files = data?.files ?? [];
  const current: DiffFile | null = files.find((f) => f.path === selectedPath) ?? files[0] ?? null;
  const parsed: FileData | null = useMemo(() => {
    if (!current || !current.diff || current.status === "binary") return null;
    try {
      return parseDiff(current.diff)[0] ?? null;
    } catch {
      return null;
    }
  }, [current]);

  const runningSessions = (ui.snapshot?.sessions ?? []).filter(
    (s) => s.workspaceId === workspace.id && s.processState === "running",
  );

  const onGutterClick = (change: ChangeData | null) => {
    if (!change || !current) return;
    const line = lineOf(change);
    // First click picks a line; a second click on a different line extends it to a range; any further click starts over.
    if (
      anchor !== null &&
      selection &&
      selection.from === selection.to &&
      selection.path === current.path &&
      line !== anchor
    ) {
      setSelection({
        path: current.path,
        from: Math.min(anchor, line),
        to: Math.max(anchor, line),
      });
      setAnchor(null);
    } else {
      setAnchor(line);
      setSelection({ path: current.path, from: line, to: line });
    }
  };

  const toggleView = (v: ViewType) => {
    setViewType(v);
    try {
      localStorage.setItem("ensemble.diffView", v);
    } catch {
      /* ignore */
    }
  };

  const totals = files.reduce(
    (acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }),
    { add: 0, del: 0 },
  );

  return (
    <div className="flex h-full min-h-0 gap-3 text-sm">
      <aside className="w-64 shrink-0 overflow-auto rounded border border-neutral-200 dark:border-neutral-800">
        <div className="flex items-center justify-between border-b border-neutral-200 px-2 py-1 text-xs text-neutral-500 dark:border-neutral-800">
          <span>
            {files.length} file{files.length === 1 ? "" : "s"} vs{" "}
            {data?.baseBranch ?? workspace.baseBranch}
          </span>
          <span>
            <span className="text-emerald-600">+{totals.add}</span>{" "}
            <span className="text-red-600">−{totals.del}</span>
          </span>
        </div>
        {error && <p className="p-2 text-xs text-red-600">{error}</p>}
        {!data && !error && <p className="p-2 text-xs text-neutral-500">Loading…</p>}
        {data && files.length === 0 && (
          <p className="p-2 text-xs text-neutral-500">No changes against {data.baseBranch}.</p>
        )}
        <ul>
          {files.map((f) => (
            <li key={f.path}>
              <button
                className={`flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800 ${current?.path === f.path ? "bg-neutral-100 dark:bg-neutral-800" : ""}`}
                onClick={() => {
                  setSelectedPath(f.path);
                  setSelection(null);
                  setAnchor(null);
                }}
                title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
              >
                <span
                  className={`w-3 shrink-0 font-mono ${f.status === "untracked" || f.status === "added" ? "text-emerald-600" : f.status === "deleted" ? "text-red-600" : "text-neutral-500"}`}
                >
                  {f.status === "untracked"
                    ? "?"
                    : f.status === "added"
                      ? "A"
                      : f.status === "deleted"
                        ? "D"
                        : f.status === "renamed"
                          ? "R"
                          : f.status === "binary"
                            ? "B"
                            : "M"}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono">{f.path}</span>
                <span className="shrink-0 text-[10px]">
                  <span className="text-emerald-600">+{f.additions}</span>{" "}
                  <span className="text-red-600">−{f.deletions}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-mono text-xs">{current?.path ?? ""}</span>
          <span className="ml-auto flex gap-1 text-xs">
            {(["unified", "split"] as const).map((v) => (
              <button
                key={v}
                className={`btn-ghost ${viewType === v ? "font-semibold underline" : ""}`}
                onClick={() => toggleView(v)}
              >
                {v}
              </button>
            ))}
            <button className="btn-ghost" onClick={() => void load()} title="Refresh">
              ↻
            </button>
          </span>
        </div>
        <p className="text-xs text-neutral-500">
          Click a line number to select it, shift-click to extend, then comment to send it to an
          agent.
        </p>
        {selection && (
          <CommentBox
            selection={selection}
            sessions={runningSessions}
            onClose={() => setSelection(null)}
          />
        )}
        <div className="min-h-0 flex-1 overflow-auto rounded border border-neutral-200 text-xs dark:border-neutral-800">
          {current && current.status === "binary" && (
            <p className="p-3 text-neutral-500">Binary file.</p>
          )}
          {current && !parsed && current.status !== "binary" && (
            <p className="p-3 text-neutral-500">Nothing to show.</p>
          )}
          {parsed && (
            <Diff
              viewType={viewType}
              diffType={parsed.type}
              hunks={parsed.hunks}
              gutterEvents={{ onClick: (args) => onGutterClick(args.change) }}
            >
              {(hunks) => hunks.map((h) => <Hunk key={h.content} hunk={h} />)}
            </Diff>
          )}
        </div>
      </div>
    </div>
  );
}
