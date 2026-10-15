import { useEffect, useState } from "react";
import { PRODUCT_NAME } from "../../shared/brand.js";

interface Health {
  ok: boolean;
  name: string;
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => (r.ok ? (r.json() as Promise<Health>) : Promise.reject(new Error(r.statusText))))
      .then(setHealth)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <main className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold">{PRODUCT_NAME}</h1>
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
        Local orchestrator for parallel coding-agent sessions.
      </p>
      <p className="mt-6 font-mono text-sm">
        {error ? `server error: ${error}` : health ? `server ok (${health.name})` : "connecting…"}
      </p>
    </main>
  );
}
