import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Creates a throwaway git repo with one commit on `main` and returns its path. */
export function makeTempRepo(prefix = "ensemble-repo-"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  const run = (args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: dir,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
      stdio: "pipe",
    });
  run(["init", "-q", "-b", "main"]);
  writeFileSync(path.join(dir, "README.md"), "# temp\n");
  writeFileSync(path.join(dir, ".gitignore"), ".env\n.env.*\nnode_modules/\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "init"]);
  return dir;
}

export function gitIn(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: dir,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
    stdio: "pipe",
  })
    .toString()
    .trim();
}
