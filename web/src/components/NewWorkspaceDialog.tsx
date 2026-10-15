import { useEffect, useState } from "react";
import type { Agent, EffectiveRepoConfig, Repo, Workspace } from "../../../shared/types.js";
import { api } from "../api.js";
import { navigateToWorkspace } from "../route.js";
import { Dialog } from "./Dialog.js";

export function NewWorkspaceDialog({
  repos,
  initialRepoId,
  onClose,
}: {
  repos: Repo[];
  initialRepoId: string | null;
  onClose: () => void;
}) {
  const [repoId, setRepoId] = useState(initialRepoId ?? repos[0]?.id ?? "");
  const repo = repos.find((r) => r.id === repoId);
  const [name, setName] = useState("");
  const [baseBranch, setBaseBranch] = useState(repo?.defaultBase ?? "main");
  const [agent, setAgent] = useState<Agent>("claude");
  const [prompt, setPrompt] = useState("");
  const [remoteControl, setRemoteControl] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!repo) return;
    setBaseBranch(repo.defaultBase);
    api<EffectiveRepoConfig>("GET", `/api/repos/${repo.id}/config`)
      .then((c) => {
        if (c.config.defaultAgent) setAgent(c.config.defaultAgent);
      })
      .catch(() => undefined);
  }, [repo]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!repo) return;
    setBusy(true);
    setError(null);
    try {
      const ws = await api<Workspace>("POST", "/api/workspaces", {
        repoId: repo.id,
        baseBranch,
        ...(name.trim() ? { name: name.trim() } : {}),
        agent,
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        remoteControl: agent === "claude" ? remoteControl : false,
      });
      navigateToWorkspace(ws.id);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="New workspace" onClose={onClose}>
      <form className="space-y-3" onSubmit={submit}>
        <label className="block text-sm">
          Repo
          <select className="input" value={repoId} onChange={(e) => setRepoId(e.target.value)}>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">
            Name <span className="text-neutral-500">(optional)</span>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="auto"
            />
          </label>
          <label className="block text-sm">
            Base branch
            <input
              className="input"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              required
            />
          </label>
        </div>
        <fieldset className="text-sm">
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
        <label className="block text-sm">
          Initial prompt <span className="text-neutral-500">(optional)</span>
          <textarea
            className="input min-h-24"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <label
          className={`flex items-center gap-2 text-sm ${agent !== "claude" ? "opacity-50" : ""}`}
        >
          <input
            type="checkbox"
            disabled={agent !== "claude"}
            checked={agent === "claude" && remoteControl}
            onChange={(e) => setRemoteControl(e.target.checked)}
          />
          Remote Control (Claude only; transcript is synced to Anthropic while connected)
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy || !repo}>
            Create
          </button>
        </div>
      </form>
    </Dialog>
  );
}
