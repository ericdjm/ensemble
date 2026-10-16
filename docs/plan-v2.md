# Plan v2: terminal-first sessions, in-place workspaces, handoffs

Agreed with the owner on October 15, 2026 after v1 (M0–M7) shipped. Build in order; each phase ends with tests, a commit, and a push, as in v1.

**Status: all four phases shipped on October 15, 2026.** Remaining owner-only checks are listed in `docs/acceptance.md` (a real `claude attach` through Ensemble, a real handoff between two live subscription sessions, Remote Control on the phone, a real Codex session, a real PR).

## Decisions and pushback already settled

- Ensemble does not adopt arbitrary foreground sessions started in another terminal. They cannot be moved into tmux and hooks cannot be injected after launch. Instead Ensemble becomes the launcher you call from the terminal (Phase 1).
- In-place workspaces (the checkout itself, no worktree) are supported for one agent, with a first-time warning that two agents in one checkout will conflict. Worktrees remain the default for additional agents.
- Agent-to-agent communication is human-mediated handoffs. No autonomous orchestrator. A bounded relay (max N rounds) is allowed only as an explicit opt-in, off by default.
- Usage/cost dashboards stay out of scope.

## Phase 1: terminal-first launching and in-place workspaces (~1 day) — done October 15, 2026

Implemented as described below; see `docs/architecture.md` §6.4a and `docs/acceptance.md` ("Plan v2 Phase 1"). Deviations: the CLI finds the server through `~/.ensemble/server.json` (host, port, tmux socket) rather than a fixed port; auto-detach on agent exit uses a tmux `pane-died` hook scoped to the caller's tty; `--help`/`--version` pass straight through to the real binary.

- CLI: `ensemble claude [args...]` and `ensemble codex [args...]`, run from any directory.
  - Finds the git top level; registers the repo if unknown (existing `registerRepo`).
  - Creates (or reuses) an in-place workspace: `path` = checkout, `branch` = current branch, new workspace kind `inplace` (schema migration: `workspaces.kind TEXT NOT NULL DEFAULT 'worktree'`). No copy, no setup script, no port use beyond allocation.
  - Launches through the existing `SessionService.launch` (tmux, launcher, preflight, hooks), passing through user args as extra CLI options (validated: no `-p`/`--print`/`exec`).
  - Attaches the caller's terminal with `tmux -L ensemble attach -t ens-<id>` so typing happens in the user's own terminal; the browser shows the same session. Detaching leaves it running.
  - Requires the server; if `/api/health` on the configured port is unreachable, print how to start it and exit 1. The CLI authenticates to the local API with the token from `~/.ensemble/config.json` (same user, same file; never printed).
  - Alias support: `alias claude='ensemble claude'`; the launcher resolves the real binary from the login-shell PATH with the alias ignored (`command -v` already ignores aliases) and sets `ENSEMBLE_INSIDE=1` to prevent recursion.
- Archive for `inplace` = forget the record and stop sessions; never removes files; the archive dialog says so.
- UI: sidebar shows in-place workspaces with a "checkout" marker; new-session warning covers the shared-checkout case.
- Tests: CLI against a fake server? Prefer testing the service pieces (in-place workspace creation, arg validation, attach command construction) plus one integration test that runs `bin/ensemble.js claude` with the fake agent against a test app.

## Phase 2: handoffs between sessions (~1–2 days; one owner check) — done October 15, 2026

Implemented as described below; see `docs/architecture.md` §7.7 and `docs/acceptance.md` ("Plan v2 Phase 2"). The Claude `Stop` payload on 2.1.300 carries `last_assistant_message` (verified with one real two-line prompt, which also proved bracketed-paste delivery); the transcript fallback stays as a labelled best-effort path. The relay's "round" is one hop; the done marker defaults to `RELAY_DONE`; both sessions must be idle at each hop.

- Capture "last answer" per session: Codex `notify` already carries `last-assistant-message`. For Claude, check whether the `Stop` hook payload includes the last assistant message on the installed version; if not, read the tail of the transcript (`transcript_path` from `SessionStart`, read-only, unstable format) and extract the last assistant text. Needs one real prompt on the owner's subscription to verify; ask first.
- Store `last_answer` (capped, e.g. 16 KiB) on the session row; broadcast on change.
- UI: "Last answer" panel per session; "Send to…" with session picker and templates (review this / implement this / summarize for the other agent / free text). Delivered via quick reply as `From <agent> in <workspace>: …`.
- "Ask all": broadcast one prompt to all running sessions in a workspace.
- Bounded relay (opt-in, off by default): two sessions, max rounds, each hop logged as an `ensemble.relay` event; stops at the limit or when a reply contains a configurable done marker.

## Phase 3 (optional): adopt Claude background sessions (~0.5 day) — done October 15, 2026

Implemented as described below; see `docs/architecture.md` §7.8. `claude agents --json --all` was verified on the installed 2.1.300 (it also lists interactive sessions, which stay non-adoptable). A real `claude attach` through Ensemble has not been run; it is an owner check in `docs/acceptance.md`.

- `claude agents --json` to list `--bg` sessions; open a terminal by running `claude attach <id>` inside an Ensemble-owned tmux session. Status from the JSON and transcript, not hooks (weaker needs-input). Claude only. Skip unless the owner uses `--bg`.

## Phase 4: small admin wins (~0.5 day) — done October 15, 2026

Implemented as described below; see `docs/architecture.md` §7.9.

- Session labels and notes, pin to top, per-workspace activity strip with each agent's latest answer side by side.

## Not planned

Adopting arbitrary foreground sessions; autonomous multi-agent orchestration; usage/cost dashboards.
