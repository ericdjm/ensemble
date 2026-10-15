# Ensemble architecture

Status: **approved with changes** by the owner on October 14, 2026. This revision incorporates the six review fixes and the recorded decisions in §11. Written against `ensemble-build-spec.md` and the verification results in `docs/cli-notes.md`.

The spec is the source of truth. This document explains how it will be met.

---

## 1. Overview

Ensemble is a single Node.js process that:

1. serves the browser UI and a JSON/WebSocket API on one listener (loopback by default);
2. runs a **second, loopback-only HTTP listener** that receives hook and launcher events from agent processes;
3. manages git worktrees, per-workspace setup/run/archive scripts, and tmux-backed agent sessions;
4. persists everything under `~/.ensemble/`.

Agent processes never talk to the UI listener. Browsers never talk to the hook listener. The only shared secret between the server and an agent is a per-session hook token stored in a `0600` file that the bundled helpers read.

```
browser ──cookie──▶ UI/API listener (127.0.0.1:4800 by default, --host/--port)
                    │  REST + /ws (state stream) + /ws/term (PTY bridge)
                    ▼
               Ensemble server ──execFile──▶ git, gh, tmux client, copy-worker
                    ▲                              │
                    │ POST /api/hooks/:id           ▼ tmux -L ensemble (dedicated socket)
hook listener (127.0.0.1:<persisted port>)    ┌──────────────────────────────┐
     ▲                                        │ ens-<sid>: agent-launcher → preflight → claude / codex
     │ spool-then-deliver                     │ ens-setup-<wid>: setup script
hook-capture helper ◀── hook stdin JSON ──────│ ens-run-<wid>:   run script
                                              └──────────────────────────────┘
```

---

## 2. Repository layout

```
bin/ensemble.js            CLI entry (start, doctor, token); `pnpm start` wraps it
server/                    Fastify app, domain modules (see §3)
helpers/                   dependency-free scripts that run inside tmux, as hooks, or as workers
  agent-launcher.mjs       final env policy + in-pane auth preflight + exec of the official CLI
  hook-capture.mjs         Claude/Codex hook stdin → spool → loopback POST, silent
  codex-notify.mjs         Codex `notify` fallback → same spool/POST path
  copy-worker.mjs          descriptor-pinned file copy worker (§6.2)
  tmux.conf                bundled minimal tmux configuration
web/                       React + Vite + Tailwind UI
shared/                    TypeScript types shared by server, helpers (via build), web
test/                      Vitest unit + integration tests, fixtures/fake-agent.mjs
docs/                      architecture.md, cli-notes.md
```

Single package, no monorepo tooling. Vite builds `web/` into `web/dist`; the server serves it with `@fastify/static`. `helpers/` are plain ESM with Node built-ins only so they start in well under 100 ms and have no dependency on the server's `node_modules` being intact.

The product name lives in `shared/brand.ts` (`PRODUCT_NAME`, `TMUX_SOCKET_NAME`, `STATE_DIR_NAME`, `BRANCH_PREFIX_DEFAULT`) so a rename is one edit.

---

## 3. Server components

| Module              | Responsibility                                                                                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/config`     | Loads/creates `~/.ensemble/config.json` (`0600`): UI token, hook port, workspace root, branch prefix, port base, CLI path overrides, billing opt-in default, Remote Control default, spool limits. |
| `server/db`         | `better-sqlite3` connection, WAL mode, numbered migrations in `server/db/migrations/*.sql` applied in a transaction with a `schema_version` table.                                                 |
| `server/auth`       | Token→cookie exchange, cookie validation, Host allowlist, WebSocket Origin check. Fastify `onRequest` hook applied to every route except `GET /login`.                                             |
| `server/git`        | Thin `execFile` wrapper around `git` with argument arrays; worktree add/list/prune/remove, status, ls-files, diff, merge-base.                                                                     |
| `server/repos`      | Repo registration, `.ensemble.json` loading/validation, script trust approvals (hash of the effective script text).                                                                                |
| `server/workspaces` | Resumable create operation (§6.1), copy plan + worker (§6.2), port allocator, setup/run script sessions, archive (§6.3), reconcile (§6.4).                                                         |
| `server/sessions`   | Agent session lifecycle: launch manifest with auth policy, tmux client calls, liveness polling, launcher result handling, resume.                                                                  |
| `server/hooks`      | Loopback listener, event ingestion, spool drain, status reducer (§7.6), clear-events generations.                                                                                                  |
| `server/terminal`   | `node-pty` bridge between `tmux attach` and `/ws/term` sockets.                                                                                                                                    |
| `server/diff`       | Diff assembly against merge-base including untracked files (§8.1).                                                                                                                                 |
| `server/pr`         | `gh` wrapper: auth status, push, PR create/view/merge, 60 s polling while open.                                                                                                                    |
| `server/watch`      | `chokidar` watcher per ready workspace, 300 ms debounce, feeds `diff.changed`.                                                                                                                     |
| `server/doctor`     | Tool versions, PATH resolution, `gh auth status`, non-secret auth-mode summaries.                                                                                                                  |
| `server/ws`         | Fan-out of domain events to browser sockets; snapshot on connect.                                                                                                                                  |

Every external process is spawned with `execFile`/`spawn` and an argument array. Only user-approved scripts go through `$SHELL -lc`.

---

## 4. Data model

SQLite at `~/.ensemble/ensemble.db`. Ids are UUIDv4 from `crypto.randomUUID()`. Timestamps are ISO-8601 UTC strings.

```sql
repos(id, path, name, slug, default_base, created_at)
script_approvals(repo_id, kind /*setup|run|archive*/, script_hash, script_text, approved_at)
workspaces(id, repo_id, name, branch, path, base_branch, port,
           status /*pending_approval|creating|copying|setting_up|ready|setup_failed|archived*/,
           creation_json /*persisted create-operation progress, see §6.1*/,
           copy_manifest_json, pr_number, pr_url, pr_state, pr_json, created_at, archived_at)
sessions(id, workspace_id, agent /*claude|codex*/, tmux_name, cli_session_id,
         transcript_path, remote_control, status
         /*starting|working|needs_input|idle|exited|error*/, exit_code,
         process_state /*running|dead|missing|unknown*/, freshness /*current|stale|unknown*/,
         auth_mode /*subscription|api|other|unknown|unchecked*/, auth_label, auth_checked_at,
         billing_opt_in, billing_ack, refusal_reason, predecessor_id, successor_id,
         hook_generation, last_seq, pending_inputs_json, created_at, started_at, ended_at)
events(event_id PRIMARY KEY, session_id, generation, seq, type, tool_name,
       source_ts, ingested_at, truncated, payload_json,
       UNIQUE(session_id, generation, seq))
event_gaps(session_id, generation, from_seq, to_seq, count, reason, recorded_at,
           UNIQUE(session_id, generation, reason))   -- one bounded row per gap kind
archives(id, workspace_id, recovery_dir, manifest_json, created_at, deleted_at)
settings(key PRIMARY KEY, value_json)   -- per-user overrides of repo config, UI prefs
```

Notes:

- `status` is turn status; `process_state` is liveness. They are stored and shown separately (a dead pane with status `needs_input` renders as "exited").
- `pending_inputs_json` is `{perm: {<tool_name>: count}, prompt: bool, elicitation: bool, agentInput: bool}` (§7.6), so a concurrent tool event cannot erase an unrelated open request.
- `auth_mode` is written by the in-pane launcher (§7.3); `unchecked` means the launcher never reported. `auth_label` is the user-facing text (for example "unsupported token-based authentication").
- `hook_generation` increments on "clear events". Events and spool records carrying an older generation are rejected.
- Workspace names are generated from a word list of musical terms (`allegro`, `cadenza`, …) with a numeric suffix on collision, and are user-renamable. Sanitization: `^[a-z0-9][a-z0-9-]{0,39}$` after lowercasing; branch = `<prefix>/<name>` and is additionally checked with `git check-ref-format --branch`.

Filesystem state:

```
~/.ensemble/
  config.json                   0600
  ensemble.db
  logs/server.log
  sessions/<sid>/               0700
    hook.json                   0600  {token, port, generation, limits}
    claude-settings.json        0600  hooks config passed via --settings
    launch.json                 0600  launcher manifest (cli path, args, env policy, auth policy)
    spool/                      0700  state.json (seq, generation), lock, queued records, gap.json
  archives/<wid>/<aid>/         0700  preserved files + manifest.json
```

---

## 5. HTTP API and WebSocket protocol

All routes require the auth cookie except `GET /login?token=…`, which sets the cookie and redirects to `/`. The UI listener binds `127.0.0.1:4800` unless `--host`/`--port` are given. Requests whose `Host` is not in the allowlist (`127.0.0.1:<port>`, `localhost:<port>`, plus the literal `--host` value) are rejected with 421 before routing.

### 5.1 REST (`/api`)

| Method & path                                             | Purpose                                                                                                                                                                                            |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /state`                                              | Full snapshot: repos, workspaces, sessions (no event payloads).                                                                                                                                    |
| `POST /repos` · `DELETE /repos/:id`                       | Register / unregister a local repo. Body: `{path}`.                                                                                                                                                |
| `GET /repos/:id/config` · `PUT /repos/:id/config`         | Read effective `.ensemble.json` + overrides; write overrides or create the file.                                                                                                                   |
| `POST /repos/:id/approve-scripts`                         | Approve the currently shown setup/run/archive text (by hash).                                                                                                                                      |
| `POST /workspaces`                                        | Start a create operation. Body: `{repoId, baseBranch, name?, agent, prompt?, remoteControl?}`. Returns the workspace in `pending_approval` or `creating`.                                          |
| `POST /workspaces/:id/continue`                           | Resume a create operation after approval or a failure (§6.1). Never repeats completed steps.                                                                                                       |
| `PATCH /workspaces/:id`                                   | Rename.                                                                                                                                                                                            |
| `GET /workspaces/:id/archive-preflight`                   | Inventory of tracked changes, untracked, ignored files, copy manifest.                                                                                                                             |
| `POST /workspaces/:id/archive`                            | Body carries the explicit decisions (§6.3). Returns archive id or a "new files found" conflict.                                                                                                    |
| `DELETE /workspaces/:id/branch`                           | Delete branch after archive.                                                                                                                                                                       |
| `POST /workspaces/:id/run` · `DELETE /workspaces/:id/run` | Start / stop the run script session.                                                                                                                                                               |
| `GET /workspaces/:id/diff`                                | File list with counts and the unified diff per file.                                                                                                                                               |
| `POST /workspaces/:id/push` · `/pr` · `/pr/merge`         | gh-backed PR flow.                                                                                                                                                                                 |
| `GET /workspaces/:id/pr`                                  | Cached `gh pr view` JSON.                                                                                                                                                                          |
| `POST /workspaces/:id/open`                               | Body `{app: "vscode"                                                                                                                                                                               | "finder"}`→`open -a …`/`open -R`. |
| `POST /sessions`                                          | Launch. Body: `{workspaceId, agent, prompt?, remoteControl?, billingAck?}`. Returns the session in `starting`; auth refusals surface on the session (§7.3). 409 only when scripts/approvals block. |
| `POST /sessions/:id/resume`                               | Body `{cliSessionId?, billingAck?}`; see §7.5.                                                                                                                                                     |
| `POST /sessions/:id/input`                                | Quick reply: `{text}` → `send-keys -l` + Enter.                                                                                                                                                    |
| `POST /sessions/:id/remote-control`                       | Sends `/remote-control` (Claude only, not for `other` auth mode).                                                                                                                                  |
| `POST /sessions/:id/kill`                                 | `tmux kill-session`.                                                                                                                                                                               |
| `GET /sessions/:id/events?after=&type=&tool=`             | Paged event list.                                                                                                                                                                                  |
| `GET /sessions/:id/events.jsonl`                          | Export; includes gap and truncation marker lines.                                                                                                                                                  |
| `DELETE /sessions/:id/events`                             | Clear with generation bump (§7.6).                                                                                                                                                                 |
| `POST /sessions/:id/comment`                              | Diff comment: `{path, from, to, text}` → formatted prompt via quick reply.                                                                                                                         |
| `GET /doctor`                                             | Doctor report.                                                                                                                                                                                     |
| `GET /settings` · `PUT /settings`                         | Global settings.                                                                                                                                                                                   |

### 5.2 Hook listener (separate server, loopback only)

`POST http://127.0.0.1:<hookPort>/api/hooks/:sessionId` with `Authorization: Bearer <session token>`. Accepts `Host` of `127.0.0.1:<port>` or `localhost:<port>`. No cookies, no Origin, no CORS, no other routes (anything else is 404). Body limit = configured per-payload cap + envelope overhead. Response `{ok:true, committed:true}` only after the SQLite transaction commits; `409 {reason:"generation"}` for cleared history; `401` for bad token.

The same route accepts launcher-originated envelopes (`source: "launcher"`, types `ensemble.preflight`, `ensemble.launch`, `ensemble.refused`) carrying only the named non-secret fields.

The port is chosen once (random free port in 49152–65535) and persisted in `config.json`. On restart the listener must bind that exact port. On failure the server starts anyway, shows a persistent "hook listener unavailable" banner, marks all running sessions `freshness=unknown`, and keeps draining spools from disk (which still works because helpers queue first).

### 5.3 WebSocket `/ws` (state stream)

JSON messages, server → client:

```
{t:"snapshot", state}
{t:"repo.changed"|"workspace.changed"|"session.changed", item}
{t:"session.status", sessionId, status, processState, freshness, pendingInputs, notify:boolean}
{t:"event.appended", sessionId, event}          -- summary only, payload on demand
{t:"event.gap", sessionId, gap}
{t:"diff.changed", workspaceId}
{t:"pr.changed", workspaceId, pr}
{t:"hooks.listener", ok:boolean, port, error?}
```

`notify` is true only for live transitions into `needs_input` or `idle` (turn complete) that the UI should surface as a browser notification. Replay never sets it except once for the final reconstructed state if it differs from the pre-replay state.

Client → server: `{t:"ping"}` only. All mutations go through REST.

### 5.4 WebSocket `/ws/term?target=session:<sid>|setup:<wid>|run:<wid>&cols=&rows=`

First frame from the server is `{t:"ready"}`. Binary frames carry PTY bytes both ways. Text frames: `{t:"resize", cols, rows}` client→server. Each socket spawns its own `tmux -L ensemble attach-session -t <name>` under `node-pty`; closing the socket kills the attach client only. Origin is validated on upgrade.

---

## 6. Workspaces

### 6.1 Create (a persisted, resumable operation)

`POST /workspaces` reserves the name, branch, path, and port block in one DB transaction and stores `creation_json = {steps: {}, prompt, agent, remoteControl}`. The port is allocated here, once (lowest free block of 10 from `portBase`, DB-only). Nothing is touched on disk yet.

The operation then advances through steps; each step records its completion in `creation_json.steps` before the next begins:

| Step       | Precondition  | Action                                                                                                     | Marks                           |
| ---------- | ------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `approval` | —             | If any script in the effective config is unapproved or changed, set `status=pending_approval` and stop.    | `steps.approval`                |
| `worktree` | not done      | `git worktree add -b <branch> <path> <base>` (in the main checkout).                                       | `steps.worktree = {path, head}` |
| `copy`     | worktree done | Build, validate, and execute the copy plan (§6.2); record the manifest.                                    | `steps.copy`                    |
| `setup`    | copy done     | If a setup script exists: `ens-setup-<wid8>` in tmux, wait for the pane to die; non-zero → `setup_failed`. | `steps.setup = {exitCode}`      |
| `ready`    | setup done    | `status=ready`; launch the first session if requested.                                                     | —                               |

`POST /workspaces/:id/continue` re-enters at the first incomplete step. It is valid from `pending_approval` (after approval), `setup_failed` (retries only the setup step), and from any `creating|copying|setting_up` row found after a restart. Before re-running `worktree`, the operation checks `git worktree list --porcelain` for the path: if the worktree exists at the expected branch, the step is marked done rather than repeated; if the path exists but is not a registered worktree, the operation fails with an explicit message and never deletes anything. A copy failure leaves `setup_failed` with the copy error and the worktree intact.

### 6.2 Copy containment (descriptor-pinned worker)

Pathname-based re-checks cannot close the swap race, so copies are executed by `helpers/copy-worker.mjs`, a dedicated child process that pins every directory it touches as its working directory and only ever operates on single path components relative to that pinned directory. A pinned cwd is an inode reference held by the kernel, so swapping a directory for a symlink after it has been entered has no effect, and a swap before entering is detected by inode comparison. This gives `openat`-equivalent semantics with Node built-ins only.

**Plan (server side, before the worker runs):**

- Patterns must be relative, no leading `/` or `~`, no `..` segment, no `.git` component, no absolute globs. Validation uses `picomatch` on normalized relative paths.
- Matching walks the main checkout with `lstat`, never following symlinks and never descending into `.git`; a symlink or special file that matches is rejected (plan fails). The plan is a list of `{relPath, size, srcDevIno}` entries plus the canonical source and destination roots (`fs.realpath`) and their `dev/ino`.
- The plan is rejected if any destination relative path has a `.git` component or would land on the worktree's `.git` file.

**Execution (worker, per entry, fail closed on any mismatch):**

1. `enterRoot(root, expectedDevIno)`: `process.chdir(root)`; `stat('.')` must equal `expectedDevIno`.
2. For each intermediate component `c` of `relPath`: `lstat(c)` must be a directory (not a symlink, not named `.git`); `chdir(c)`; `stat('.')` must equal the `lstat` result's `dev/ino`. A mismatch means the component was swapped between the check and the entry → abort the whole copy.
3. Source leaf: `open(leaf, O_RDONLY|O_NOFOLLOW)`; `fstat` must be a regular file with the planned `dev/ino`. Read from the fd.
4. Destination: walk as in step 2 from the destination root, creating missing intermediates with `mkdir(c)` followed by the same `lstat`→`chdir`→`stat('.')` verification. Leaf: `open(tmpName, O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0o600)` where `tmpName` is a random single component in the pinned directory; write; `fsync`; `rename(tmpName, leaf)` — both single components relative to the pinned cwd. Existing destination files are overwritten only via this rename, never opened.
5. Both walks are repeated from their roots for every entry (cheap, and it keeps the invariant simple).

The worker receives the plan on stdin as JSON, reports per-entry results on stdout as JSON lines, and exits non-zero on the first failure. The server treats any non-zero exit, unparsable line, or timeout as a failed copy (`setup_failed`). Because the worker changes its own cwd only, the server process is unaffected. The same worker and walk are used for archive preservation (§6.3) with the worktree as the source root and the recovery directory as the destination root.

Tests inject a swap between the `lstat` and `chdir` of a chosen component through a test-only hook (`ENSEMBLE_COPY_TEST_HOOK`, honoured only when the worker is started with an explicit test flag) and assert that the worker aborts with no file written outside the roots, in addition to static symlink-escape tests with real directories.

### 6.3 Archive

The UI drives a stateful dialog backed by `archive-preflight` and `archive`:

1. **Preflight** (read-only): tracked modifications, untracked non-ignored files, ignored files (`git ls-files --others --ignored --exclude-standard`), copy manifest entries, and which of those are symlinks. Show three groups: _tracked/untracked_ (require force confirmation), _ignored_ (per-file keep/discard; default keep; dependency dirs like `node_modules` offered as a discard group), _symlinks_ (never copied; shown).
2. **Lock** the workspace, kill `ens-*` sessions for it, rescan; if the inventory changed, return the delta and require a new decision.
3. **Preserve**: copy kept files to `~/.ensemble/archives/<wid>/<aid>/files/` with `manifest.json` (relative path, size, sha256, mode) using the §6.2 worker. Verify hashes after copying. Any failure aborts; worktree untouched.
4. **Archive script** (if approved): tmux session, must exit 0; failure aborts with the error, worktree kept.
5. **Final rescan**; any new/changed file not covered aborts with a new decision request. Then `git worktree remove [--force] <path>` with `--force` only when the user force-confirmed dirty state. Status `archived` only after success.
6. Branch kept; offer delete. Recovery files kept until explicitly deleted (`DELETE /archives/:id`). A "Restore" action copies files back into a given directory, documented in the README.

### 6.4 Reconcile on startup

`git worktree prune` per repo, then diff `git worktree list --porcelain` against the DB (missing path → `archived` with a `missing` note; in-progress create operations are re-entered via §6.1). `tmux -L ensemble list-panes -a -F '#{session_name}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_pid}'` → `process_state` per session; dead panes keep their exit code. Then spool drain (§7.6) before any `session.status` is broadcast.

---

## 7. Agent sessions

### 7.1 tmux

Dedicated server `tmux -L ensemble` started with `-f helpers/tmux.conf` (runtime-tested with tmux 3.8, see cli-notes):

```
set -g mouse on
set -g history-limit 50000
set -g remain-on-exit on
set -g window-size latest
set -g aggressive-resize on
set -g default-terminal "tmux-256color"
set -s escape-time 0
set -g status off
set -s exit-unattached off
set -s exit-empty on
```

Names: `ens-<sid8>` for agents, `ens-setup-<wid8>` and `ens-run-<wid8>` for scripts, where `<…8>` is the first 8 hex chars of the UUID (the full id is in the DB). Users can attach with `tmux -L ensemble attach -t ens-<sid8>`.

Launch:

```
tmux -L ensemble -f helpers/tmux.conf new-session -d -s ens-<sid8> -c <worktree> -x 220 -y 50 \
  -e ENSEMBLE_SESSION_ID=<sid> -e ENSEMBLE_WORKSPACE_NAME=… -e ENSEMBLE_WORKSPACE_PATH=… \
  -e ENSEMBLE_ROOT_PATH=… -e ENSEMBLE_PORT=… \
  -- <node> <abs>/helpers/agent-launcher.mjs ~/.ensemble/sessions/<sid>/launch.json
```

### 7.2 agent-launcher (final boundary)

Reads `launch.json` (`{agent, cliPath, args, env: {strip:[…]}, auth: {require, optIn, ack}, hook: {file}}`) and runs entirely inside the pane:

1. Build a fresh env from its own `process.env` with `strip` removed (default `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`; emptied when billing opt-in is on). This is the env the agent will get, including anything the tmux server retained.
2. Run the **auth preflight** (§7.3) with that env and `cwd` = worktree.
3. Post an `ensemble.preflight` envelope (mode, label, checkedAt — nothing else) through the hook path (spool + loopback POST, same helper code).
4. Apply the policy from `launch.json`. If refused: print one short line to the pane ("Ensemble refused to start <agent>: <label>. <instruction>"), post `ensemble.refused`, exit `78`. The pane remains (remain-on-exit) so the user sees it.
5. Otherwise spawn `cliPath` with `args` and `stdio: "inherit"`, forward `SIGINT/SIGTERM/SIGHUP`, post `ensemble.launch`, and exit with the child's code (128+signal if signalled).

The hook token is **not** placed in the environment; helpers read it from `hook.json`. Tests cover a pre-existing tmux server that retained a conflicting variable (runtime-reproduced in cli-notes).

### 7.3 Subscription preflight (inside the launcher)

Executed by the launcher, not the server, so it sees exactly the agent's filtered environment, working directory, and settings. 10 s timeout, stdout capped at 64 KiB, stderr discarded, nothing logged verbatim, only the named fields leave the launcher.

- **Claude:** `claude auth status --json` (with the same `--settings` file the launch uses, if the installed version accepts it on that subcommand; otherwise without). Read only `authMethod`. Mapping:

  | `authMethod`                                 | mode           | label                                                     |
  | -------------------------------------------- | -------------- | --------------------------------------------------------- |
  | `claude.ai`                                  | `subscription` | "Claude subscription"                                     |
  | `api_key`, `api_key_helper`                  | `api`          | "API key billing" / "API key helper billing"              |
  | `oauth_token`                                | `other`        | "unsupported token-based authentication" (decision §11.1) |
  | `third_party`                                | `other`        | "third-party provider"                                    |
  | `none`                                       | `unknown`      | "not logged in — run `claude` and `/login`"               |
  | parse error / timeout / nonzero without JSON | `unknown`      | "authentication mode could not be determined"             |

- **Codex:** `codex login status` under the same env, stdout and stderr captured (64 KiB cap) and matched: `Logged in using ChatGPT` → `subscription` ("ChatGPT subscription"), anything mentioning an API key → `api`, "not logged in" → `unknown`, anything else → `unknown`. Only the ChatGPT form has been observed on the installed version (cli-notes, October 15, 2026); the others are documentation-derived and fail closed.

Policy (evaluated by the launcher from `launch.json`): default requires `subscription`. With the global opt-in, `api` is allowed and shown with a persistent billing badge. `other` and `unknown` additionally require `ack:true` for that specific launch; such sessions are labelled "auth mode unverified" and never "subscription-verified". A refusal leaves the session in `error` with `refusal_reason`; the UI offers "Relaunch with acknowledgement" (allowed only when the global opt-in is on), which creates a new session record with a predecessor link. Conflicting variable _names_ present in the launcher's env are reported in the `ensemble.preflight` envelope; values are never shown or stored.

The server keeps an advisory copy of the last known mode per CLI for the Doctor page, taken from launcher reports only. The server never runs the status commands itself.

### 7.4 CLI arguments

- Claude: `claude --settings ~/.ensemble/sessions/<sid>/claude-settings.json [--remote-control "<repo>/<ws>"] ["<prompt>"]`. The settings file contains only `hooks`. Resume: `claude --settings … --resume <cli_session_id>`. `--remote-control` is omitted, the toggle disabled, and "Enable now" hidden when `auth_mode` is `other` (setup tokens lack the Remote Control scope) or the agent is Codex.
- Codex: `codex -c 'hooks.<Event>=[{hooks=[{type="command",command="<node> <abs>/helpers/hook-capture.mjs codex"}]}]' … -c 'notify=["<node>","<abs>/helpers/codex-notify.mjs"]' ["<prompt>"]`. Resume: `codex … resume <cli_session_id>`. The hook command string is identical for every session (session id comes from `ENSEMBLE_SESSION_ID`), so Codex's trust hash is stable and the user trusts it once via `/hooks`. Ensemble never writes `~/.codex/*` and never passes `--dangerously-bypass-hook-trust`.

**Workspace trust:** Claude holds back hooks from settings files, including `--settings`, until the folder is trusted interactively (confirmed October 15, 2026: `SessionStart` arrived within a second of accepting the dialog), and each worktree is a new folder. Ensemble takes no automatic action and does not pre-trust parent directories (decision §11.4). A session starts as `starting` with `freshness=unknown`; if the launcher reported a successful launch but no `SessionStart` has arrived after 20 s while the pane is alive, the UI shows: "No session events received yet. Check the terminal for trust or login prompts." The message makes no claim about the cause.

### 7.5 Resume

Allowed only when `process_state` is `dead` or `missing`. Creates a new session row with `predecessor_id`, a new hook token/generation/settings file, and goes through the launcher preflight again. The id passed is the stored `cli_session_id` (Claude: from `SessionStart.session_id`; Codex: from the `SessionStart` hook or the `thread-id` in `notify` payloads). If none is stored, or the CLI rejects it, the UI offers: paste an id, open the CLI's own picker in a fresh terminal session (`claude --resume` / `codex resume` with no id, which is interactive and explicit), or start a new conversation. `--continue`/`--last` are never passed. Cancelling leaves the old record intact.

### 7.6 Hooks, spool, and status

**Claude settings file** registers `helpers/hook-capture.mjs claude` for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`, `Notification`, `Elicitation`, `ElicitationResult`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `SessionEnd`, each with `timeout: 5` and no matcher. `PermissionRequest` hooks return nothing, so the permission flow is unchanged. In M2 only `SessionStart` and `SessionEnd` are registered (identity capture); M3 adds the rest.

**Spool layout** (`~/.ensemble/sessions/<sid>/spool/`, `0700`): `lock` (O_EXCL lock file), `state.json` (`{generation, seq}`), `<generation>-<seq:010d>.json` records, `gap.json` (bounded). **Every** change to `state.json`, every record write, every gap update, and every generation bump happens under `lock`. Clearing history therefore cannot interleave with a writer: the server takes the lock, bumps `generation`, resets `seq`, deletes older-generation records and `gap.json`, rewrites `hook.json`, then releases. A writer that acquired the lock earlier allocated its seq under the old generation and its record is rejected on ingestion; a writer that acquires it later sees the new generation.

**hook-capture.mjs** (time budget: hard `process.exit(0)` at 4 s; delivery timeout 2 s):

1. Replace `process.stdout.write`/`process.stderr.write` with no-ops; wrap everything in `try/catch`.
2. Read stdin up to the per-payload cap (default 256 KiB). Beyond the cap, stop reading, keep the prefix, and set `truncated=true`; still extract `hook_event_name`, `tool_name`, `session_id`, `transcript_path` from the prefix if parseable.
3. Load `hook.json` (`token, port, generation, limits`).
4. Under `lock` (retry ≤ 20 × 25 ms; a lock older than 10 s is treated as stale): read `state.json`, allocate `seq`, and either write `<gen>-<seq>.json` via temp+rename, or, if total spool bytes would exceed the cap (default 64 MiB), update `gap.json` in place to `{generation, fromSeq, toSeq, count, reason:"spool_full"}` (one fixed-size file, never a record per rejected event). Write `state.json`, release.
5. POST the envelope `{id, sessionId, generation, seq, source, type, tool, sourceTs, truncated, payload}` with `fetch`, 2 s timeout, no retry, response body discarded. Direct delivery is attempted even when the durable copy was dropped. On `{committed:true}` delete the spool record; on anything else leave it.
6. Exit 0.

**Server ingestion** (`POST` and spool drain share one function): verify token (constant-time), verify generation, insert with `INSERT OR IGNORE` on `event_id` and on `(session_id, generation, seq)`; apply to the reducer only if newly inserted and `seq > last_seq` (buffer up to 2 s for a missing `seq-1`, then upsert the bounded `event_gaps` row and continue). Commit, then ack. `gap.json` contents are upserted into `event_gaps` (one row per generation+reason) and the file is removed once recorded.

**Spool drain**: at startup, every 15 s, and when the hook listener fails to bind, the server scans **every** `sessions/<sid>/spool/` directory that exists, regardless of session state (exited and missing sessions may still hold their final `Stop`/`SessionEnd`), sorts by `(generation, seq)`, ingests, and deletes acknowledged files. Spool directories of sessions whose rows no longer exist are reported in logs and left alone. Drain runs with `replay=true`, so the reducer updates silently and a single `session.status` is emitted at the end.

**Reducer** (per session; pure function tested in isolation). Pending state: `perm: {tool_name → count}`, `prompt: bool` (notification-backed permission prompt), `elicitation: bool`, `agentInput: bool`. Status is `needs_input` when any counter is > 0 or any flag is set; otherwise `working` while a turn is active, else `idle`.

| Event                                                                                         | Effect                                                                                                                     |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart`                                                                                | store `cli_session_id`, `transcript_path`; status `idle`; `freshness=current`                                              |
| `UserPromptSubmit`                                                                            | turn active; clear all pending                                                                                             |
| `PreToolUse`                                                                                  | turn active; `prompt=false` (a new tool starting means the previous prompt was answered)                                   |
| `PermissionRequest`                                                                           | `perm[tool_name]++`                                                                                                        |
| `PostToolUse`, `PostToolUseFailure`, `PermissionDenied`                                       | `perm[tool_name]--` (floor 0); `prompt=false`; `agentInput=false`                                                          |
| `Notification/permission_prompt`                                                              | `prompt=true` (delayed/fallback signal; counts once regardless of concurrent `perm` entries)                               |
| `Notification/elicitation_dialog`, `elicitation_url_dialog`; `Elicitation`                    | `elicitation=true`                                                                                                         |
| `Notification/elicitation_complete`, `elicitation_response`; `ElicitationResult`              | `elicitation=false`                                                                                                        |
| `Notification/agent_needs_input`                                                              | `agentInput=true`                                                                                                          |
| `Notification/idle_prompt`, `auth_success`, `agent_completed`, `quota_auto_resume_*`, unknown | no change                                                                                                                  |
| `Stop`                                                                                        | turn inactive; clear `perm`, `prompt`, `elicitation` (keep `agentInput` until the next `UserPromptSubmit`); `diff.changed` |
| `StopFailure`                                                                                 | `error` with message; clear all pending                                                                                    |
| `SessionEnd`                                                                                  | turn `exited`; clear all pending                                                                                           |
| `ensemble.preflight` / `ensemble.launch` / `ensemble.refused`                                 | update `auth_*`; `refused` → `error` with reason                                                                           |
| gap recorded                                                                                  | `freshness=stale` until the next `Stop` or `UserPromptSubmit`                                                              |

Resolution rules in words: an immediate `PermissionRequest` is resolved by one completion of a tool with the same name, so two concurrent requests for the same tool need two completions. A notification-backed prompt is a single flag because it carries no tool identity; it is resolved by any later tool-lifecycle event, prompt, or stop. The `agent_needs_input` semantics (whether `Stop` follows it) are verified in the M3 manual check and the table adjusted if needed.

Process liveness overrides presentation: `dead`/`missing` shows "exited (code)" regardless of turn status; exit code `78` shows "refused: <label>".

**Codex**: identical envelope from the `codex` adapter of `hook-capture.mjs` (events `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Stop`, `SessionEnd`, mapped to the same reducer). If the user has not trusted the hook definition, Codex skips it; `codex-notify.mjs` still delivers `agent-turn-complete` → `Stop` with `thread-id` as the conversation id. With neither, status is `working` while the pane produced output in the last 10 s (`#{pane_activity}` via `list-panes`) else `idle`, with `freshness=unknown`. This heuristic mode is labelled in the UI.

**Clear events**: under the spool lock, bump `hook_generation`, reset `seq`, rewrite `hook.json` and `state.json`, delete older-generation records and `gap.json`; then delete `events`/`event_gaps` rows for older generations. `last_seq` resets to 0 for the new generation. Late POSTs with the old generation get `409`.

---

## 8. Diff, PR, Doctor

### 8.1 Diff

`base = git merge-base <base_branch> HEAD`. Output = `git diff --no-color --no-ext-diff -M <base>` (committed + unstaged + staged, since diffing a commit against the working tree includes both) plus, for each path from `git ls-files --others --exclude-standard`, `git diff --no-index /dev/null <path>` (binary files listed without content). Nothing touches the index. The response is one unified diff string per file plus `+/-` counts from `--numstat`. The UI parses it with `react-diff-view`.

### 8.2 PR flow

`gh auth status` (exit code and the "Logged in to" line only) for detection. `git push -u origin <branch>`, `gh pr create --title --body [--draft]`, `gh pr view --json number,url,state,title,isDraft,mergeable,reviewDecision,statusCheckRollup,mergedAt`, `gh pr merge --squash|--merge|--rebase`. Polling every 60 s per workspace with an open PR. "Ask the agent to draft the description" sends a prompt via quick reply and leaves the form open.

### 8.3 Doctor

Versions of git, tmux, claude, codex, gh; which path each resolved from (login-shell `PATH` via `$SHELL -lc 'command -v …'`, or the settings override, reported as "not on PATH" when only the override finds it); `gh auth status` summary; the last launcher-reported auth mode per CLI with a "what this does and does not prove" note; hook listener state; workspace root free space. The Doctor never runs the CLIs' auth-status commands itself and never inspects credential files.

---

## 9. Security model (summary of enforcement points)

- UI listener: `127.0.0.1` default; `--host` opt-in. Every route and both WebSocket paths require the cookie (`HttpOnly`, `SameSite=Strict`, `Secure` only when served over TLS, which Ensemble does not do itself). Host allowlist check before routing; Origin must match an allowlisted host on upgrade. No CORS headers at all.
- UI token: 32 random bytes base64url, `config.json` mode `0600`, printed as `http://<host>:<port>/login?token=…` at startup; `ensemble token --rotate` regenerates it.
- Hook listener: loopback only, bearer token per session (32 random bytes), path/token binding, no browser semantics, persisted port.
- Scripts: hash-approved per repo per kind; changed text → re-approval. Per-user overrides are approved the same way.
- Copy rules: §6.2 worker, applied regardless of approval.
- Process spawning: argument arrays only. User-supplied strings reach a shell only inside approved scripts.
- Credentials: a Vitest test greps `server/ helpers/ web/ shared/ bin/` for `.credentials.json`, `.claude.json`, `auth.json`, `security find-generic-password`, and `Keychain` and fails on any hit outside `test/`. The same check runs in CI.
- Event payloads: stored only in `ensemble.db` and the `0700` spool; exported only on user request; no telemetry of any kind.

---

## 10. Milestones

Each ends with green `pnpm typecheck && pnpm lint && pnpm test`, a conventional commit, and a push.

- **M0** scaffold: pnpm, TypeScript strict, ESLint + Prettier, Vitest, Vite/React/Tailwind shell, Fastify hello, `bin/ensemble.js`, credential-path test, GitHub Actions on `macos-latest`, README skeleton, `gh repo create ensemble --public`, first push.
- **M1** repos & workspaces: §4 schema and migrations, config, auth, `.ensemble.json` + approvals, resumable create operation, worktree list/reconcile, copy worker with the swap-race tests, port allocation, setup script in tmux, archive preflight/preserve/remove with ignored-file tests, sidebar + workspace tabs (Setup log).
- **M2** sessions: launcher with in-pane preflight (fixtures for every `authMethod`, fake `claude`/`codex` on PATH in tests), tmux launch with fresh and pre-existing servers, **minimal hook path**: listener, `hook-capture.mjs`, spool lock/state, `SessionStart`/`SessionEnd` and launcher envelopes only, so `cli_session_id` is captured; `/ws/term` bridge, quick reply, exact-id resume with two conversations, Doctor page. **Pause for owner testing**, including the manual checks: real `claude` launch, trust prompt behaviour, and recording the `codex login status` contract in cli-notes.
- **M3** full hooks: remaining Claude events, Codex hook/notify adapters, silence tests (success, HTTP error, timeout, malformed input, read-only spool), spool limits and bounded gaps, drain of all spool directories, replay/dedup/order, reducer tests for every notification type and the permission-resolution rules, clear-events under the lock, Events tab + JSONL export, browser notifications + title badge.
- **M4** Diff tab (unified/split, untracked files, auto-refresh), comment-to-agent, Run tab.
- **M5** PR flow.
- **M6** Remote Control toggle + "Enable now" (disabled for Codex and `other` auth), `--host` hardening tests (hooks still loopback), mobile layout.
- **M7** polish, README, final acceptance pass. Codex is marked supported only once the verified status adapter from §7.3 is in place.

---

## 11. Recorded decisions (October 14, 2026)

1. **`oauth_token`** → mode `other`, refused by default, label "unsupported token-based authentication" (not "API billing"). Remote Control is disabled for this mode even when the launch is explicitly allowed, because setup tokens lack the Remote Control scope.
2. **GitHub**: repository `ensemble`, public.
3. **Copy routine**: descriptor-pinned worker (§6.2); fail closed on any inode mismatch.
4. **Workspace trust**: hint only, no automatic action, no parent-directory pre-trust; neutral timeout message as in §7.4.
5. **Codex**: the `login status` contract was recorded on October 15, 2026 and the adapter implemented against it; unobserved modes still fail closed.
6. **Ports**: UI default 4800; hook port persisted from 49152–65535.

## 12. Dependency justification

| Dependency                                                                                       | Why                                                                                                                        |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `fastify`, `@fastify/static`, `@fastify/cookie`                                                  | Spec choice; schema validation built in; static serving and cookie parsing are the only plugins needed.                    |
| `ws`                                                                                             | Spec choice; attached to Fastify's `http.Server` directly, two paths.                                                      |
| `better-sqlite3`                                                                                 | Spec choice; synchronous API makes "commit before ack" trivial.                                                            |
| `node-pty`, `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`                         | Spec choice.                                                                                                               |
| `chokidar`                                                                                       | Spec choice.                                                                                                               |
| `picomatch`                                                                                      | Glob matching for copy rules over a hand-rolled, symlink-safe walker; already a transitive dependency of chokidar.         |
| `react-diff-view`                                                                                | React-native diff renderer with its own unified-diff parser and gutter/line selection events, needed for comment-to-agent. |
| `react`, `react-dom`, `vite`, `tailwindcss`, `typescript`, `tsx`, `vitest`, `eslint`, `prettier` | Spec toolchain.                                                                                                            |

Deliberately not used: an ORM, zod (Fastify JSON schema + small hand validators suffice), an `open` package (`execFile("open", [url])` on macOS, print the URL elsewhere), any HTTP client (`fetch` is built in), native addons for `openat` (the §6.2 worker provides the needed semantics with built-ins).
