import path from "node:path";

/** Memorable workspace names; collisions get a numeric suffix. */
export const MUSICAL_TERMS: readonly string[] = [
  "adagio",
  "allegro",
  "andante",
  "aria",
  "arpeggio",
  "cadenza",
  "canon",
  "cantata",
  "chorale",
  "coda",
  "crescendo",
  "etude",
  "fermata",
  "forte",
  "fugue",
  "glissando",
  "harmony",
  "interlude",
  "largo",
  "legato",
  "lento",
  "libretto",
  "madrigal",
  "melody",
  "minuet",
  "motif",
  "nocturne",
  "octave",
  "opus",
  "ostinato",
  "overture",
  "pizzicato",
  "prelude",
  "presto",
  "refrain",
  "rhapsody",
  "rondo",
  "rubato",
  "scherzo",
  "serenade",
  "sonata",
  "staccato",
  "tempo",
  "tremolo",
  "trill",
  "vibrato",
  "vivace",
  "waltz",
];

export const WORKSPACE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const BRANCH_PREFIX_RE = /^[a-z0-9][a-z0-9._-]{0,30}$/i;

export function isValidWorkspaceName(name: string): boolean {
  return WORKSPACE_NAME_RE.test(name);
}

/** Lowercases and reduces arbitrary input to a valid workspace name; throws if nothing is left. */
export function sanitizeWorkspaceName(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  if (!isValidWorkspaceName(cleaned))
    throw new Error(`invalid workspace name: ${JSON.stringify(input)}`);
  return cleaned;
}

export function pickWorkspaceName(
  taken: ReadonlySet<string>,
  random: () => number = Math.random,
): string {
  const base = MUSICAL_TERMS[Math.floor(random() * MUSICAL_TERMS.length)] ?? "opus";
  if (!taken.has(base)) return base;
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("could not pick a free workspace name");
}

/** Conservative check mirroring git check-ref-format rules; git itself is consulted too. */
export function isValidBranchName(branch: string): boolean {
  if (branch.length === 0 || branch.length > 200) return false;
  if (branch.startsWith("-") || branch.startsWith("/") || branch.endsWith("/")) return false;
  if (branch.endsWith(".") || branch.endsWith(".lock")) return false;
  if (branch.includes("..") || branch.includes("@{") || branch.includes("//")) return false;
  if (branch === "@") return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(branch)) return false;
  return branch.split("/").every((c) => c.length > 0 && !c.startsWith(".") && !c.endsWith(".lock"));
}

export function branchNameFor(prefix: string, workspaceName: string): string {
  if (!BRANCH_PREFIX_RE.test(prefix))
    throw new Error(`invalid branch prefix: ${JSON.stringify(prefix)}`);
  if (!isValidWorkspaceName(workspaceName))
    throw new Error(`invalid workspace name: ${JSON.stringify(workspaceName)}`);
  const branch = `${prefix}/${workspaceName}`;
  if (!isValidBranchName(branch)) throw new Error(`invalid branch name: ${JSON.stringify(branch)}`);
  return branch;
}

/** Directory-safe slug for a repo, derived from its basename. */
export function repoSlug(repoPath: string): string {
  const base = path.basename(repoPath);
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return slug.length > 0 ? slug : "repo";
}
