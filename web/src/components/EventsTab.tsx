import { useCallback, useEffect, useMemo, useState } from "react";
import type { EventGap, EventSummary, Session } from "../../../shared/types.js";
import { api } from "../api.js";
import { subscribeEvents, useUiState } from "../store.js";

function Row({ sessionId, event }: { sessionId: string; event: EventSummary }) {
  const [open, setOpen] = useState(false);
  const [payload, setPayload] = useState<string | null>(null);
  const toggle = async () => {
    setOpen((o) => !o);
    if (payload === null) {
      try {
        const res = await fetch(`/api/sessions/${sessionId}/events/${event.eventId}`, {
          credentials: "same-origin",
        });
        const text = await res.text();
        try {
          setPayload(JSON.stringify(JSON.parse(text), null, 2));
        } catch {
          setPayload(text);
        }
      } catch (e) {
        setPayload(`failed to load: ${(e as Error).message}`);
      }
    }
  };
  const ts = event.sourceTs ? new Date(event.sourceTs) : null;
  return (
    <li className="border-b border-neutral-200 dark:border-neutral-800">
      <button
        className="flex w-full items-baseline gap-2 px-2 py-1 text-left text-xs hover:bg-neutral-50 dark:hover:bg-neutral-900"
        onClick={toggle}
      >
        <span className="w-8 shrink-0 text-neutral-400">{event.seq}</span>
        <span className="w-16 shrink-0 text-neutral-500">{ts ? ts.toLocaleTimeString() : ""}</span>
        <span className="w-36 shrink-0 truncate font-medium">{event.type}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-neutral-600 dark:text-neutral-400">
          {event.summary ?? ""}
        </span>
        {event.truncated && (
          <span className="rounded bg-amber-100 px-1 text-[10px] text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
            truncated
          </span>
        )}
        <span className="text-neutral-400">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <pre className="max-h-80 overflow-auto bg-neutral-100 p-2 font-mono text-[11px] dark:bg-neutral-900">
          {payload ?? "loading…"}
        </pre>
      )}
    </li>
  );
}

export function EventsTab({ session }: { session: Session }) {
  const ui = useUiState();
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [gaps, setGaps] = useState<EventGap[]>([]);
  const [typeFilter, setTypeFilter] = useState("");
  const [toolFilter, setToolFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api<{ events: EventSummary[]; gaps: EventGap[] }>(
        "GET",
        `/api/sessions/${session.id}/events?limit=1000`,
      );
      setEvents(r.events);
      setGaps(r.gaps);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [session.id]);

  useEffect(() => {
    void load();
  }, [load, session.hookGeneration]);

  useEffect(
    () =>
      subscribeEvents(session.id, (ev) => {
        setEvents((list) =>
          list.some((e) => e.eventId === ev.eventId)
            ? list
            : [...list, ev].sort((a, b) => a.seq - b.seq),
        );
      }),
    [session.id],
  );

  const typeOptions = useMemo(
    () => Array.from(new Set(events.map((e) => e.type))).sort(),
    [events],
  );
  const filtered = events.filter(
    (e) =>
      (!typeFilter || e.type === typeFilter) &&
      (!toolFilter || (e.toolName ?? "").toLowerCase().includes(toolFilter.toLowerCase())),
  );
  const clear = async () => {
    if (
      !confirm(
        "Clear this session's event history? Queued events for the cleared history are discarded too.",
      )
    )
      return;
    try {
      await api("DELETE", `/api/sessions/${session.id}/events`);
      setEvents([]);
      setGaps([]);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="flex h-full flex-col gap-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="input mt-0 w-auto"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
        >
          <option value="">all types</option>
          {typeOptions.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          className="input mt-0 w-40"
          placeholder="tool filter"
          value={toolFilter}
          onChange={(e) => setToolFilter(e.target.value)}
        />
        <span className="text-xs text-neutral-500">
          {filtered.length} of {events.length}
          {session.freshness !== "current" && (
            <span className="ml-2 text-amber-600">status freshness: {session.freshness}</span>
          )}
        </span>
        <span className="ml-auto flex gap-1">
          <a className="btn-ghost" href={`/api/sessions/${session.id}/events.jsonl`} download>
            Export JSONL
          </a>
          <button className="btn-ghost text-red-600" onClick={clear}>
            Clear events
          </button>
        </span>
      </div>
      {!ui.connected && (
        <p className="text-xs text-neutral-500">
          Reconnecting; new events appear when the connection returns.
        </p>
      )}
      {error && <p className="text-red-600">{error}</p>}
      {gaps.length > 0 && (
        <ul className="rounded bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {gaps.map((g) => (
            <li key={`${g.from_seq}-${g.reason}`}>
              Gap: {g.count} event{g.count === 1 ? "" : "s"} (seq {g.from_seq}–{g.to_seq}) lost:{" "}
              {g.reason}. History is incomplete here.
            </li>
          ))}
        </ul>
      )}
      <ul className="min-h-0 flex-1 overflow-auto rounded border border-neutral-200 dark:border-neutral-800">
        {filtered.length === 0 && (
          <li className="p-3 text-xs text-neutral-500">
            No events{events.length ? " match the filter" : " yet"}.
          </li>
        )}
        {filtered.map((e) => (
          <Row key={e.eventId} sessionId={session.id} event={e} />
        ))}
      </ul>
    </div>
  );
}
