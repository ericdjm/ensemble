#!/usr/bin/env node
// Fake `gh` for tests. State lives in $FAKE_GH_STATE (JSON). Never talks to GitHub.
import fs from "node:fs";
const argv = process.argv.slice(2);
const stateFile = process.env.FAKE_GH_STATE;
const read = () => {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return { loggedIn: true, prs: {} };
  }
};
const write = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
const state = read();
if (process.env.FAKE_GH_LOG)
  fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(argv) + "\n");

if (argv[0] === "auth" && argv[1] === "status") {
  if (state.loggedIn) {
    process.stderr.write("github.com\n  ✓ Logged in to github.com account tester (keyring)\n");
    process.exit(0);
  }
  process.stderr.write("You are not logged into any GitHub hosts.\n");
  process.exit(1);
}
if (argv[0] === "pr" && argv[1] === "create") {
  const head = argv[argv.indexOf("--head") + 1];
  const title = argv[argv.indexOf("--title") + 1];
  const body = argv[argv.indexOf("--body") + 1];
  const number = Object.keys(state.prs).length + 1;
  state.prs[head] = {
    number,
    url: `https://github.com/example/repo/pull/${number}`,
    state: "OPEN",
    title,
    body,
    isDraft: argv.includes("--draft"),
    mergeable: "MERGEABLE",
    reviewDecision: "",
    statusCheckRollup: [
      {
        name: "CI",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        detailsUrl: "https://ci.example/1",
      },
      { name: "lint", status: "IN_PROGRESS", conclusion: "" },
    ],
    mergedAt: null,
    baseRefName: argv[argv.indexOf("--base") + 1],
    headRefName: head,
  };
  write(state);
  process.stdout.write(state.prs[head].url + "\n");
  process.exit(0);
}
if (argv[0] === "pr" && argv[1] === "view") {
  const pr = state.prs[argv[2]];
  if (!pr) {
    process.stderr.write('no pull requests found for branch "' + argv[2] + '"\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(pr) + "\n");
  process.exit(0);
}
if (argv[0] === "pr" && argv[1] === "merge") {
  const pr = Object.values(state.prs).find((p) => String(p.number) === argv[2]);
  if (!pr) {
    process.stderr.write("not found\n");
    process.exit(1);
  }
  pr.state = "MERGED";
  pr.mergedAt = new Date().toISOString();
  pr.mergeMethod = argv[3];
  write(state);
  process.stdout.write("✓ Merged\n");
  process.exit(0);
}
process.stderr.write("fake gh: unsupported " + argv.join(" ") + "\n");
process.exit(2);
