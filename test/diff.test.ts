import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatLineComment,
  parsePatchFiles,
  untrackedDiff,
  workspaceDiff,
} from "../server/diff.js";
import { gitIn, makeTempRepo } from "./git-helpers.js";

describe("workspace diff", () => {
  let repo: string;
  let wt: string;
  beforeEach(() => {
    repo = makeTempRepo();
    wt = path.join(mkdtempSync(path.join(os.tmpdir(), "ensemble-wt-")), "wt");
    gitIn(repo, ["worktree", "add", "-q", "-b", "ens/diff", wt, "main"]);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(path.dirname(wt), { recursive: true, force: true });
  });

  it("includes committed, staged, unstaged, and untracked changes without touching the index", async () => {
    writeFileSync(path.join(wt, "committed.txt"), "one\ntwo\n");
    gitIn(wt, ["add", "committed.txt"]);
    gitIn(wt, ["commit", "-q", "-m", "add committed"]);
    writeFileSync(path.join(wt, "README.md"), "# temp\nchanged\n");
    writeFileSync(path.join(wt, "staged.txt"), "staged\n");
    gitIn(wt, ["add", "staged.txt"]);
    mkdirSync(path.join(wt, "new"));
    writeFileSync(path.join(wt, "new", "untracked.txt"), "a\nb\nc");
    writeFileSync(path.join(wt, "image.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
    const statusBefore = gitIn(wt, ["status", "--porcelain"]);

    const diff = await workspaceDiff(wt, "main");
    expect(diff.baseBranch).toBe("main");
    const byPath = Object.fromEntries(diff.files.map((f) => [f.path, f]));
    expect(byPath["committed.txt"]).toMatchObject({ status: "added", additions: 2, deletions: 0 });
    expect(byPath["README.md"]).toMatchObject({ status: "modified", additions: 1, deletions: 0 });
    expect(byPath["staged.txt"]).toMatchObject({ status: "added", additions: 1 });
    expect(byPath["new/untracked.txt"]).toMatchObject({ status: "untracked", additions: 3 });
    expect(byPath["new/untracked.txt"]?.diff).toContain(
      "@@ -0,0 +1,3 @@\n+a\n+b\n+c\n\\ No newline at end of file",
    );
    expect(byPath["image.bin"]).toMatchObject({ status: "binary" });
    expect(byPath["committed.txt"]?.diff).toContain("+two");
    expect(gitIn(wt, ["status", "--porcelain"])).toBe(statusBefore);
  });

  it("handles deletions and renames", async () => {
    gitIn(wt, ["mv", "README.md", "RENAMED.md"]);
    gitIn(wt, ["commit", "-q", "-m", "rename"]);
    writeFileSync(path.join(wt, "gone.txt"), "x\n");
    gitIn(wt, ["add", "gone.txt"]);
    gitIn(wt, ["commit", "-q", "-m", "add gone"]);
    rmSync(path.join(wt, "gone.txt"));
    const diff = await workspaceDiff(wt, "main");
    const byPath = Object.fromEntries(diff.files.map((f) => [f.path, f]));
    expect(byPath["RENAMED.md"]).toMatchObject({ status: "renamed", oldPath: "README.md" });
    expect(byPath["gone.txt"]).toBeUndefined(); // added then deleted → no net change vs base
  });

  it("parses patch headers with quoted paths", () => {
    const files = parsePatchFiles(
      'diff --git "a/sp ace.txt" "b/sp ace.txt"\nnew file mode 100644\n--- /dev/null\n+++ "b/sp ace.txt"\n@@ -0,0 +1 @@\n+hi\n',
    );
    expect(files[0]).toMatchObject({ path: "sp ace.txt", status: "added" });
  });

  it("caps very large untracked files", () => {
    writeFileSync(path.join(wt, "big.txt"), "x".repeat(2 * 1024 * 1024));
    const f = untrackedDiff(wt, "big.txt");
    expect(f.diff).toContain("more bytes not shown");
  });

  it("formats line comments", () => {
    expect(formatLineComment("src/a.ts", 10, 14, " fix this ")).toBe(
      "In src/a.ts lines 10–14: fix this",
    );
    expect(formatLineComment("src/a.ts", 3, 3, "why?")).toBe("In src/a.ts line 3: why?");
  });
});
