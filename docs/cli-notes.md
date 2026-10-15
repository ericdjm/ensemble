# CLI verification notes

Reviewed October 14, 2026 (America/Los_Angeles); re-verified and corrected later the same day. These notes distinguish **runtime-tested** behavior (run on this machine), **help-verified** behavior (seen in `--help` output), and **documented** behavior (official docs, not executed). The repository has no application code, package manifest, test suite, or runnable build yet.

## Local tools

| Tool        | Version                  | Resolved from                                                                                                                                     | Verification                                                                                                                           |
| ----------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `2.1.300`                | `~/.local/bin/claude` (login-shell PATH)                                                                                                          | `claude --version`, `claude --help`, `claude auth status --help`                                                                       |
| Codex CLI   | `0.160.1`                | **Not on the login-shell PATH.** Present only inside the ChatGPT app bundle at `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex` | `codex --version`, `codex --help`, `codex resume --help`, `codex login --help`, `codex login status --help` run via that absolute path |
| tmux        | `3.8`                    | `/opt/homebrew/bin/tmux`                                                                                                                          | Installed with `brew install tmux` during this review; runtime probe below                                                             |
| GitHub CLI  | `2.86.0`                 | `/opt/homebrew/bin/gh`                                                                                                                            | `gh --version`; GitHub authentication was not checked                                                                                  |
| Git         | `2.54.0 (Apple Git-157)` | `/usr/bin/git`                                                                                                                                    | `git --version` and an isolated temporary-repository probe                                                                             |
| Node.js     | `v22.23.2`               | nvm                                                                                                                                               | `node --version`                                                                                                                       |
| pnpm        | `12.11.2`                | Corepack shim in the nvm bin directory                                                                                                            | `corepack enable` run during this review; `pnpm --version`                                                                             |

Implications:

- Ensemble must resolve CLIs from the user's login-shell `PATH` at runtime and support a per-CLI path override in settings. On this machine Codex is only reachable through the override. The Doctor page must report "not on PATH" rather than "not installed" when the override finds it.
- Do not hardcode any of the paths above.

## Flags and interfaces confirmed by help output

| Interface               | Confirmed syntax                                                               | Verification level and limits                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude initial prompt   | `claude [options] [command] [prompt]`                                          | Help only; no agent session launched                                                                                                                        |
| Claude extra settings   | `--settings <file-or-json>`                                                    | Help + docs: values override the same keys in settings files for the session; file must be a regular file ≤ 2 MiB. Hook delivery through it is untested     |
| Claude resume           | `-r, --resume [value]`                                                         | Help + docs: by id or name; with an id the search covers the current project, its git worktrees, then every other project. Shared-workspace resume untested |
| Claude continue         | `-c, --continue`                                                               | Latest conversation in the directory; unsuitable as an automatic fallback                                                                                   |
| Claude Remote Control   | `--remote-control [name]`, `--rc`                                              | Help only; see eligibility notes below                                                                                                                      |
| Claude auth status      | `claude auth status` with `--json` (default) or `--text`                       | Help + docs; see "Authentication" below. **Not executed**                                                                                                   |
| Codex initial prompt    | `codex [OPTIONS] [PROMPT]`                                                     | Help only                                                                                                                                                   |
| Codex resume            | `codex resume [OPTIONS] [SESSION_ID] [PROMPT]`; `--last` picks the most recent | Help only; `--last` must never be an automatic fallback                                                                                                     |
| Codex config override   | `-c, --config <key=value>` with dotted nested keys, TOML values                | Help + docs; hook/notify injection via `-c` untested                                                                                                        |
| Codex login status      | `codex login status [OPTIONS]` (accepts `-c`)                                  | Help only; **output format unknown**; not executed                                                                                                          |
| Codex hook trust bypass | `--dangerously-bypass-hook-trust`                                              | Exists; the spec forbids using it                                                                                                                           |

The review did not run either CLI's authentication-status command, inspect credential files, invoke credential helpers, or launch billable agent sessions.

## Runtime-tested: tmux 3.8 probe

Run on a disposable socket (`tmux -L ensemble-probe`) with a bundled-style config (`mouse on`, `history-limit 50000`, `remain-on-exit on`, `window-size latest`, `aggressive-resize on`, `status off`, `escape-time 0`, `exit-unattached off`, `exit-empty on`). Probe scripts only dumped a dummy variable; nothing outside the scratch directory was touched. The probe server was killed afterwards.

| Case                                                                                    | Result                                                                                                                  |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Server started by a client whose env contained `PROBE_SECRET`; `new-session -e ENS_A=1` | Pane env had both `ENS_A` and `PROBE_SECRET`                                                                            |
| Second `new-session` from a client **without** `PROBE_SECRET` (via `env -u`)            | Pane env **still had `PROBE_SECRET`**, inherited from the server's global environment (`show-environment -g` confirmed) |
| `new-session -- /usr/bin/env -u PROBE_SECRET <cmd>`                                     | Pane env did not have it                                                                                                |
| Processes exiting 7, 0, 3 with `remain-on-exit on`                                      | `list-panes -a -F '#{pane_dead} #{pane_dead_status}'` reported `1 7`, `1 0`, `1 3`; sessions persisted                  |
| `send-keys -t p4 -l -- 'hello world'` then `send-keys Enter`                            | Process read `hello world`                                                                                              |
| `new-session -x 120 -y 30`                                                              | Window reported 120×30; default is 80×24                                                                                |

Conclusions: environment filtering **must** happen at the final command boundary inside the pane (the bundled launcher), exactly as the spec requires; filtering only the client that calls `tmux` is insufficient once a server exists. Exit codes of dead panes are readable for reconcile.

## Official documentation findings

### Authentication and billing

**Claude.** The CLI reference documents `claude auth status` as JSON output with an `authMethod` field whose value is one of `none`, `claude.ai`, `oauth_token`, `api_key`, `api_key_helper`, or `third_party`, plus `configDirectory` (v2.1.268+). Exit code is 0 when logged in, 1 otherwise. This is the non-secret metadata interface §2.1 requires. Remaining risk: the full field list is not documented, so Ensemble must parse only the named fields, cap captured output, discard the rest, and never log raw output. Classification of `oauth_token` (a `claude setup-token` login, which requires a subscription) is an owner decision recorded in `docs/architecture.md` §11. Source: [CLI reference](https://code.claude.com/docs/en/cli-reference).

The Remote Control page confirms that `ANTHROPIC_BASE_URL` pointing away from `api.anthropic.com` and enterprise gateways disable Remote Control, and that API keys are not supported for it. Removing the three environment variables named in the spec cannot by itself establish the effective authentication mode; `apiKeyHelper` in user settings is reported by `authMethod: api_key_helper`. Source: [Remote Control](https://code.claude.com/docs/en/remote-control).

**Codex.** OpenAI distinguishes ChatGPT-account authentication from API-key authentication, and the non-interactive page states that `codex exec` reuses saved CLI authentication by default. Interactive versus non-interactive execution is therefore not a billing-mode test; the interactive-only rule is a product constraint. The same page documents `codex exec resume --last` and `codex exec resume <SESSION_ID>`. `codex login status` exists, but nothing documents its output; until someone runs it by hand and records the field names here, the Codex preflight returns `unknown` and launches are refused by default. Sources: [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [authentication](https://learn.chatgpt.com/docs/auth).

Note on URLs: `https://developers.openai.com/codex/...` returns a 308 redirect to `https://learn.chatgpt.com/docs/...`, so the `learn.chatgpt.com` links are the current official location.

### Claude hooks and status

- Events confirmed to exist: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `Elicitation`, `ElicitationResult`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `SessionEnd`, among others. `SessionStart` input includes `session_id` and `transcript_path`. `SessionEnd` matchers: `clear`, `resume`, `logout`, `prompt_input_exit`, `other`.
- `Notification` matcher values: `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`, `elicitation_url_dialog`, `elicitation_complete`, `elicitation_response`, `agent_needs_input`, `agent_completed`, `quota_auto_resume_fired`, `quota_auto_resume_stale`, `quota_auto_resume_disabled`. Only the attention types map to needs_input. Exit code and stderr are ignored for this event.
- `permission_prompt` fires once the prompt has waited about six seconds; each keystroke defers it. `PermissionRequest` fires immediately but **not** for a sandboxed command's network request, so the delayed notification is a required fallback, not an optional one.
- `PermissionRequest` input has `tool_name`, `tool_input`, optional `permission_suggestions`, no `tool_use_id`. A hook that returns no `decision` leaves the interactive permission flow unchanged. (In sessions that cannot show a prompt, no decision means deny; Ensemble only runs interactive sessions.)
- `PostToolUseFailure` adds `error`, optional `is_interrupt`, optional `duration_ms`, and `tool_use_id`.
- Hook stdout: for most events it goes to the debug log only; for `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart`, and `PostModelSwitch` plain-text stdout becomes model-visible context. A passive collector must therefore emit nothing on any path.
- Default command-hook timeout is 600 s for most events (30 s for `UserPromptSubmit`); Ensemble sets `timeout: 5` explicitly.
- **Workspace trust gates hooks.** In an interactive session, hooks from every settings file are held back until the user accepts the workspace trust dialog for the folder or a parent whose trust extends to it. Every Ensemble worktree is a new folder. Whether hooks supplied via `--settings` are also held back is not stated and must be checked in the M2 manual test. Source: [hooks reference](https://code.claude.com/docs/en/hooks).

### Remote Control

Available on Pro, Max, Team, and Enterprise; API keys unsupported; Team/Enterprise need an admin toggle. With an ineligible login, `claude --remote-control` still starts an interactive session and shows a failure notification shortly after launch, so failure cannot be detected from the exit code. `claude doctor` prints read-only diagnostics including Remote Control eligibility and is suitable for the Doctor page. Source: [Remote Control](https://code.claude.com/docs/en/remote-control).

### Codex hooks and fallback

- Lifecycle hooks documented: `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStop`, `Stop`, `Interrupt`, `SessionStart`, `SubagentStart`, `SessionEnd`.
- Sources: `~/.codex/hooks.json`, `~/.codex/config.toml`, `<repo>/.codex/hooks.json`, `<repo>/.codex/config.toml` (project layer only when the project's `.codex/` is trusted), plus inline `[hooks]` tables in `config.toml`. `-c` overrides set nested keys with dot notation, so a `-c hooks...` injection is plausible but **untested**.
- Trust: non-managed hooks must be reviewed with `/hooks`; trust is keyed by a hash of the definition, and changed definitions are skipped until re-trusted. Consequence: the hook command Ensemble injects must be byte-identical across sessions (session id via environment, token via a private file), or the user would have to re-trust every launch. Ensemble must not write to `~/.codex/` and must not pass `--dangerously-bypass-hook-trust`.
- `notify` currently emits only `agent-turn-complete` as a single JSON argument with `type`, `thread-id`, `turn-id`, `cwd`, `input-messages`, `last-assistant-message`. It is rejected in project-local config and must be set at user level or via `-c notify=[...]`. It is not a tool or permission stream. Sources: [Codex hooks](https://learn.chatgpt.com/docs/hooks), [advanced config](https://learn.chatgpt.com/docs/config-file/config-advanced).

## Runtime-tested during implementation (fake agent, never the real CLIs)

- The launcher's environment filtering and `claude auth status --json` classification are covered by tests that run the real launcher against `test/fixtures/fake-agent.mjs`, including a tmux server that already retained `ANTHROPIC_API_KEY` from an earlier client (the pane still sees it absent).
- Hook capture is tested for silence (empty stdout/stderr, exit 0) under success, HTTP 500, a hanging server, no server, malformed input, oversized input, a read-only spool, and eight concurrent writers.
- `node-pty` 1.1.0 installed through pnpm 12 lacks the execute bit on `prebuilds/darwin-arm64/spawn-helper`; a fresh install reproduces it. The server restores the bit at startup (`ensurePtyHelperExecutable`).
- Vitest fixtures must spawn helpers asynchronously: a blocking `spawnSync` stalls the event loop that hosts the fake hook listener, so the helper's POST times out. This was a test-harness artefact, not a helper bug.

## Reproduced review cases

### Ignored files are not protected by a clean Git status

In a temporary repository with `.env` in `.gitignore`, a linked worktree contained an ignored `.env` with a dummy value. `git status --porcelain` returned an empty string. `git worktree remove <path>` returned exit code 0 without `--force`, and the worktree, including `.env`, was deleted. The archive workflow must inventory ignored files and preserve them or obtain explicit discard approval before cleanup scripts or removal. Retaining the branch does not preserve ignored files.

### Silent curl still prints response bodies

A temporary loopback HTTP server returned a harmless JSON response. `curl -s -m 2` with a POST printed that response to stdout. The hook helper must explicitly discard the response body and suppress subprocess stderr on every path.

## Required implementation checks

- Run `claude auth status --json` only from the preflight module, under the exact launch environment, with output capped and parsed for named fields only. Cover every `authMethod` value with fixtures. Never use real credentials in tests.
- Manual (owner) check before Codex launch is enabled: run `codex login status` in a personal terminal, confirm it prints no secrets, and record its fields here.
- Test the launcher against a pre-existing tmux server that retained a conflicting variable (reproduced above), dead-pane exit codes, reattachment, and exact-conversation resume with two conversations, using the fake agent only.
- Manual (owner) check in M2: launch one real `claude` session through Ensemble in a new worktree, observe the trust dialog, and confirm whether `--settings` hooks fire before and after acceptance.
- Prove source and destination containment, including symlink replacement during copying, within disposable fixtures.
- Test archive preservation before cleanup, explicit ignored-file discard, cleanup failures, and changes between preflight and removal.
- Test silent, bounded hook capture with a separate stable loopback listener, non-loopback UI binding, restart replay, duplicate delivery, concurrent writers, size limits, storage failure, and cleared-history replay rejection.
- Verify Codex hook injection via `-c`, the one-time trust flow, and the `notify` fallback in deliberate manual checks.

The implementation plan is in `docs/architecture.md` and is awaiting owner approval. These notes record evidence and required checks; they do not mark the build or the live integrations as verified.
