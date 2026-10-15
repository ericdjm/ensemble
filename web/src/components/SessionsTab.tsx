import { useEffect, useMemo, useState } from "react";
import type { Agent, Session, Workspace } from "../../../shared/types.js";
import { api } from "../api.js";
import { useUiState } from "../store.js";
import { Dialog } from "./Dialog.js";
import { AuthBadge, SessionStatusBadge, effectiveStatus } from "./SessionBadges.js";
import { Terminal } from "./Terminal.js";

function NewSessionDialog({
  workspace,
  hasRunning,
  onClose,
  defaultAgent,
}: {
  workspace: Workspace;
  hasRunning: boolean;
  onClose: () => void;
  defaultAgent: Agent;
}) {
  const [agent, setAgent] = useState<Agent>(defaultAgent);
  const [prompt, setPrompt] = useState("");
  const [remoteControl, setRemoteControl] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/api/sessions", {
        workspaceId: workspace.id,
        agent,
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        remoteControl: agent === "claude" && remoteControl,
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="New session" onClose={onClose}>
      <form className="space-y-3 text-sm" onSubmit={submit}>
        {hasRunning && (
          <p className="rounded bg-amber-50 p-2 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            Another session is already running in this workspace. Sessions share the branch and
            files; concurrent edits can conflict.
          </p>
        )}
        <fieldset>
          <legend className="mb-1">Agent</legend>
          <div className="flex gap-4">
            {(["claude", "codex"] as const).map((a) => (
              <label key={a} className="flex items-center gap-1">
                <input
                  type="radio"
                  name="agent"
                  checked={agent === a}
                  onChange={() => setAgent(a)}
                />
                {a === "claude" ? "Claude Code" : "Codex"}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="block">
          Initial prompt <span className="text-neutral-500">(optional)</span>
          <textarea
            className="input min-h-24"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <label className={`flex items-center gap-2 ${agent !== "claude" ? "opacity-50" : ""}`}>
          <input
            type="checkbox"
            disabled={agent !== "claude"}
            checked={agent === "claude" && remoteControl}
            onChange={(e) => setRemoteControl(e.target.checked)}
          />
          Remote Control (Claude only; the transcript is synced to Anthropic while connected)
        </label>
        {error && <p className="text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            Start
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ResumeDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const [id, setId] = useState(session.cliSessionId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const call = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/api/sessions/${session.id}/resume`, body);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Resume conversation" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p>
          Resuming starts a new {session.agent} process in this workspace that continues one exact
          conversation. Ensemble never picks the most recent conversation for you, because several
          may share this workspace.
        </p>
        <label className="block">
          Conversation id
          <input
            className="input font-mono"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="paste the id"
          />
        </label>
        {!session.cliSessionId && (
          <p className="text-amber-700 dark:text-amber-300">No id was captured for this session.</p>
        )}
        {error && <p className="text-red-600">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-ghost"
            disabled={busy}
            onClick={() => call({ picker: true })}
            title="Opens the CLI's own interactive conversation picker"
          >
            Open CLI picker
          </button>
          <button
            className="btn-primary"
            disabled={busy || !id.trim()}
            onClick={() => call({ cliSessionId: id.trim() })}
          >
            Resume this id
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export function SessionsTab({
  workspace,
  defaultAgent,
}: {
  workspace: Workspace;
  defaultAgent: Agent;
}) {
  const ui = useUiState();
  const sessions = useMemo(
    () => (ui.snapshot?.sessions ?? []).filter((s) => s.workspaceId === workspace.id),
    [ui.snapshot, workspace.id],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"none" | "new" | "resume">("none");
  const [reply, setReply] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const selected =
    sessions.find((s) => s.id === selectedId) ??
    sessions.filter((s) => s.processState === "running").at(-1) ??
    sessions.at(-1) ??
    null;
  const hasRunning = sessions.some((s) => s.processState === "running");

  const call = async (method: string, url: string, body?: unknown) => {
    setError(null);
    try {
      await api(method, url, body);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const sendReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || !reply) return;
    await call("POST", `/api/sessions/${selected.id}/input`, { text: reply });
    setReply("");
  };

  const waitingHint =
    selected &&
    selected.processState === "running" &&
    selected.cliSessionId === null &&
    selected.startedAt !== null &&
    now - Date.parse(selected.startedAt) > 20_000;

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {sessions.map((s) => (
          <button
            key={s.id}
            className={`flex items-center gap-2 rounded-md border px-2 py-1 text-xs ${selected?.id === s.id ? "border-neutral-900 dark:border-neutral-100" : "border-neutral-200 dark:border-neutral-800"}`}
            onClick={() => setSelectedId(s.id)}
          >
            <span className="font-medium">{s.agent}</span>
            <SessionStatusBadge session={s} />
          </button>
        ))}
        <button
          className="btn-primary ml-auto text-xs"
          disabled={workspace.status !== "ready"}
          onClick={() => setDialog("new")}
        >
          + New session
        </button>
      </div>

      {!selected && (
        <p className="p-4 text-sm text-neutral-500">
          No sessions yet. Start one to open a terminal here.
        </p>
      )}

      {selected && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <AuthBadge session={selected} />
            {selected.remoteControl && selected.processState === "running" && (
              <span
                className="rounded-full bg-purple-100 px-2 py-0.5 text-purple-900 dark:bg-purple-900/40 dark:text-purple-200"
                title="Transcript synced to Anthropic while connected"
              >
                Remote Control
              </span>
            )}
            <span className="font-mono text-neutral-500" title="attach from a terminal">
              tmux -L ensemble attach -t {selected.tmuxName}
            </span>
            <span className="ml-auto flex gap-1">
              {selected.processState === "running" &&
                selected.agent === "claude" &&
                selected.authMode !== "other" &&
                !selected.remoteControl && (
                  <button
                    className="btn-ghost"
                    onClick={() => call("POST", `/api/sessions/${selected.id}/remote-control`)}
                    title="Sends /remote-control; the transcript syncs to Anthropic while connected"
                  >
                    Enable Remote Control
                  </button>
                )}
              {selected.processState === "running" && (
                <button
                  className="btn-ghost text-red-600"
                  onClick={() => call("POST", `/api/sessions/${selected.id}/kill`)}
                >
                  Kill
                </button>
              )}
              {selected.processState !== "running" &&
                !selected.successorId &&
                selected.exitCode !== 78 && (
                  <button className="btn-ghost" onClick={() => setDialog("resume")}>
                    Resume…
                  </button>
                )}
            </span>
          </div>
          {selected.refusalReason && (
            <div className="rounded bg-red-50 p-2 text-sm text-red-900 dark:bg-red-950/40 dark:text-red-200">
              Launch refused: {selected.authLabel ? `${selected.authLabel}. ` : ""}
              {selected.refusalReason}
              {selected.billingOptIn && !selected.billingAck && (
                <button
                  className="btn-ghost ml-2"
                  onClick={() =>
                    call("POST", "/api/sessions", {
                      workspaceId: workspace.id,
                      agent: selected.agent,
                      billingAck: true,
                      remoteControl: false,
                    })
                  }
                >
                  Relaunch with acknowledgement
                </button>
              )}
            </div>
          )}
          {selected.billingAck &&
            selected.authMode !== "subscription" &&
            selected.processState === "running" && (
              <p className="rounded bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                This session was started with an explicit acknowledgement. Its authentication mode
                is {selected.authLabel ?? selected.authMode}; it is not subscription-verified and
                may be billed through an API key.
              </p>
            )}
          {waitingHint && (
            <p className="rounded bg-neutral-100 p-2 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
              No session events received yet. Check the terminal for trust or login prompts.
            </p>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="min-h-0 flex-1">
            <Terminal key={selected.id} target={`session:${selected.id}`} focus />
          </div>
          <form className="flex gap-2" onSubmit={sendReply}>
            <input
              className="input mt-0 flex-1"
              placeholder={
                selected.processState === "running"
                  ? "Quick reply… (sent with Enter)"
                  : "Session is not running"
              }
              disabled={selected.processState !== "running"}
              value={reply}
              onChange={(e) => setReply(e.target.value)}
            />
            <button
              className="btn-primary"
              disabled={selected.processState !== "running" || !reply}
            >
              Send
            </button>
          </form>
        </>
      )}

      {dialog === "new" && (
        <NewSessionDialog
          workspace={workspace}
          hasRunning={hasRunning}
          defaultAgent={defaultAgent}
          onClose={() => setDialog("none")}
        />
      )}
      {dialog === "resume" && selected && (
        <ResumeDialog session={selected} onClose={() => setDialog("none")} />
      )}
    </div>
  );
}

export { effectiveStatus };
