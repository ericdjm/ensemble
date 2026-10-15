import { useEffect, useRef } from "react";
import { api } from "../api.js";
import { setSetupLog, useUiState } from "../store.js";

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\r/g;

export function SetupLog({ workspaceId }: { workspaceId: string }) {
  const { setupLogs } = useUiState();
  const text = setupLogs[workspaceId] ?? "";
  const pre = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ log: string }>("GET", `/api/workspaces/${workspaceId}/setup-log`)
      .then((r) => {
        if (!cancelled) setSetupLog(workspaceId, r.log);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    const el = pre.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <pre
      ref={pre}
      className="h-full min-h-[40vh] overflow-auto rounded-md bg-neutral-950 p-3 font-mono text-xs leading-5 text-neutral-100"
    >
      {text ? text.replace(ANSI, "") : "No setup output yet."}
    </pre>
  );
}
