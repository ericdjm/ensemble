#!/usr/bin/env node
// Descriptor-pinned copy worker (docs/architecture.md §6.2).
//
// Reads a copy plan as JSON on stdin and copies each entry from the source root to the
// destination root. Every directory is entered with chdir() and verified by inode so a
// component swapped for a symlink (or another directory) between check and use aborts
// the whole copy. All opens use single path components relative to the pinned cwd with
// O_NOFOLLOW, and destination files are created O_EXCL under a temporary name then renamed.
//
// Output: one JSON line per entry on stdout; exit 0 only when every entry succeeded.
// Test hooks (only with --test-hooks): ENSEMBLE_COPY_TEST_HOOK="<src|dst>:<component>:<action>:<arg>"
// runs an attacker action right before the chdir into <component>.
import fs from "node:fs";
import crypto from "node:crypto";

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
const TEST_HOOKS = process.argv.includes("--test-hooks");
const hookSpec = TEST_HOOKS ? (process.env.ENSEMBLE_COPY_TEST_HOOK ?? "") : "";

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sameInode(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

function checkComponent(c) {
  if (c === "" || c === "." || c === ".." || c === ".git" || c.includes("/") || c.includes("\0")) {
    throw new Error(`illegal path component ${JSON.stringify(c)}`);
  }
}

function runTestHook(phase, component) {
  if (!hookSpec) return;
  const [p, c, action, arg] = hookSpec.split(":");
  if (p !== phase || c !== component) return;
  if (action === "symlink") {
    // Attacker: replace the directory with a symlink to <arg>.
    fs.renameSync(component, `${component}.moved`);
    fs.symlinkSync(arg, component);
  } else if (action === "swapdir") {
    // Attacker: replace the directory with a different real directory.
    fs.renameSync(component, `${component}.moved`);
    fs.mkdirSync(component);
  }
}

function enterRoot(root, dev, ino) {
  process.chdir(root);
  const st = fs.statSync(".");
  if (!sameInode(st, { dev, ino })) throw new Error(`root changed: ${root}`);
}

/** Enters one component of the pinned cwd, verifying it is the same real directory we checked. */
function descend(phase, component, { create }) {
  checkComponent(component);
  let st;
  try {
    st = fs.lstatSync(component);
  } catch (e) {
    if (e.code === "ENOENT" && create) {
      fs.mkdirSync(component, { mode: 0o755 });
      st = fs.lstatSync(component);
    } else {
      throw e;
    }
  }
  if (!st.isDirectory()) throw new Error(`${phase}: ${component} is not a directory`);
  runTestHook(phase, component);
  process.chdir(component);
  const now = fs.statSync(".");
  if (!sameInode(st, now))
    throw new Error(`${phase}: directory ${component} was replaced during copy`);
}

function readSource(plan, entry, dirs, leaf) {
  enterRoot(plan.srcRoot, plan.srcRootDev, plan.srcRootIno);
  for (const d of dirs) descend("src", d, { create: false });
  checkComponent(leaf);
  const fd = fs.openSync(leaf, O_RDONLY | O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`src: ${entry.relPath} is not a regular file`);
    if (st.dev !== entry.srcDev || st.ino !== entry.srcIno) {
      throw new Error(`src: ${entry.relPath} changed since the plan was validated`);
    }
    if (st.size > 256 * 1024 * 1024) throw new Error(`src: ${entry.relPath} is too large`);
    return { data: fs.readFileSync(fd), mode: st.mode & 0o777 };
  } finally {
    fs.closeSync(fd);
  }
}

function writeDestination(plan, entry, dirs, leaf, data, mode) {
  enterRoot(plan.dstRoot, plan.dstRootDev, plan.dstRootIno);
  for (const d of dirs) descend("dst", d, { create: true });
  checkComponent(leaf);
  const tmp = `.ensemble-copy-${crypto.randomBytes(8).toString("hex")}`;
  const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  let renamed = false;
  try {
    fs.writeFileSync(fd, data);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, leaf);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }
}

function main() {
  const plan = JSON.parse(fs.readFileSync(0, "utf8"));
  for (const entry of plan.entries) {
    try {
      const parts = entry.relPath.split("/");
      const leaf = parts.pop();
      const { data, mode } = readSource(plan, entry, parts, leaf);
      writeDestination(plan, entry, parts, leaf, data, mode);
      out({ relPath: entry.relPath, ok: true, bytes: data.length });
    } catch (e) {
      out({ relPath: entry.relPath, ok: false, error: e && e.message ? e.message : String(e) });
      process.exit(1);
    }
  }
  process.exit(0);
}

try {
  main();
} catch (e) {
  out({ ok: false, error: e && e.message ? e.message : String(e) });
  process.exit(2);
}
