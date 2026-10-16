# Owner checks: manual walkthrough

Written October 15, 2026 after plan v2 shipped. These are the acceptance items that only the owner can confirm, because they need the owner's subscription, phone, Tailscale network, Codex login, or a second Mac. Nothing here was run by the build sessions. Run them in this order; each one says what to do and what to expect. Paste anything that does not match into the next build session, with the event log export (JSONL) if events are involved.

`ensemble` is not on `PATH` by default: run `pnpm link --global` once in this checkout, or use `node bin/ensemble.js` wherever `ensemble` appears below.

Setup for every check:

```sh
cd ~/Documents/GitHub/ensemble
pnpm start          # terminal 1, leave it running; open the printed login URL
```

## 1. Real handoff between two live sessions (Phase 2)

1. In a second terminal, `cd` into any git checkout and run `ensemble claude`. Accept the trust prompt if Claude shows one.
2. In the browser, open that workspace and press ⌘N to create a worktree workspace from the same repo with a second Claude session. Two agents in one checkout get a warning; the second one belongs in a worktree.
3. In the terminal session, ask something small ("List the three largest files in this repo.").
4. Expect: within a few seconds the **Last answer** panel under that session's terminal shows the reply, and the event log shows `UserPromptSubmit` then `Stop`.
5. Click **Send to…**, pick the second session, choose the "review this" template, send.
6. Expect: the second session's terminal shows a prompt starting with `From claude in <repo>/checkout (Ensemble handoff):`, it answers, and both sessions get an `ensemble.handoff` event (sent on one, received on the other). A multi-line answer arrives as one prompt, not line by line.
7. Optional: **Ask all** on the workspace sends one prompt to both sessions. For the relay, enable it in Settings, make sure both sessions are idle, click **Relay with…**, set 2 or 3 hops, and watch it stop at the limit with `ensemble.relay` events in both logs. **Stop** on the banner ends it immediately.

## 2. Live Claude permission prompt (v1 item 2)

During check 1, ask the terminal session to do something that needs approval ("Create a file named scratch.txt containing hello."). Expect: the sidebar dot and the session chip turn amber with "needs input" and the tab title gets a badge. Approve in the terminal: it returns to working, then idle. Denying must also clear needs-input.

## 3. Real `claude attach` (Phase 3)

1. Outside Ensemble, in a checkout: `claude --bg "Summarize the README in two sentences."` and let it finish.
2. In the sidebar click **Claude agents…**. Expect: the session is listed with its cwd and state; interactive sessions from other terminals are listed but not attachable.
3. Click **Attach**. Expect: an in-place workspace for that checkout appears (marked "checkout"), the browser terminal shows Claude's attach view, the session carries the "attached" badge, and status follows the listing (polled every five seconds). No last answer is expected for attached sessions.
4. Detach inside Claude (Left arrow on an empty prompt, or `/exit`). Expect: the Ensemble terminal ends as "exited" and `claude agents` still lists the background session.

## 4. Remote Control on the phone (v1 item 12)

Start a Claude session from the browser with "Enable Remote Control" checked (or turn on the default in Settings). Expect: the session appears in the Claude mobile app and the event log has a "launched with Remote Control" entry. The checkbox is only offered for subscription logins; seeing it with an API key is a bug.

## 5. Real Codex session (v1 item 1, known limitation)

Codex is not on `PATH` here. Install the standalone CLI or point Settings at the binary bundled with the ChatGPT app, then run `ensemble codex` in a checkout. The Doctor page should turn green for Codex. On the first run Codex may show a one-time `/hooks` trust prompt; accept it. Expect afterwards: `agent-turn-complete` events and a Last answer after each reply. If no events arrive, the unverified `-c hooks.*` injection path is the first thing to investigate (see `docs/cli-notes.md`).

## 6. Real PR (v1 item 9)

In a worktree workspace, have the agent make a small commit, open the PR tab, click **Create PR**. Expect: PR link, status, and checks appear within the poll interval, **Merge** works from the UI, and **Archive** removes the worktree cleanly. Archive warns about modified ignored files such as `.env` before deleting anything; that is the safeguard.

## 7. Phone over Tailscale (v1 item 15)

```sh
pnpm start -- --host 100.x.y.z     # the Mac's Tailscale IP
```

Open that address with the token on the phone. Expect: the sidebar becomes a drawer and the terminal fits. Any other hostname returns 421. Restart the server and confirm sessions started before the restart still report events.

## 8. Fresh-Mac quickstart (v1 item 17)

On a Mac without this repo: install Node 22 and tmux, clone, `pnpm install && pnpm start`. Expect: the Doctor page finds `claude`, `gh`, and tmux, and the first session starts. Note anything the README does not say.
