import { openSync, readSync, closeSync, fstatSync } from "node:fs";
import path from "node:path";
import type { DiffFile, WorkspaceDiff } from "../shared/types.js";
import { git } from "./git.js";

const MAX_UNTRACKED_BYTES = 1024 * 1024;

/** Splits a multi-file unified diff into per-file patches keyed by their new path. */
export function splitPatch(patch: string): Array<{ header: string; body: string }> {
  if (!patch.trim()) return [];
  const parts = patch.split(/^(?=diff --git )/m).filter((p) => p.startsWith("diff --git "));
  return parts.map((p) => {
    const nl = p.indexOf("\n");
    return { header: nl >= 0 ? p.slice(0, nl) : p, body: p };
  });
}

function unquote(p: string): string {
  if (p.startsWith('"') && p.endsWith('"')) {
    try {
      return JSON.parse(p) as string;
    } catch {
      return p.slice(1, -1);
    }
  }
  return p;
}

function pathsFromHeader(header: string): { oldPath: string; newPath: string } {
  // diff --git a/<old> b/<new>  (paths may be quoted when they contain special characters)
  const m = /^diff --git (?:a\/)?("(?:[^"\\]|\\.)*"|\S+) (?:b\/)?("(?:[^"\\]|\\.)*"|\S+)$/.exec(
    header,
  );
  if (!m) return { oldPath: "", newPath: "" };
  return {
    oldPath: unquote(m[1] as string).replace(/^a\//, ""),
    newPath: unquote(m[2] as string).replace(/^b\//, ""),
  };
}

export function parsePatchFiles(patch: string): DiffFile[] {
  return splitPatch(patch).map(({ header, body }) => {
    const { oldPath, newPath } = pathsFromHeader(header);
    let status: DiffFile["status"] = "modified";
    if (/^new file mode/m.test(body)) status = "added";
    else if (/^deleted file mode/m.test(body)) status = "deleted";
    else if (/^rename from /m.test(body)) status = "renamed";
    const binary = /^Binary files .* differ$/m.test(body) || /^GIT binary patch$/m.test(body);
    const file: DiffFile = {
      path: status === "deleted" ? oldPath : newPath,
      status: binary ? "binary" : status,
      additions: 0,
      deletions: 0,
      diff: body,
    };
    if (status === "renamed" && oldPath !== newPath) file.oldPath = oldPath;
    return file;
  });
}

function readCapped(file: string): { data: Buffer; size: number } {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, MAX_UNTRACKED_BYTES);
    const data = Buffer.alloc(len);
    let off = 0;
    while (off < len) {
      const n = readSync(fd, data, off, len - off, off);
      if (n === 0) break;
      off += n;
    }
    return { data: data.subarray(0, off), size };
  } finally {
    closeSync(fd);
  }
}

/** Builds an "added file" unified diff for an untracked file without touching the index. */
export function untrackedDiff(root: string, rel: string): DiffFile {
  const { data, size } = readCapped(path.join(root, rel));
  const head = data.subarray(0, 8192);
  if (head.includes(0)) {
    return {
      path: rel,
      status: "binary",
      additions: 0,
      deletions: 0,
      diff: `diff --git a/${rel} b/${rel}\nnew file mode 100644\nBinary files /dev/null and b/${rel} differ\n`,
    };
  }
  const text = data.toString("utf8");
  const truncated = size > data.length;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const body = lines.map((l) => `+${l}`).join("\n");
  const count = lines.length + (truncated ? 1 : 0);
  const diff =
    `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${count} @@\n` +
    body +
    (lines.length ? "\n" : "") +
    (truncated ? `+… (${size - data.length} more bytes not shown)\n` : "") +
    (text.endsWith("\n") || lines.length === 0 ? "" : "\\ No newline at end of file\n");
  return { path: rel, status: "untracked", additions: lines.length, deletions: 0, diff };
}

/**
 * Diff of a workspace against the merge-base with its base branch: committed, staged, unstaged, and
 * untracked changes. Reads only; the user's index is never modified.
 */
export async function workspaceDiff(worktree: string, baseBranch: string): Promise<WorkspaceDiff> {
  const base = await git(["merge-base", baseBranch, "HEAD"], { cwd: worktree });
  const [patch, numstat, untrackedZ] = await Promise.all([
    git(["diff", "--no-color", "--no-ext-diff", "-M", base], { cwd: worktree }),
    git(["diff", "--no-ext-diff", "-M", "--numstat", "-z", base], { cwd: worktree }),
    git(["ls-files", "--others", "--exclude-standard", "-z"], { cwd: worktree }),
  ]);
  const files = parsePatchFiles(patch);
  const counts = new Map<string, { additions: number; deletions: number }>();
  const tokens = numstat.split("\0").filter((t) => t.length > 0);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] as string;
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tok);
    if (!m) continue;
    let p = m[3] as string;
    if (p === "") {
      // rename: numstat -z emits "<add>\t<del>\t\0<old>\0<new>"
      i += 1;
      p = tokens[i + 1] as string;
      i += 1;
    }
    counts.set(p, {
      additions: m[1] === "-" ? 0 : Number(m[1]),
      deletions: m[2] === "-" ? 0 : Number(m[2]),
    });
  }
  for (const f of files) {
    const c = counts.get(f.path);
    if (c) Object.assign(f, c);
  }
  for (const rel of untrackedZ.split("\0").filter((s) => s.length > 0)) {
    try {
      files.push(untrackedDiff(worktree, rel));
    } catch {
      files.push({ path: rel, status: "untracked", additions: 0, deletions: 0, diff: "" });
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { base, baseBranch, files };
}

export function formatLineComment(file: string, from: number, to: number, text: string): string {
  const range = from === to ? `line ${from}` : `lines ${from}–${to}`;
  return `In ${file} ${range}: ${text.trim()}`;
}
