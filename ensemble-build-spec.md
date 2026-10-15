# Build spec: Ensemble — a local orchestrator for parallel Claude Code and Codex sessions

You are building a new open-source project from scratch and publishing it as a GitHub repository. The repository currently contains planning documents; application implementation has not started. Read this entire document before doing anything. Follow the **Working process** section when starting implementation. Documentation reviews and corrections do not authorize application code or publication.

"Ensemble" is a working name; the owner may rename it later, so keep the name in one constant/config where practical.

---

## 1. What we're building

A **local web app for macOS** that runs multiple coding-agent sessions in parallel, each in its own isolated git worktree, with a browser UI to monitor, steer, review, and ship their work. Think of it as a self-hosted alternative to Conductor (conductor.build).

Core loop:

1. Add a local git repo.
2. Create a **workspace** = new git worktree + branch, set up automatically (copied env files, setup script).
3. Start one or more **agent sessions** (Claude Code or Codex) in that workspace, optionally with an initial prompt.
4. Watch every session's live status from one sidebar (working / needs input / idle / exited).
5. Review the diff, open a PR, merge, and archive the workspace.

### Who it's for

Individual developers running it on their own Mac with **their own Claude and/or ChatGPT subscription**. Each user runs their own copy. There is no hosted service.

### Non-goals (v1)

- No cloud execution, multiplayer, or accounts.
- No API-key billing management or usage dashboards.
- No Windows/Linux support (but don't add macOS-only code where portable code is just as easy).
- No in-app code editor — provide "Open in VS Code" / "Reveal in Finder" buttons instead.

---

## 2. Hard constraints — do not violate these

### 2.1 Subscription use without touching credentials

The app must work with users' Claude Pro/Max and ChatGPT subscriptions. The app behaves like a terminal multiplexer: **it launches the user's own installed CLI, interactively, using the CLI's own authentication.**

- **Never** read, copy, parse, store, transmit, or proxy credentials or OAuth tokens. That includes `~/.claude/.credentials.json`, auth fields in `~/.claude.json`, `~/.codex/auth.json`, and macOS Keychain entries. Never implement your own login flow.
- **Only** run the official `claude` and `codex` binaries, resolved from the user's login-shell `PATH` (with an override path in settings).
- **Interactive sessions only.** Do not use `claude -p`, headless/print modes, `codex exec`, or the Claude Agent SDK / Codex SDK to drive sessions. This is a product and integration constraint, not a claim that non-interactive execution necessarily uses API billing. In particular, Codex documents that `codex exec` reuses saved CLI authentication; see [CLI notes](docs/cli-notes.md).
- **Prevent accidental API billing:** by default, remove `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `OPENAI_API_KEY` from the effective agent environment. Filter by variable name without logging values. Removing these variables alone does **not** prove subscription use: saved API-key login, credential helpers such as Claude's `apiKeyHelper`, provider configuration, and tmux's retained environment can affect authentication.
- **Subscription preflight:** before every launch or resume, use a verified, supported CLI interface that exposes only non-secret authentication metadata to establish the effective mode under the launch configuration. Normalize it to `subscription | api | other | unknown`. The default requires `subscription`; otherwise refuse launch with instructions to use the CLI's own login/settings. Never fall back to inspecting credential files, invoking a credential helper, or collecting raw status output that may contain credentials. Verify the safety and limitations of each status interface in `docs/cli-notes.md` before using it; the presence of a status command alone is insufficient.
- An explicit API-billing opt-in in settings may permit API mode and pass through the named API environment variables. Show the billing warning before launch and on the session. If the effective mode cannot be established, the warning must say so and require a session-specific acknowledgement; do not label that session subscription-verified. Warn when conflicting environment variable names are present, without showing their values. Ensemble does not collect or store keys.
- Reading the CLIs' own transcript/session files read-only (e.g. a `transcript_path` handed to us by a hook) is allowed for the event log. Treat their formats as unstable.

Add an automated test or CI check that fails if source code references the credential paths above.

### 2.2 Security model

The server can spawn shells, so treat it as remote code execution if exposed.

- Bind the UI/API server to `127.0.0.1` by default. A `--host` flag allows binding elsewhere (e.g. a Tailscale IP for phone access). Hooks always use a separate loopback-only listener on a persisted hook port; changing the UI host or port must not change the hook destination. If the hook port cannot be rebound on restart, report the failure and retain queued events instead of silently choosing another port.
- **Always require auth**, even on localhost: generate a random access token on first run, store it in `~/.ensemble/config.json` (mode `0600`), and print a login URL containing it at startup. Exchange it for an `HttpOnly`, `SameSite=Strict` cookie.
- Every HTTP route and WebSocket requires auth. Validate the `Host` header against an allowlist (DNS-rebinding protection) and the `Origin` header on WebSocket upgrades. No permissive CORS.
- **Hook endpoint auth:** each agent session gets its own random hook token that can only post events for that session. It must not be the UI token. The hook listener exposes only the authenticated event-ingestion route, accepts the intended loopback Host, and does not require a browser cookie or Origin header. Its token and destination survive server restarts for the session's lifetime.
- **Repo config trust:** setup/run/archive scripts come from the repo's `.ensemble.json`. The first time a repo's scripts are seen, or whenever they change, show them in the UI and require explicit approval before running anything. Users might add untrusted repos.
- **Copy rules are untrusted input:** enforce the containment rules in §5.1 even for a repo with approved scripts. Approval never permits a copy to escape the main checkout or destination worktree, follow a symlink, or overwrite Git metadata.
- Spawn processes with argument arrays, never shell-interpolated strings built from user input. Sanitize workspace names and branch names. Only the user-approved scripts run through `$SHELL -lc`.

---

## 3. Tech stack

- **Runtime:** Node.js 22+ LTS, TypeScript (strict), pnpm.
- **Server:** Fastify (or Hono) + `ws` for WebSockets.
- **Terminals:** `tmux` (required dependency, `brew install tmux`) + `node-pty` + `@xterm/xterm` with fit and web-links addons in the browser.
- **State:** SQLite via `better-sqlite3`, with simple migrations.
- **Frontend:** React + Vite + Tailwind. Use a maintained diff renderer such as `diff2html` or `react-diff-view`.
- **File watching:** `chokidar` (debounced).
- **Tests:** Vitest. Lint/format: ESLint + Prettier.
- **Repo layout:** a single package with `server/`, `web/`, `shared/` (types), `bin/`, `docs/`, `test/`. Avoid a monorepo tool unless it clearly pays off.
- The production build serves the built web assets from the server. `pnpm start` builds if needed, starts the server, and opens the browser to the login URL.

Prefer few, well-maintained dependencies. Justify any non-obvious one in `docs/architecture.md`.

---

## 4. Concepts and data model

- **Repo:** a local git repo path, display name, default base branch, and trust state of its scripts.
- **Workspace:** one git worktree + branch for one task.
  - Fields: name, branch, path, base branch, port, status (`setting_up | ready | setup_failed | archived`), and PR info.
  - Names are memorable, unique, and renamable (e.g. musical terms).
  - Branch name: `ens/<workspace-name>`, with the prefix configurable.
  - Path: `~/ensemble/<repo-slug>/<workspace-name>` (outside the repo, to avoid nested-repo tooling issues). The root is configurable.
- **Session:** one agent process inside a workspace.
  - Fields: agent (`claude | codex`), tmux session name, CLI session id (captured from hooks), remote-control flag, status (`starting | working | needs_input | idle | exited | error`), exit code, and timestamps.
  - Persist authentication-mode metadata, any billing opt-in, last applied event sequence, and status freshness (`current | stale | unknown`). Keep process liveness separate from turn status. Retain predecessor/successor links when resuming a conversation in a new process.
  - A workspace can have multiple sessions. They share the branch and files, so warn when starting a second one.
- **Event:** unique event id, Ensemble session id, per-session source sequence, source and ingestion timestamps, type, tool name (nullable), and raw payload (JSON). Enforce unique event ids for replay deduplication and retain markers for truncated payloads or known delivery gaps. This is the tool-call event log.

State lives in `~/.ensemble/`: `config.json`, `ensemble.db`, `logs/`, per-session generated files and event spools under `sessions/<id>/`, and archive recovery files under `archives/<workspace-id>/<archive-id>/`. Generated hook tokens, event spools, and archive recovery files are private: directories mode `0700`, files mode `0600`.

---

## 5. Features

### 5.1 Workspace lifecycle

**Create:**

1. Choose repo, base branch, agent, and an optional initial prompt.
2. Run `git worktree add -b <branch> <path> <base>`.
3. Validate the repo config's `copy` globs and all matches, then copy regular files from the main checkout. These are typically gitignored files like `.env*`. Record the copied relative paths in the workspace's copy manifest. If validation or copying fails, leave the workspace in `setup_failed` and do not start scripts or agents.
4. Allocate a port block (10 ports per workspace, starting from a configurable base such as 41000).
5. Run the approved setup script in a PTY, streaming output to the UI.
6. Mark the workspace ready and start the first agent session.

**Copy containment:**

- Require relative patterns; reject absolute paths, home expansion, `..` path segments, and `.git` path components. Do not expand patterns outside the main checkout.
- Resolve the checkout and worktree roots to canonical paths. Validate every matched source and destination against its corresponding root. Reject symlink entries and symlink components below either root, including destination parents, and reject special files. Never copy or overwrite the worktree's `.git` pointer or repository metadata.
- Validate the complete copy plan before writing, then enforce containment again when opening sources and destinations so replacing a checked directory with a symlink cannot bypass validation. Fail closed if the platform cannot safely perform the operation.
- These checks apply before setup-script approval and to per-user copy overrides. Script approval cannot relax them.

**Run script:** a Run tab starts/stops the repo's `run` script in its own tmux session, so the user can start the workspace's dev server.

**Environment:** setup, run, archive, and agent processes all receive `ENSEMBLE_WORKSPACE_NAME`, `ENSEMBLE_WORKSPACE_PATH`, `ENSEMBLE_ROOT_PATH` (main checkout), and `ENSEMBLE_PORT`.

**Archive:**

1. Inspect tracked modifications, untracked files, and **ignored files**, including the copy manifest, before any cleanup script runs. Show what will be removed and obtain archive confirmation. Do not infer safety from a clean `git status`: ordinary `git worktree remove` can delete ignored files such as `.env` without `--force`.
2. Lock workspace lifecycle actions and stop its agent, setup, and run processes. Recheck the inventory after processes stop. Refuse removal of tracked modifications or non-ignored untracked files unless the user explicitly confirms their force removal. Separately require preservation or explicit discard approval for ignored files; generic archive or force confirmation is not sufficient for them.
3. Preserve files the user wants to keep outside the worktree under the private archive recovery directory, with a manifest and a documented restore path. This applies to copied configuration and other ignored local data. Allow explicitly approved discard groups for reproducible files such as dependencies. Complete and verify preservation before proceeding; copying or preservation must never follow links outside the worktree.
4. Run the currently approved optional `archive` script only after the preflight and preservation succeed. If it fails, keep the worktree and report the error; do not proceed automatically to removal.
5. Rescan before `git worktree remove`. New or changed files not covered by the preservation/discard decision require another decision. Use force only for the explicitly approved dirty state, and leave the worktree intact on an unresolved preservation or removal error. Mark it archived only after successful removal.
6. Keep the branch by default (offer to delete it), retain recovery files until the user explicitly deletes them, and keep session history and events in the DB.

**Reconcile on startup:** run `git worktree prune`, compare against `git worktree list --porcelain`, and inspect tmux pane liveness and exit status. `remain-on-exit` means a tmux session can exist after its agent exits. Recover queued events per §5.3 before presenting current turn status; mark status stale or unknown if event continuity cannot be established. Mark missing worktrees and processes accordingly.

**Repo config:** `.ensemble.json` at the repo root, optionally committed:

```json
{
  "setup": "pnpm install",
  "run": "pnpm dev --port $ENSEMBLE_PORT",
  "archive": "",
  "copy": [".env", ".env.local"],
  "defaultAgent": "claude"
}
```

Per-user overrides for any of these live in app settings. If no config exists, offer to create one from the UI.

### 5.2 Agent sessions (tmux-backed)

Run every agent inside a **detached tmux session on a dedicated socket**. Then:

- sessions survive server restarts and browser disconnects;
- the user can attach from a real terminal (`tmux -L ensemble attach -t <name>`);
- the app never touches the user's own tmux config or sessions.

**Launching a session:**

- Use `tmux -L ensemble -f <bundled minimal tmux.conf> new-session -d -s ens-<sessionId> -c <worktree> -e KEY=VAL ... -- <node> <bundled-agent-launcher> <agent> <args>`. The launcher applies the final environment policy and starts the resolved official CLI with an argument array.
- The bundled conf should set mouse on, a large history limit, sensible window sizing for multiple clients, and `remain-on-exit` so exit status can be read.
- The `-e` variables include the per-session hook token and the `ENSEMBLE_*` variables, and the API-key variables are stripped per §2.1.
- Enforce environment filtering in the final agent launcher inside tmux, not just in the Node process that calls the tmux client. An existing tmux server can retain variables from an earlier launch. Reapply the subscription preflight and billing policy on resume, and test both fresh and already-running tmux servers.
- Pass the initial prompt as the CLI's positional argument (e.g. `claude "<prompt>"`, `codex "<prompt>"`), not by typing into the terminal.

**Browser terminal:** each open terminal tab spawns `tmux -L ensemble attach -t ens-<id>` through `node-pty` and streams it over a WebSocket to xterm.js. Handle resize. Multiple viewers are allowed.

**Quick reply:** a text box (important on mobile) sends input with `tmux send-keys -l` followed by Enter.

**Resume:**

- Once the process has exited, start a new tmux session with a new Ensemble process/session record, preserving a link to the previous record and its exact CLI conversation id.
- Claude: use `claude --resume <captured session id>`. Codex: use the verified equivalent, currently `codex resume <captured session id>`.
- Never silently use Claude `--continue`, Codex `--last`, or another "latest conversation" fallback: multiple sessions can share a workspace. If the id is missing, invalid, or unavailable, require the user to explicitly select a conversation through a supported CLI flow or provide its id, or choose to start a new conversation. Cancellation must leave the old record intact.
- Apply the same authentication checks and generated hook configuration as a new launch; do not reuse an exited process's Ensemble hook identity for the new process.

**Doctor page:** checks and reports the versions of git, tmux, claude, codex, and gh, plus `gh auth status`. It must **not** inspect credential files to determine whether the user is logged in. Report supported non-secret authentication-mode checks and limitations from §2.1; do not display raw auth output. Missing tmux disables session launch with an installation instruction. A version/help check is not proof that authentication or a live integration works.

### 5.3 Status detection and the tool-call event log (hooks, not screen-scraping)

**Claude Code:**

- Inject hooks per session without modifying the repo. Prefer generating a settings file at `~/.ensemble/sessions/<id>/claude-settings.json` and passing it with `--settings`, if that flag exists in the installed version.
- Otherwise, merge into the worktree's `.claude/settings.local.json` and ensure that file is git-excluded. Never clobber the user's existing settings.
- Register hooks for:
  - `SessionStart`: capture `session_id` and `transcript_path`.
  - `UserPromptSubmit`: set status to working.
  - `PreToolUse` and `PostToolUse`: write to the event log; set status to working.
  - `PermissionRequest`: mark the relevant tool permission request as needs_input immediately, without returning a permission decision. Keep `permission_prompt` notification support for prompts that do not emit this event.
  - `Notification`: inspect `notification_type`. Only supported attention-required types, such as `permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog`, and `agent_needs_input`, set needs_input. An `idle_prompt` reminder does not change an idle turn to needs_input. Authentication success, completion, and unknown notification types do not request attention.
  - `Stop`: set status to idle (turn complete).
  - `PostToolUseFailure`, `StopFailure`, and `SessionEnd`: record failures/endings and clear obsolete attention state as appropriate.
  - Any other events available that are useful.
- Verify each event's availability and schema against the installed CLI. Permission notifications can be delayed, so they are a fallback for immediate permission detection. Track outstanding input requests separately from unrelated tool activity; a concurrent tool event must not erase an unresolved permission request.

**Hook capture and delivery:** use a tiny bundled helper that accepts the hook's stdin JSON, wraps it in the event envelope from §4, and durably queues it under `~/.ensemble/sessions/<id>/` before attempting delivery to `http://127.0.0.1:<hook-port>/api/hooks/<sessionId>` with that session's hook token.

- Always exit 0 within a documented short time budget, including when the server is absent, storage fails, or input is malformed. Emit **no stdout or stderr** on success or failure; never return hook decision JSON or deny tool use. Disable ordinary HTTP retries in the hook process; queued replay handles retries separately.
- Explicitly discard HTTP response bodies and subprocess output. `curl -s` only suppresses progress/error output and still prints response bodies; `|| true` changes the exit code but does not make stdout safe. If curl is used internally, route its body to `/dev/null` and suppress stderr as well. A server error or JSON response must never enter the agent's hook output.
- Give events stable ids and a per-session source sequence. Support concurrent hook writers without partial records or sequence collisions; bound lock waits, payload sizes, and total spool bytes. Preserve event identity/type when truncating oversized payloads and mark the truncation.
- Acknowledge HTTP delivery only after the event is committed to SQLite. Remove a queued record only after durable acknowledgement. The server also drains the local spool at startup and while running, so recovery does not depend on another agent event firing. Retrying after a crash between commit and acknowledgement must not create duplicate timeline entries.
- Apply recovered events in source order and do not allow late duplicates or older events to overwrite newer status. Reconstruct the final status before notifying the browser; do not emit a burst of obsolete needs-input/turn-complete notifications during replay.
- Bound disk usage. On overflow, corruption, or capture failure, keep the agent running and expose a delivery-gap diagnostic when recoverable. Never claim complete history or current turn status when continuity is uncertain; mark freshness stale/unknown and reconcile through supported CLI signals or explicitly supported transcript recovery. No finite spool can guarantee every event during unbounded downtime or storage failure.
- Clearing events must also invalidate/delete pending events for that history, using a persisted cutoff or generation, so a delayed POST or spool replay cannot restore cleared payloads. Preserve only the minimal non-payload state needed for session status and replay deduplication.

**Codex:**

- Use the best mechanism the installed version offers. Current official documentation includes lifecycle hooks; verify their event schemas, injection mechanism, and trust flow before relying on them. New or changed non-managed hooks require explicit trust of their definition. Do not bypass hook trust globally to make integration work.
- If hooks are unavailable or untrusted, use a verified fallback such as the `notify` program (e.g. via `-c` config overrides) for turn-complete events. Document that `notify` alone does not provide a full tool or permission event stream.
- Where Codex exposes no signal, fall back to heuristics: output activity via tmux, plus process liveness.
- Document Codex's limitations clearly. Needs-input detection may be best-effort.

**Event log UI:** a per-session timeline (tool name, short summary, expandable raw JSON) with filters and **export as JSONL**. Payloads may contain secrets, so persist them locally with private permissions and never upload them to third-party services or telemetry. Access is through the authenticated UI and user-requested exports. Offer a "clear events" action that also clears queued history as above. Add a configurable per-payload size cap, total spool limit, and visible truncation/gap markers in the UI and export.

**Notifications:** browser notifications when a session needs input or finishes a turn, plus a needs-attention count in the tab title/favicon.

### 5.4 Remote Control toggle (Claude only)

- Add a per-session toggle at launch, plus a global default in settings.
- When on, launch with Claude Code's `--remote-control "<repo>/<workspace>"` flag so the session also appears in claude.ai/code and the Claude mobile app.
- An **"Enable now"** action on a running Claude session sends `/remote-control` via `tmux send-keys`.
- Show a short note in the UI that the transcript is synced to Anthropic while Remote Control is connected.
- Disable the toggle for Codex sessions.

### 5.5 Diff review

- Show the diff of the workspace against the merge-base with its base branch. It must include committed, uncommitted, and **untracked** changes (list untracked files with `git ls-files --others --exclude-standard`). Never modify the user's index to produce the diff.
- Provide a file list with +/− counts and a unified/split toggle.
- Auto-refresh on file changes (debounced) and on `Stop` hooks.
- **Comment to agent:** select lines, write a comment, and send it to a chosen session as a prompt formatted like `In path/to/file.ts lines 10–14: <comment>`.

### 5.6 GitHub PR flow (via the user's `gh` CLI)

- Detect `gh` and its auth status. Never handle GitHub tokens directly.
- Workspace actions:
  - **Push.**
  - **Create PR:** a form with title/body, plus an option to ask the agent to draft the description, which sends a prompt to a session.
  - **View PR:** state, checks, review decision, and URL from `gh pr view --json ...`. Poll every ~60s while a PR is open.
  - **Merge:** squash/merge/rebase with confirmation, then offer to archive the workspace.

### 5.7 UI

- **Left sidebar:** repos, then workspaces under each repo. Each workspace shows its branch/PR title, status badges (working spinner, needs-input dot, idle, error), and a PR badge.
- **Main area (per workspace):** tabs for each agent session terminal, Run, Setup log, Diff, Events, and PR.
- **New workspace dialog:** opened with ⌘N, with an agent picker, base branch, initial prompt, and Remote Control toggle.
- **Mobile layout:** usable at phone width for access over Tailscale. Collapsible sidebar, readable terminal, and a prominent quick-reply box.
- Keep it clean and fast. Dark mode follows the system setting.

---

## 6. Engineering standards

- Small, logical commits with conventional-commit messages. Keep the app working at each milestone.
- **Never call the real `claude` or `codex` CLIs in automated tests.** Build a fake agent fixture (e.g. `test/fixtures/fake-agent.mjs`) that behaves like an interactive CLI and fires the same hook payloads.
- **Unit tests:** config parsing, name/branch sanitization, copy-path containment, port allocation, authentication-mode classification, notification-type mapping, hook envelope/sequence handling, and diff assembly. Use fixtures for status-command output; never use real credentials.
- **Integration tests:** temp git repos for worktree create/archive/reconcile, and tmux session lifecycle using the fake agent. Cover ignored `.env` preservation, archive-script failure, source/destination symlink escapes and replacement races, subscription preflight refusal, retained tmux environments, exact-id resume with multiple conversations, dead panes retained by tmux, hook replay/deduplication/order, spool limits, and cleared-history replay rejection. Check zero hook stdout/stderr for success, HTTP error, timeout, malformed input, and storage failure. Test the loopback hook listener with both local and non-loopback UI bindings.
- **CI:** GitHub Actions on `macos-latest` running typecheck, lint, and tests.
- **Docs:**
  - `README.md`: what it is; requirements (macOS, Node 22+, git, tmux, claude/codex CLIs logged in, optional gh); quickstart; security model; and the subscription/credentials stance from §2.1 in plain language.
  - `docs/architecture.md`: the architecture.
  - `docs/cli-notes.md`: verified CLI flags.
  - `LICENSE`: MIT.

---

## 7. Working process — follow this order

1. **Verify before designing.** CLI flags change frequently, so do not trust this document's flag names blindly. Run `claude --help`, `codex --help`, `tmux -V`, `gh --version`, and `git --version`, and check the official Claude Code docs (hooks, settings, `--settings`, `--resume`, Remote Control) and the Codex docs (resume, notify/hooks, config overrides). Verify that proposed authentication-status interfaces expose only safe metadata before invoking them; never inspect credential files. Record versions, date, official sources, limitations, missing dependencies, and anything that differs from this spec in `docs/cli-notes.md`. Help output and documented behavior must be distinguished from runtime-tested behavior.
2. **Plan.** Write `docs/architecture.md`: components, data model, API routes, WebSocket protocol, tmux/hook design, security model, and milestone plan. **Stop and ask me to review the plan, and ask me for the GitHub repo name and whether it should be public or private.** Do not write application code before I approve.
3. **Milestones.** After approval, build in this order. Each milestone ends with passing tests, a commit, and a push.
   - **M0:** scaffold, tooling, CI, README skeleton, `gh repo create`, first push.
   - **M1:** repos and workspaces (worktree create/list/archive/reconcile), copy containment, archive preservation, `.ensemble.json` + script trust approval, setup scripts, port allocation, basic sidebar UI.
   - **M2:** tmux-backed agent sessions, subscription preflight and environment filtering, browser terminal, initial prompt, quick reply, exact-id resume, doctor page. **Pause here so I can try it.**
   - **M3:** loopback hook listener, bounded durable capture and replay → live status, event log + JSONL export, browser notifications.
   - **M4:** diff viewer + comment-to-agent, Run tab.
   - **M5:** GitHub PR flow.
   - **M6:** Remote Control toggle, `--host` binding hardening, mobile layout.
   - **M7:** polish, docs, final pass against the acceptance checklist below.
4. When something in this spec turns out to be impossible or a bad idea, say so and propose an alternative. Don't silently deviate.

---

## 8. Acceptance checklist (v1 is done when all pass)

- [ ] Add a repo; create three workspaces (two Claude, one Codex) with initial prompts. All three run concurrently in separate worktrees without file conflicts.
- [ ] The sidebar shows correct live status, including **needs input** when Claude asks for a permission.
- [ ] Authentication-success, idle-reminder, completion, and unknown notifications do not falsely mark needs_input. Supported permission-request events update immediately; delayed notifications remain a fallback.
- [ ] Kill and restart the server: sessions are still running and the UI reattaches. `tmux -L ensemble attach` works from a real terminal.
- [ ] Tool and `Stop` events captured during server downtime replay once, in order, without stale status or obsolete browser alerts. Overflow/corruption produces visible gaps and uncertain status. Clearing events prevents delayed payloads from reappearing.
- [ ] Each workspace's setup script ran, `.env` was copied, and each got a unique `ENSEMBLE_PORT`.
- [ ] Copy patterns and source/destination symlinks cannot escape their roots or overwrite Git metadata, including when paths are replaced during copying.
- [ ] The diff view shows committed, uncommitted, and new files. A line comment reaches the agent.
- [ ] A PR is created, its status/checks show, it's merged from the UI, and the workspace is archived cleanly.
- [ ] Archiving a Git-clean workspace containing a modified ignored `.env` preserves it outside the worktree or requires explicit discard approval. Cleanup never precedes preflight/preservation; script failure and newly discovered unpreserved files stop removal.
- [ ] With two conversations in one workspace, Resume selects the requested conversation by id. Missing/stale ids require user selection or a new-session choice and never fall back to the most recent conversation.
- [ ] A Claude session launched with Remote Control appears in the Claude mobile app.
- [ ] Under healthy storage and within configured spool limits, the event log records every tool event exposed by the verified Claude hooks and exports valid JSONL. Truncation and delivery gaps are explicit; unsupported CLI events are documented.
- [ ] Hook helpers exit 0 within their time budget with empty stdout/stderr for successful, error, and failed deliveries, malformed input, and storage failures.
- [ ] The UI works from a phone over Tailscale with `--host`, requests without the proper auth are rejected, and hooks still reach their authenticated loopback listener before and after server restarts.
- [ ] The CI credential-path check passes, and the fake agent receives no API-key environment variables by default, including when tmux was already running with conflicting variables. Saved API-key/helper/unknown auth fixtures cannot pass the default subscription preflight; explicit opt-ins remain visibly unverified or in API mode as appropriate.
- [ ] README quickstart works on a fresh Mac.
