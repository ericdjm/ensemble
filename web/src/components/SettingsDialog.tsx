import { useEffect, useState } from "react";
import type { SettingsView } from "../../../shared/types.js";
import { api } from "../api.js";
import { loadSettings } from "../store.js";
import { Dialog } from "./Dialog.js";

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<SettingsView>("GET", "/api/settings")
      .then(setS)
      .catch((e: Error) => setError(e.message));
  }, []);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!s) return;
    setBusy(true);
    setError(null);
    try {
      const cliPaths: SettingsView["cliPaths"] = {};
      if (s.cliPaths.claude) cliPaths.claude = s.cliPaths.claude;
      if (s.cliPaths.codex) cliPaths.codex = s.cliPaths.codex;
      await api("PUT", "/api/settings", { ...s, cliPaths });
      await loadSettings();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!s) {
    return (
      <Dialog title="Settings" onClose={onClose}>
        <p className="text-sm text-neutral-500">{error ?? "Loading…"}</p>
      </Dialog>
    );
  }
  return (
    <Dialog title="Settings" onClose={onClose}>
      <form className="space-y-3 text-sm" onSubmit={save}>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={s.billingOptIn}
            onChange={(e) => setS({ ...s, billingOptIn: e.target.checked })}
            className="mt-1"
          />
          <span>
            <strong>Allow API billing.</strong> By default Ensemble removes API-key variables from
            agent sessions and refuses to launch unless the CLI reports a subscription login. With
            this on, API-key logins are allowed (with a warning badge), the variables are passed
            through, and unverified modes can be launched with a per-session acknowledgement.
            Ensemble never stores keys.
          </span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={s.remoteControlDefault}
            onChange={(e) => setS({ ...s, remoteControlDefault: e.target.checked })}
          />
          Enable Remote Control by default for new Claude sessions
        </label>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={s.relayEnabled}
            onChange={(e) => setS({ ...s, relayEnabled: e.target.checked })}
            className="mt-1"
          />
          <span>
            <strong>Allow bounded relays.</strong> Lets you start an automatic exchange between two
            sessions: each finished answer is sent to the other session for at most N hops, or until
            an answer contains a done marker. Off by default; handoffs stay manual.
          </span>
        </label>
        <label className="block">
          Path to <code>claude</code>{" "}
          <span className="text-neutral-500">(blank = login-shell PATH)</span>
          <input
            className="input font-mono"
            value={s.cliPaths.claude ?? ""}
            onChange={(e) => setS({ ...s, cliPaths: { ...s.cliPaths, claude: e.target.value } })}
          />
        </label>
        <label className="block">
          Path to <code>codex</code>{" "}
          <span className="text-neutral-500">(blank = login-shell PATH)</span>
          <input
            className="input font-mono"
            value={s.cliPaths.codex ?? ""}
            onChange={(e) => setS({ ...s, cliPaths: { ...s.cliPaths, codex: e.target.value } })}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            Workspace root
            <input
              className="input font-mono"
              value={s.workspaceRoot}
              onChange={(e) => setS({ ...s, workspaceRoot: e.target.value })}
            />
          </label>
          <label className="block">
            Branch prefix
            <input
              className="input font-mono"
              value={s.branchPrefix}
              onChange={(e) => setS({ ...s, branchPrefix: e.target.value })}
            />
          </label>
        </div>
        <label className="block">
          Port base
          <input
            className="input"
            type="number"
            value={s.portBase}
            onChange={(e) => setS({ ...s, portBase: Number(e.target.value) })}
          />
        </label>
        {error && <p className="text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}
