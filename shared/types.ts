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

export interface Workspace {
  id: string;
  repoId: string;
  name: string;
  branch: string;
  path: string;
  baseBranch: string;
  port: number;
  status: WorkspaceStatus;
  error: string | null;
  creation: CreationState;
  copyManifest: string[];
  pr: { number: number; url: string; state: string } | null;
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
  sessions: unknown[];
}

export type ServerMessage =
  | { t: "snapshot"; state: StateSnapshot }
  | { t: "repo.changed"; item: Repo }
  | { t: "workspace.changed"; item: Workspace }
  | { t: "session.changed"; item: unknown }
  | {
      t: "session.status";
      sessionId: string;
      status: string;
      processState: string;
      freshness: string;
      pendingInputs: unknown;
      notify: boolean;
    }
  | { t: "event.appended"; sessionId: string; event: unknown }
  | { t: "event.gap"; sessionId: string; gap: unknown }
  | { t: "diff.changed"; workspaceId: string }
  | { t: "pr.changed"; workspaceId: string; pr: unknown }
  | { t: "script.output"; workspaceId: string; kind: "setup" | "run"; chunk: string }
  | { t: "hooks.listener"; ok: boolean; port: number; error?: string };
