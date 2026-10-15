import { lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";

export interface CopyEntry {
  relPath: string;
  size: number;
  mode: number;
  srcDev: number;
  srcIno: number;
}

export interface CopyPlan {
  srcRoot: string;
  dstRoot: string;
  srcRootDev: number;
  srcRootIno: number;
  dstRootDev: number;
  dstRootIno: number;
  entries: CopyEntry[];
}

export class CopyPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopyPlanError";
  }
}

const MAX_WALK_ENTRIES = 250_000;

/** Returns an error message for an unsafe pattern, or null when acceptable. */
export function validatePattern(pattern: unknown): string | null {
  if (typeof pattern !== "string") return "pattern must be a string";
  if (pattern.length === 0 || pattern.length > 512) return "pattern must be 1-512 characters";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(pattern)) return "pattern contains control characters";
  if (pattern.includes("\\")) return "pattern must use forward slashes";
  if (pattern.startsWith("/")) return "pattern must be relative";
  if (pattern.startsWith("~")) return "pattern must not use home expansion";
  if (/^[a-zA-Z]:/.test(pattern)) return "pattern must be relative";
  const components = pattern.split("/");
  if (components.some((c) => c === "..")) return "pattern must not contain '..'";
  if (components.some((c) => c === ".git")) return "pattern must not touch .git";
  if (components.some((c) => c === "")) return "pattern must not contain empty components";
  return null;
}

function hasGitComponent(relPath: string): boolean {
  return relPath.split("/").some((c) => c === ".git");
}

function inode(p: string): { dev: number; ino: number } {
  const st = lstatSync(p);
  return { dev: st.dev, ino: st.ino };
}

/**
 * Builds a validated copy plan: walks the main checkout without following symlinks,
 * matches regular files only, and records their inodes for the worker to verify.
 */
export function buildCopyPlan(
  patterns: string[],
  srcRootInput: string,
  dstRootInput: string,
): CopyPlan {
  for (const p of patterns) {
    const err = validatePattern(p);
    if (err) throw new CopyPlanError(`copy pattern ${JSON.stringify(p)}: ${err}`);
  }
  const srcRoot = realpathSync(srcRootInput);
  const dstRoot = realpathSync(dstRootInput);
  if (
    srcRoot === dstRoot ||
    dstRoot.startsWith(srcRoot + path.sep) ||
    srcRoot.startsWith(dstRoot + path.sep)
  ) {
    throw new CopyPlanError("source and destination roots must be disjoint");
  }
  const src = inode(srcRoot);
  const dst = inode(dstRoot);
  if (patterns.length === 0) {
    return {
      srcRoot,
      dstRoot,
      srcRootDev: src.dev,
      srcRootIno: src.ino,
      dstRootDev: dst.dev,
      dstRootIno: dst.ino,
      entries: [],
    };
  }

  const matchers = patterns.map((p) => picomatch(p, { dot: true, strictSlashes: true }));
  const needsNodeModules = patterns.some((p) => p.includes("node_modules"));
  const matches = (rel: string) => matchers.some((m) => m(rel));

  const entries: CopyEntry[] = [];
  const stack: string[] = [""];
  let visited = 0;
  while (stack.length > 0) {
    const relDir = stack.pop() as string;
    const absDir = relDir === "" ? srcRoot : path.join(srcRoot, relDir);
    let names: string[];
    try {
      names = readdirSync(absDir);
    } catch (e) {
      throw new CopyPlanError(`cannot read ${relDir || "."}: ${(e as Error).message}`);
    }
    for (const name of names) {
      if (++visited > MAX_WALK_ENTRIES)
        throw new CopyPlanError("checkout too large to scan for copy patterns");
      const rel = relDir === "" ? name : `${relDir}/${name}`;
      if (name === ".git") continue;
      const st = lstatSync(path.join(srcRoot, rel));
      if (st.isDirectory()) {
        if (name === "node_modules" && !needsNodeModules) continue;
        stack.push(rel);
        continue;
      }
      if (!matches(rel)) continue;
      if (st.isSymbolicLink()) throw new CopyPlanError(`refusing to copy symlink ${rel}`);
      if (!st.isFile()) throw new CopyPlanError(`refusing to copy special file ${rel}`);
      if (hasGitComponent(rel)) throw new CopyPlanError(`refusing to copy ${rel}`);
      entries.push({
        relPath: rel,
        size: st.size,
        mode: st.mode & 0o777,
        srcDev: st.dev,
        srcIno: st.ino,
      });
    }
  }
  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
  return {
    srcRoot,
    dstRoot,
    srcRootDev: src.dev,
    srcRootIno: src.ino,
    dstRootDev: dst.dev,
    dstRootIno: dst.ino,
    entries,
  };
}
