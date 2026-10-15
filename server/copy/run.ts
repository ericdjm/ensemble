import { spawn } from "node:child_process";
import path from "node:path";
import { packageRoot } from "../paths.js";
import type { CopyPlan } from "./plan.js";

export interface CopyResult {
  relPath: string;
  ok: boolean;
  bytes?: number;
  error?: string;
}

export class CopyError extends Error {
  constructor(
    message: string,
    public readonly results: CopyResult[],
  ) {
    super(message);
    this.name = "CopyError";
  }
}

export interface RunCopyOptions {
  /** Test-only attacker hook passed to the worker; ignored unless `testHooks` is true. */
  testHook?: string;
  testHooks?: boolean;
  timeoutMs?: number;
}

/** Executes a validated plan in the pinned copy worker. Resolves with per-entry results; rejects on any failure. */
export function runCopyPlan(plan: CopyPlan, opts: RunCopyOptions = {}): Promise<CopyResult[]> {
  const worker = path.join(packageRoot(), "helpers", "copy-worker.mjs");
  const args = [worker, ...(opts.testHooks ? ["--test-hooks"] : [])];
  const env: Record<string, string> = { PATH: process.env["PATH"] ?? "" };
  if (opts.testHooks && opts.testHook) env["ENSEMBLE_COPY_TEST_HOOK"] = opts.testHook;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 120_000);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new CopyError(`copy worker failed to start: ${e.message}`, []));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const results: CopyResult[] = [];
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          results.push(JSON.parse(line) as CopyResult);
        } catch {
          reject(new CopyError("copy worker produced unparsable output", results));
          return;
        }
      }
      if (code !== 0) {
        const failed = results.find((r) => !r.ok);
        reject(
          new CopyError(
            failed?.error ?? `copy worker exited with ${code}: ${stderr.trim()}`,
            results,
          ),
        );
        return;
      }
      if (results.length !== plan.entries.length || results.some((r) => !r.ok)) {
        reject(new CopyError("copy worker did not confirm every entry", results));
        return;
      }
      resolve(results);
    });
    child.stdin.end(JSON.stringify(plan));
  });
}
