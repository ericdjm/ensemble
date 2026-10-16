/** Data types shared by the server, the web UI, and the helpers. Keep this file free of Node imports. */

export type Agent = "claude" | "codex";
export type ScriptKind = "setup" | "run" | "archive";

export interface Repo {
  id: string;
  path: string;
  name: string;
  slug: string;
  defaultBase: string;
  createdAt: string;
}

export interface RepoConfig {
  setup: string | null;
  run: string | null;
  archive: string | null;
  copy: string[];
  defaultAgent: Agent | null;
}

export type RepoConfigOverrides = Partial<RepoConfig>;

export interface RepoConfigFile {
  exists: boolean;
  config: RepoConfig;
  error: string | null;
}

export interface ScriptApprovalState {
  kind: ScriptKind;
  script: string | null;
  hash: string | null;
  approved: boolean;
}

export interface EffectiveRepoConfig {
  file: RepoConfigFile;
  overrides: RepoConfigOverrides;
  config: RepoConfig;
  scripts: ScriptApprovalState[];
  needsApproval: boolean;
}

export type WorkspaceStatus =
  | "pending_approval"
  | "creating"
  | "copying"
  | "setting_up"
  | "ready"
  | "setup_failed"
  | "archived";

export interface CreationRequest {
  agent: Agent;
  prompt?: string;
  remoteControl?: boolean;
}

export interface CreationState {
  request: CreationRequest;
  steps: {
    approval?: true;
    worktree?: { head: string };
    copy?: { count: number };
    setup?: { exitCode: number };
  };
}

/** "worktree": an isolated worktree Ensemble created; "inplace": the user's own checkout (Phase 1 of docs/plan-v2.md). */
export type WorkspaceKind = "worktree" | "inplace";

export interface Workspace {
  id: string;
  repoId: string;
  kind: WorkspaceKind;
  name: string;
  branch: string;
  path: string;
  baseBranch: string;
  port: number;
  status: WorkspaceStatus;
  error: string | null;
  creation: CreationState;
  copyManifest: string[];
  pr: PrInfo | null;
  createdAt: string;
  archivedAt: string | null;
}

export interface IgnoredEntry {
  path: string;
  directory: boolean;
  symlink: boolean;
  size: number | null;
  fromCopyManifest: boolean;
}

export interface ArchiveInventory {
  tracked: string[];
  untracked: string[];
  ignored: IgnoredEntry[];
  symlinks: string[];
  hash: string;
}

export interface ArchiveDecisions {
  inventoryHash: string;
  forceDirty: boolean;
  ignored: Record<string, "keep" | "discard">;
}

export interface ManifestEntry {
  relPath: string;
  size: number;
  sha256: string;
  mode: number;
}

export interface ArchiveRecord {
  id: string;
  workspaceId: string;
  recoveryDir: string;
  manifest: ManifestEntry[];
  createdAt: string;
  deletedAt: string | null;
}

export interface StateSnapshot {
  repos: Repo[];
  workspaces: Workspace[];
  sessions: Session[];
  relays: Relay[];
}

export type ServerMessage =
  | { t: "snapshot"; state: StateSnapshot }
  | { t: "repo.changed"; item: Repo }
  | { t: "workspace.changed"; item: Workspace }
  | { t: "session.changed"; item: Session }
  | { t: "relay.changed"; item: Relay }
  | {
      t: "session.status";
      sessionId: string;
      status: string;
      processState: string;
      freshness: string;
      pendingInputs: PendingInputs;
      notify: boolean;
    }
  | { t: "event.appended"; sessionId: string; event: EventSummary }
  | { t: "event.gap"; sessionId: string; gap: unknown }
  | { t: "diff.changed"; workspaceId: string }
  | { t: "pr.changed"; workspaceId: string; pr: PrInfo }
  | { t: "script.output"; workspaceId: string; kind: "setup" | "run"; chunk: string }
  | { t: "hooks.listener"; ok: boolean; port: number; error?: string };

export type SessionStatus = "starting" | "working" | "needs_input" | "idle" | "exited" | "error";
export type ProcessState = "running" | "dead" | "missing" | "unknown";
export type Freshness = "current" | "stale" | "unknown";
export type AuthMode = "subscription" | "api" | "other" | "unknown" | "unchecked";

export interface PendingInputs {
  perm: Record<string, number>;
  prompt: boolean;
  elicitation: boolean;
  agentInput: boolean;
}

export interface Session {
  id: string;
  workspaceId: string;
  agent: Agent;
  tmuxName: string;
  cliSessionId: string | null;
  transcriptPath: string | null;
  remoteControl: boolean;
  status: SessionStatus;
  exitCode: number | null;
  processState: ProcessState;
  freshness: Freshness;
  authMode: AuthMode;
  authLabel: string | null;
  authCheckedAt: string | null;
  billingOptIn: boolean;
  billingAck: boolean;
  refusalReason: string | null;
  predecessorId: string | null;
  successorId: string | null;
  hookGeneration: number;
  lastSeq: number;
  pendingInputs: PendingInputs;
  /** When the last answer was captured; the full text comes from GET /api/sessions/:id/last-answer. */
  lastAnswerAt: string | null;
  lastAnswerSource: "stop-payload" | "codex-notify" | "transcript" | null;
  lastAnswerPreview: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface LastAnswer {
  text: string | null;
  at: string | null;
  source: Session["lastAnswerSource"];
}

export type RelayStatus = "running" | "done" | "limit" | "stopped" | "error" | "interrupted";

/** A bounded, opt-in exchange between two sessions (docs/plan-v2.md Phase 2). */
export interface Relay {
  id: string;
  workspaceId: string;
  aSessionId: string;
  bSessionId: string;
  awaitingSessionId: string | null;
  maxRounds: number;
  roundsDone: number;
  doneMarker: string;
  status: RelayStatus;
  error: string | null;
  createdAt: string;
  endedAt: string | null;
}

export interface EventEnvelope {
  id: string;
  sessionId: string;
  generation: number;
  seq: number;
  source: string;
  type: string;
  tool: string | null;
  sourceTs: string;
  truncated: boolean;
  payload: unknown;
}

export interface EventSummary {
  eventId: string;
  seq: number;
  generation: number;
  type: string;
  toolName: string | null;
  sourceTs: string | null;
  ingestedAt: string;
  truncated: boolean;
  summary?: string;
}

export interface EventGap {
  from_seq: number;
  to_seq: number;
  count: number;
  reason: string;
  recorded_at: string;
}

export interface DoctorTool {
  name: string;
  path: string | null;
  resolvedFrom: "override" | "login-shell PATH" | null;
  version: string | null;
  error: string | null;
}

export interface DoctorReport {
  tools: DoctorTool[];
  gh: { loggedIn: boolean | null; summary: string | null };
  hookListener: { ok: boolean; port: number; error: string | null };
  tmuxSocket: string;
  authModes: Array<{
    agent: Agent;
    mode: AuthMode;
    label: string | null;
    checkedAt: string | null;
  }>;
  notes: string[];
}

export interface SettingsView {
  billingOptIn: boolean;
  remoteControlDefault: boolean;
  relayEnabled: boolean;
  cliPaths: { claude?: string; codex?: string };
  workspaceRoot: string;
  branchPrefix: string;
  portBase: number;
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked" | "binary";
  additions: number;
  deletions: number;
  diff: string;
}

export interface WorkspaceDiff {
  base: string;
  baseBranch: string;
  files: DiffFile[];
}

export interface RunState {
  running: boolean;
  exitCode: number | null;
  script: string | null;
  approved: boolean;
}

export interface PrCheck {
  name: string;
  result: "passed" | "failed" | "pending";
  url: string | null;
}

export interface PrInfo {
  number: number;
  url: string;
  state: string;
  title: string;
  isDraft: boolean;
  mergeable: string | null;
  reviewDecision: string | null;
  checks: PrCheck[];
  mergedAt: string | null;
  baseRefName: string | null;
  fetchedAt: string;
}
