import { useSyncExternalStore } from "react";
import type {
  EventSummary,
  Relay,
  ServerMessage,
  Session,
  StateSnapshot,
  Workspace,
  SettingsView,
} from "../../shared/types.js";
import { setFaviconBadge } from "./favicon.js";
import { api, setAuthLostHandler } from "./api.js";

export interface UiState {
  snapshot: StateSnapshot | null;
  connected: boolean;
  authLost: boolean;
  setupLogs: Record<string, string>;
  hookListener: { ok: boolean; port: number; error?: string } | null;
  notificationsEnabled: boolean;
  settings: SettingsView | null;
}

let state: UiState = {
  snapshot: null,
  connected: false,
  authLost: false,
  setupLogs: {},
  hookListener: null,
  settings: null,
  notificationsEnabled:
    typeof Notification !== "undefined" && Notification.permission === "granted",
};
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

function upsert<T extends { id: string; createdAt: string }>(list: T[], item: T): T[] {
  const next = list.filter((w) => w.id !== item.id);
  next.push(item);
  next.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return next;
}

function upsertWorkspace(ws: Workspace): void {
  if (!state.snapshot) return;
  setState({ snapshot: { ...state.snapshot, workspaces: upsert(state.snapshot.workspaces, ws) } });
}

function upsertRelay(r: Relay): void {
  if (!state.snapshot) return;
  setState({
    snapshot: { ...state.snapshot, relays: upsert(state.snapshot.relays ?? [], r) },
  });
}

function upsertSession(s: Session): void {
  if (!state.snapshot) return;
  setState({ snapshot: { ...state.snapshot, sessions: upsert(state.snapshot.sessions, s) } });
}

export function attentionCount(): number {
  return (
    state.snapshot?.sessions.filter(
      (s) => s.processState === "running" && s.status === "needs_input",
    ).length ?? 0
  );
}

function updateTitle(): void {
  const n = attentionCount();
  document.title = n > 0 ? `(${n}) Ensemble` : "Ensemble";
  try {
    setFaviconBadge(n);
  } catch {
    /* no canvas */
  }
}

const eventListeners = new Map<string, Set<(ev: EventSummary) => void>>();
const diffListeners = new Map<string, Set<() => void>>();

/** Fires when the server reports file changes or a Stop hook for a workspace. */
export function subscribeDiff(workspaceId: string, cb: () => void): () => void {
  let set = diffListeners.get(workspaceId);
  if (!set) {
    set = new Set();
    diffListeners.set(workspaceId, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
  };
}

/** Per-session live event feed for the Events tab. */
export function subscribeEvents(sessionId: string, cb: (ev: EventSummary) => void): () => void {
  let set = eventListeners.get(sessionId);
  if (!set) {
    set = new Set();
    eventListeners.set(sessionId, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
  };
}

function notify(session: Session): void {
  if (!state.notificationsEnabled || typeof Notification === "undefined") return;
  const ws = state.snapshot?.workspaces.find((w) => w.id === session.workspaceId);
  const title = session.status === "needs_input" ? "Agent needs input" : "Agent finished a turn";
  try {
    new Notification(title, {
      body: `${ws?.name ?? "workspace"} · ${session.agent}`,
      tag: `ensemble-${session.id}`,
    });
  } catch {
    /* unsupported */
  }
}

export function applyMessage(msg: ServerMessage): void {
  switch (msg.t) {
    case "snapshot":
      setState({ snapshot: msg.state });
      break;
    case "workspace.changed":
      upsertWorkspace(msg.item);
      break;
    case "session.changed":
      upsertSession(msg.item);
      break;
    case "relay.changed":
      upsertRelay(msg.item);
      break;
    case "session.status": {
      const current = state.snapshot?.sessions.find((s) => s.id === msg.sessionId);
      if (current) {
        const next: Session = {
          ...current,
          status: current.status,
          pendingInputs: msg.pendingInputs,
        };
        next.status = msg.status as Session["status"];
        next.processState = msg.processState as Session["processState"];
        next.freshness = msg.freshness as Session["freshness"];
        upsertSession(next);
        if (msg.notify) notify(next);
      }
      break;
    }
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
    case "pr.changed": {
      const ws = state.snapshot?.workspaces.find((w) => w.id === msg.workspaceId);
      if (ws) upsertWorkspace({ ...ws, pr: msg.pr });
      break;
    }
    case "diff.changed":
      for (const cb of diffListeners.get(msg.workspaceId) ?? []) cb();
      break;
    case "event.appended":
      for (const cb of eventListeners.get(msg.sessionId) ?? []) cb(msg.event);
      break;
    case "hooks.listener":
      setState({
        hookListener: { ok: msg.ok, port: msg.port, ...(msg.error ? { error: msg.error } : {}) },
      });
      break;
    default:
      break;
  }
  updateTitle();
}

export function setSetupLog(workspaceId: string, text: string): void {
  setState({ setupLogs: { ...state.setupLogs, [workspaceId]: text } });
}

export async function enableNotifications(): Promise<void> {
  if (typeof Notification === "undefined") return;
  const result = await Notification.requestPermission();
  setState({ notificationsEnabled: result === "granted" });
}

export async function loadSnapshot(): Promise<void> {
  const snapshot = await api<StateSnapshot>("GET", "/api/state");
  setState({ snapshot });
  updateTitle();
}

export async function loadSettings(): Promise<void> {
  try {
    setState({ settings: await api<SettingsView>("GET", "/api/settings") });
  } catch {
    /* settings are optional for rendering */
  }
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
