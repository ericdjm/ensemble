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

`pnpm start` builds if needed, starts the server on `127.0.0.1:4800`, and prints a login URL containing a one-time access token.

## Your subscription and credentials

Ensemble behaves like a terminal multiplexer. It launches your own installed `claude` and `codex` binaries interactively, inside tmux, using the CLIs' own login. It never reads, copies, stores, or proxies your credentials or tokens, never implements a login flow of its own, and never uses headless or SDK modes. By default it removes API-key environment variables from agent sessions and refuses to launch unless the CLI reports a subscription login, so you are not billed through an API key by accident. An automated check in CI fails if the source code ever references the CLIs' credential files.

## Security model

The server can spawn shells, so treat it as remote code execution if exposed. It binds to localhost by default, always requires an access token (exchanged for an `HttpOnly`, `SameSite=Strict` cookie), validates `Host` and `Origin` headers, and runs repository setup/run/archive scripts only after you have reviewed and approved them. Hook events from agents arrive on a separate loopback-only listener with per-session tokens. Details are in [docs/architecture.md](docs/architecture.md#9-security-model-summary-of-enforcement-points).

## License

MIT
