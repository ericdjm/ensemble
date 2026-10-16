# Ensemble

A local web app for macOS that runs multiple coding-agent sessions (Claude Code and Codex) in parallel, each in its own isolated git worktree, with a browser UI to monitor, steer, review, and ship their work. A self-hosted alternative to Conductor.

**Status:** v1 feature-complete per the build spec. See [docs/architecture.md](docs/architecture.md) for the design, [docs/cli-notes.md](docs/cli-notes.md) for what was verified against the installed CLIs, and [docs/acceptance.md](docs/acceptance.md) for which acceptance items are verified automatically, by hand, or still need you.

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

Then: add a repo, create a workspace (⌘N), and start a session, or run `ensemble claude` inside a checkout (see below). Agents run inside a dedicated tmux server, so you can also attach from any terminal:

```sh
tmux -L ensemble attach -t ens-<session-id-prefix>
```

The Doctor page (top of the sidebar) shows which binaries were found, whether `gh` is logged in, and the state of the loopback hook listener. A version check only proves a binary runs; it does not prove that it is logged in.

## Launching from your own terminal

You do not have to start sessions from the browser. In any checkout:

```sh
ensemble claude            # or: ensemble codex
ensemble claude --model opus "fix the failing test"
```

This starts the real `claude`/`codex` binary in your current checkout (an "in-place" workspace, marked **checkout** in the sidebar: no worktree, no copy, no setup script) through the same tmux, preflight, and hook path as a browser-started session, then attaches your terminal to it. You type in your own terminal; the browser shows the same session, its status, and its events. `Ctrl-b d` detaches and leaves the session running; when the agent exits, your terminal returns on its own with the agent's exit code. The server must be running (`ensemble start` in another terminal) and the command needs an interactive terminal.

Arguments after `claude`/`codex` go to the CLI unchanged, except that non-interactive forms (`-p`/`--print`, `codex exec`, `login`, ...) and Ensemble's own flags (`--settings`, `--remote-control`) are rejected; run the binary directly for those. `--help` and `--version` run the binary directly without a session. A convenient setup is

```sh
alias claude='ensemble claude'
alias codex='ensemble codex'
```

Inside a session `ENSEMBLE_INSIDE=1` is set, so the alias cannot recurse, and the real binary is resolved from your login-shell `PATH` with aliases ignored. One agent per checkout is the intended use: a second `ensemble claude` in the same checkout gets a warning in the browser, because two agents editing the same files conflict; use a workspace (⌘N) for the second one. "Forget" on an in-place workspace stops its sessions and drops the record; it never removes files.

## Handoffs between sessions

Agents do not talk to each other on their own. Ensemble captures each session's **last answer** (from the Claude Code `Stop` hook's `last_assistant_message`, or Codex's `notify` message; the transcript file is only a fallback) and shows it under the terminal. From there:

- **Send to…** delivers it to any other running session as a prompt prefixed with `From <agent> in <repo>/<workspace> (Ensemble handoff):`, with templates (review this, implement this, summarize, free text) you can edit before sending. Multi-line text is pasted through tmux with bracketed paste, so it arrives as one prompt.
- **Ask all** sends one prompt to every running session in a workspace.
- **Relay with…** (off by default; enable in Settings) starts a bounded exchange between two idle sessions: each finished answer is sent to the other, for at most N hops, until an answer contains a done marker, or until you stop it. Every hop is an `ensemble.relay` event in both sessions' logs. Nothing resumes after a server restart.

Handoffs and relays are typed into the receiving CLI exactly as if you had pasted them; they cannot answer permission prompts, and a busy target simply queues the text as its next prompt.

## Your subscription and credentials

Ensemble behaves like a terminal multiplexer. It launches your own installed `claude` and `codex` binaries interactively, inside tmux, using the CLIs' own login. It never reads, copies, stores, or proxies your credentials or tokens, never implements a login flow of its own, and never uses headless or SDK modes. By default it removes API-key environment variables from agent sessions and, inside the session itself, asks the CLI for its non-secret authentication mode (`claude auth status --json`) before starting it. If the mode is not a subscription login the launch is refused with the reason shown in the terminal. An opt-in in Settings allows API-key billing with a visible warning; unverified modes additionally need a per-session acknowledgement and are never labelled subscription-verified. For Codex the same check uses `codex login status`; only a ChatGPT login counts as a subscription. An automated check in CI fails if the source code ever references the CLIs' credential files.

## Status detection and the event log

Ensemble never screen-scrapes the terminal. Claude Code sessions get a per-session settings file (passed with `--settings`) that registers a tiny silent hook helper for the lifecycle events Claude Code exposes. Each hook event is written to a private per-session spool on disk first and then delivered to a loopback-only listener, so events survive server restarts and are replayed once, in order. Every event is in the Events tab with its raw payload and can be exported as JSONL. Payloads can contain secrets; they stay on your disk with private permissions and are never uploaded anywhere.

Claude Code holds back hooks until you accept its workspace-trust prompt in the terminal for a new worktree. Until then the session shows no events; accept the prompt and status starts flowing.

**Codex limitations.** Codex's lifecycle hooks are injected with `-c` config overrides and must be trusted once through Codex's own `/hooks` command; Ensemble never bypasses that trust. Until trusted, only the `notify` fallback reports turn completion, so tool activity and permission prompts are not visible and needs-input detection is best-effort. The `-c` hook injection has not yet been verified against the installed Codex binary.

## Phone access over Tailscale

Bind the UI to your Tailscale address instead of loopback:

```sh
pnpm start -- --host 100.x.y.z
```

Only `127.0.0.1`, `localhost`, and the literal `--host` value (plus any `allowedHosts` entries in `~/.ensemble/config.json`, for a MagicDNS name) are accepted as the `Host` header; everything else gets a 421. The access token is still required, and the hook listener stays on `127.0.0.1` regardless of `--host`. Do not bind to `0.0.0.0`: the allowlist cannot know every interface, and anyone who reaches the port with the token can run commands as you.

The layout works at phone width: the sidebar becomes a drawer, the terminal fits the screen, and the quick-reply box stays at the bottom.

## Security model

The server can spawn shells, so treat it as remote code execution if exposed. It binds to localhost by default, always requires an access token (exchanged for an `HttpOnly`, `SameSite=Strict` cookie), validates `Host` and `Origin` headers, and runs repository setup/run/archive scripts only after you have reviewed and approved them. Hook events from agents arrive on a separate loopback-only listener with per-session tokens. Details are in [docs/architecture.md](docs/architecture.md#9-security-model-summary-of-enforcement-points).

## License

MIT
