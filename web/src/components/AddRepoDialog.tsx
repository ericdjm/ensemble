import { useState } from "react";
import type { Repo } from "../../../shared/types.js";
import { api } from "../api.js";
import { loadSnapshot } from "../store.js";
import { Dialog } from "./Dialog.js";

export function AddRepoDialog({ onClose }: { onClose: () => void }) {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api<Repo>("POST", "/api/repos", { path: path.trim() });
      await loadSnapshot();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Add repo" onClose={onClose}>
      <form className="space-y-3" onSubmit={submit}>
        <label className="block text-sm">
          Absolute path to a local git repository
          <input
            className="input font-mono"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/Users/you/code/project"
            required
          />
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            Add
          </button>
        </div>
      </form>
    </Dialog>
  );
}
