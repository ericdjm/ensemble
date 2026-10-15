import { useSyncExternalStore } from "react";
import type { ServerMessage, StateSnapshot, Workspace } from "../../shared/types.js";
import { api, setAuthLostHandler } from "./api.js";

export interface UiState {
  snapshot: StateSnapshot | null;
  connected: boolean;
  authLost: boolean;
  setupLogs: Record<string, string>;
}

let state: UiState = { snapshot: null, connected: false, authLost: false, setupLogs: {} };
const listeners = new Set<() => void>();

function setState(patch: Partial<UiState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useUiState(): UiState {
  return useSyncExternalStore(subscribe, () => state);
}

function upsertWorkspace(ws: Workspace): void {
  if (!state.snapshot) return;
  const list = state.snapshot.workspaces.filter((w) => w.id !== ws.id);
  list.push(ws);
  list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  setState({ snapshot: { ...state.snapshot, workspaces: list } });
}

export function applyMessage(msg: ServerMessage): void {
  switch (msg.t) {
    case "snapshot":
      setState({ snapshot: msg.state });
      break;
    case "workspace.changed":
      upsertWorkspace(msg.item);
      break;
    case "repo.changed":
      if (state.snapshot) {
        const repos = state.snapshot.repos.filter((r) => r.id !== msg.item.id).concat(msg.item);
        repos.sort((a, b) => a.name.localeCompare(b.name));
        setState({ snapshot: { ...state.snapshot, repos } });
      }
      break;
    case "script.output":
      if (msg.kind === "setup") {
        setState({
          setupLogs: {
            ...state.setupLogs,
            [msg.workspaceId]: (state.setupLogs[msg.workspaceId] ?? "") + msg.chunk,
          },
        });
      }
      break;
    default:
      break;
  }
}

export function setSetupLog(workspaceId: string, text: string): void {
  setState({ setupLogs: { ...state.setupLogs, [workspaceId]: text } });
}

export async function loadSnapshot(): Promise<void> {
  const snapshot = await api<StateSnapshot>("GET", "/api/state");
  setState({ snapshot });
}

let socket: WebSocket | null = null;
let retryMs = 1000;

export function connect(): void {
  setAuthLostHandler(() => setState({ authLost: true }));
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}/ws`);
  socket.onopen = () => {
    retryMs = 1000;
    setState({ connected: true });
  };
  socket.onmessage = (ev) => {
    try {
      applyMessage(JSON.parse(String(ev.data)) as ServerMessage);
    } catch {
      /* ignore malformed */
    }
  };
  socket.onclose = () => {
    setState({ connected: false });
    socket = null;
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 15_000);
  };
  socket.onerror = () => socket?.close();
}
