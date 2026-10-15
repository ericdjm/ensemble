# Ensemble

A local web app for macOS that runs multiple coding-agent sessions (Claude Code and Codex) in parallel, each in its own isolated git worktree, with a browser UI to monitor, steer, review, and ship their work. A self-hosted alternative to Conductor.

**Status:** under construction. See [docs/architecture.md](docs/architecture.md) for the plan and milestones, and [docs/cli-notes.md](docs/cli-notes.md) for what has been verified against the installed CLIs.

## Requirements

- macOS
- Node.js 22+ and pnpm (`corepack enable`)
- git
- tmux (`brew install tmux`)
- The `claude` and/or `codex` CLI, installed and logged in with your own subscription
- Optional: `gh` (GitHub CLI), logged in, for the pull-request flow

## Quickstart

```sh
pnpm install
pnpm start
```

`pnpm start` builds if needed, starts the server on `127.0.0.1:4800`, and prints a login URL containing your access token (stored in `~/.ensemble/config.json`, mode 0600). `ensemble token` prints it again; `ensemble token --rotate` replaces it.

Then: add a repo, create a workspace (⌘N), and start a session. Agents run inside a dedicated tmux server, so you can also attach from any terminal:

```sh
tmux -L ensemble attach -t ens-<session-id-prefix>
```

The Doctor page (top of the sidebar) shows which binaries were found, whether `gh` is logged in, and the state of the loopback hook listener. A version check only proves a binary runs; it does not prove that it is logged in.

Status: milestones M0–M2 are implemented (repos, workspaces, archive, tmux-backed sessions with subscription preflight, terminal, resume, doctor). Live tool-event status, diff review, the PR flow, Remote Control polish and the mobile layout follow in M3–M7.

## Your subscription and credentials

Ensemble behaves like a terminal multiplexer. It launches your own installed `claude` and `codex` binaries interactively, inside tmux, using the CLIs' own login. It never reads, copies, stores, or proxies your credentials or tokens, never implements a login flow of its own, and never uses headless or SDK modes. By default it removes API-key environment variables from agent sessions and, inside the session itself, asks the CLI for its non-secret authentication mode (`claude auth status --json`) before starting it. If the mode is not a subscription login the launch is refused with the reason shown in the terminal. An opt-in in Settings allows API-key billing with a visible warning; unverified modes additionally need a per-session acknowledgement and are never labelled subscription-verified. Codex launches stay refused until its status output has been verified (see docs/cli-notes.md). An automated check in CI fails if the source code ever references the CLIs' credential files.

## Security model

The server can spawn shells, so treat it as remote code execution if exposed. It binds to localhost by default, always requires an access token (exchanged for an `HttpOnly`, `SameSite=Strict` cookie), validates `Host` and `Origin` headers, and runs repository setup/run/archive scripts only after you have reviewed and approved them. Hook events from agents arrive on a separate loopback-only listener with per-session tokens. Details are in [docs/architecture.md](docs/architecture.md#9-security-model-summary-of-enforcement-points).

## License

MIT
