# Ensemble

This repository is being built from scratch from the specification in `ensemble-build-spec.md`.

Before doing any work in this repo:

1. Read `ensemble-build-spec.md` in full.
2. For application implementation, follow its **Working process** section (section 7) in order: verify the installed CLIs and record findings in `docs/cli-notes.md`, write `docs/architecture.md`, then stop and ask for review, the GitHub repo name, and public/private before writing application code. A request to review or update documentation authorizes that documentation work without starting implementation or publication.
3. Treat section 2 (**Hard constraints**) as non-negotiable: never read or handle Claude/Codex credentials, interactive CLI sessions only, and the security model as written.
4. Preserve the reviewed safeguards: copy-path containment, explicit handling of ignored files before archive cleanup, subscription-mode preflight, a stable loopback hook listener, silent hook capture with bounded durable replay, notification-type filtering, and exact-conversation resume. Keep their acceptance checks aligned with any design change.

The plan in `docs/architecture.md` was approved on October 14, 2026; milestones M0–M7 were implemented by October 15, 2026 and `docs/acceptance.md` records which acceptance items are verified automatically, manually, or still need the owner. Follow-up work is planned in `docs/plan-v2.md` (Phase 1, terminal-first launching with in-place workspaces, shipped October 15, 2026; Phase 2 handoffs next). Keep this file and the spec in the repo. See `docs/cli-notes.md` for dated verification results and unresolved runtime checks, and `docs/architecture.md` for the proposed plan (awaiting owner approval); do not treat documented or help-verified behavior as runtime-tested.
