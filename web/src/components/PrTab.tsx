import { useEffect, useState } from "react";
import type { PrInfo, Session, Workspace } from "../../../shared/types.js";
import { api } from "../api.js";
import { useUiState } from "../store.js";

const DRAFT_PROMPT = (base: string) =>
  `Draft a pull request for this workspace's changes against ${base}. Reply with the title on the first line and a markdown description below it; do not run git push or create the PR yourself.`;

function ChecksList({ pr }: { pr: PrInfo }) {
  if (pr.checks.length === 0)
    return <p className="text-xs text-neutral-500">No checks reported.</p>;
  return (
    <ul className="space-y-0.5 text-xs">
      {pr.checks.map((c) => (
        <li key={c.name} className="flex items-center gap-2">
          <span
            className={
              c.result === "passed"
                ? "text-emerald-600"
                : c.result === "failed"
                  ? "text-red-600"
                  : "text-amber-600"
            }
          >
            {c.result === "passed" ? "✓" : c.result === "failed" ? "✗" : "…"}
          </span>
          {c.url ? (
            <a className="underline" href={c.url} target="_blank" rel="noreferrer">
              {c.name}
            </a>
          ) : (
            <span>{c.name}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function PrTab({ workspace, onArchive }: { workspace: Workspace; onArchive: () => void }) {
  const ui = useUiState();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mergeMethod, setMergeMethod] = useState<"squash" | "merge" | "rebase">("squash");
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [gh, setGh] = useState<{ ok: boolean; summary: string } | null>(null);
  const pr = workspace.pr;
  const sessions: Session[] = (ui.snapshot?.sessions ?? []).filter(
    (s) => s.workspaceId === workspace.id && s.processState === "running",
  );
  const [draftSession, setDraftSession] = useState("");

  useEffect(() => {
    api<{ ok: boolean; summary: string }>("GET", "/api/gh")
      .then(setGh)
      .catch(() => setGh({ ok: false, summary: "gh check failed" }));
  }, []);

  const call = async (label: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (done) setNotice(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const askAgent = () =>
    call(
      "draft",
      () =>
        api("POST", `/api/sessions/${draftSession || sessions[0]?.id}/input`, {
          text: DRAFT_PROMPT(workspace.baseBranch),
        }),
      "Prompt sent; paste the agent's title and description here when it answers.",
    );

  return (
    <div className="space-y-4 text-sm">
      {gh && !gh.ok && (
        <p className="rounded bg-amber-50 p-2 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {gh.summary}
        </p>
      )}
      {error && <p className="text-red-600">{error}</p>}
      {notice && <p className="text-emerald-700 dark:text-emerald-300">{notice}</p>}

      {!pr && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="btn-ghost"
              disabled={busy !== null}
              onClick={() =>
                call(
                  "push",
                  () => api("POST", `/api/workspaces/${workspace.id}/push`),
                  `Pushed ${workspace.branch} to origin.`,
                )
              }
            >
              Push branch
            </button>
            <span className="font-mono text-xs text-neutral-500">
              {workspace.branch} → {workspace.baseBranch}
            </span>
          </div>
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              void call("create", () =>
                api("POST", `/api/workspaces/${workspace.id}/pr`, { title, body, draft }),
              );
            }}
          >
            <label className="block">
              Title
              <input
                className="input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </label>
            <label className="block">
              Description
              <textarea
                className="input min-h-40 font-mono text-xs"
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={draft}
                  onChange={(e) => setDraft(e.target.checked)}
                />{" "}
                Draft PR
              </label>
              {sessions.length > 0 && (
                <span className="flex items-center gap-1">
                  <select
                    className="input mt-0 w-auto"
                    value={draftSession}
                    onChange={(e) => setDraftSession(e.target.value)}
                  >
                    {sessions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.agent} · {s.tmuxName}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={busy !== null}
                    onClick={askAgent}
                  >
                    Ask agent to draft
                  </button>
                </span>
              )}
              <button
                type="submit"
                className="btn-primary ml-auto"
                disabled={busy !== null || !title.trim() || gh?.ok === false}
              >
                {busy === "create" ? "Creating…" : "Push and create PR"}
              </button>
            </div>
          </form>
        </>
      )}

      {pr && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <a
              className="text-base font-semibold underline"
              href={pr.url}
              target="_blank"
              rel="noreferrer"
            >
              #{pr.number} {pr.title}
            </a>
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${pr.state === "MERGED" ? "bg-purple-100 text-purple-900 dark:bg-purple-900/40 dark:text-purple-200" : pr.state === "OPEN" ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200" : "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"}`}
            >
              {pr.isDraft && pr.state === "OPEN" ? "draft" : pr.state.toLowerCase()}
            </span>
            {pr.reviewDecision && (
              <span className="text-xs text-neutral-500">
                review: {pr.reviewDecision.toLowerCase().replace("_", " ")}
              </span>
            )}
            {pr.mergeable && (
              <span className="text-xs text-neutral-500">
                mergeable: {pr.mergeable.toLowerCase()}
              </span>
            )}
            <button
              className="btn-ghost ml-auto text-xs"
              disabled={busy !== null}
              onClick={() =>
                call("refresh", () => api("GET", `/api/workspaces/${workspace.id}/pr`))
              }
              title={`last fetched ${new Date(pr.fetchedAt).toLocaleTimeString()}`}
            >
              ↻ refresh
            </button>
          </div>
          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase text-neutral-500">Checks</h3>
            <ChecksList pr={pr} />
          </section>
          {pr.state === "OPEN" && (
            <section className="flex flex-wrap items-center gap-2">
              <select
                className="input mt-0 w-auto"
                value={mergeMethod}
                onChange={(e) => setMergeMethod(e.target.value as typeof mergeMethod)}
              >
                <option value="squash">Squash and merge</option>
                <option value="merge">Create a merge commit</option>
                <option value="rebase">Rebase and merge</option>
              </select>
              {!confirmMerge ? (
                <button
                  className="btn-primary"
                  disabled={busy !== null || gh?.ok === false}
                  onClick={() => setConfirmMerge(true)}
                >
                  Merge…
                </button>
              ) : (
                <span className="flex items-center gap-2">
                  <span className="text-xs">
                    Merge #{pr.number} into {pr.baseRefName ?? workspace.baseBranch} ({mergeMethod}
                    )?
                  </span>
                  <button className="btn-ghost" onClick={() => setConfirmMerge(false)}>
                    Cancel
                  </button>
                  <button
                    className="btn-danger"
                    disabled={busy !== null}
                    onClick={() => {
                      setConfirmMerge(false);
                      void call(
                        "merge",
                        () =>
                          api("POST", `/api/workspaces/${workspace.id}/pr/merge`, {
                            method: mergeMethod,
                          }),
                        "Merged.",
                      );
                    }}
                  >
                    Confirm merge
                  </button>
                </span>
              )}
            </section>
          )}
          {pr.state === "MERGED" && workspace.status !== "archived" && (
            <section className="rounded bg-neutral-100 p-3 dark:bg-neutral-800">
              <p className="mb-2">The PR is merged. Archive this workspace?</p>
              <button className="btn-primary" onClick={onArchive}>
                Archive workspace…
              </button>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
