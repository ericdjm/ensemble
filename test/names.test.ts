import { describe, expect, it } from "vitest";
import {
  branchNameFor,
  isValidBranchName,
  pickWorkspaceName,
  repoSlug,
  sanitizeWorkspaceName,
} from "../server/names.js";

describe("workspace names", () => {
  it("sanitizes arbitrary input", () => {
    expect(sanitizeWorkspaceName("My Feature!!")).toBe("my-feature");
    expect(sanitizeWorkspaceName("  --weird__name--  ")).toBe("weird-name");
    expect(sanitizeWorkspaceName("a".repeat(60))).toHaveLength(40);
    expect(() => sanitizeWorkspaceName("!!!")).toThrow();
    expect(() => sanitizeWorkspaceName("../etc")).not.toThrow();
    expect(sanitizeWorkspaceName("../etc")).toBe("etc");
  });

  it("picks unique memorable names", () => {
    const first = pickWorkspaceName(new Set(), () => 0);
    expect(first).toBe("adagio");
    expect(pickWorkspaceName(new Set(["adagio"]), () => 0)).toBe("adagio-2");
    expect(pickWorkspaceName(new Set(["adagio", "adagio-2"]), () => 0)).toBe("adagio-3");
  });

  it("validates branch names", () => {
    expect(isValidBranchName("ens/allegro")).toBe(true);
    expect(isValidBranchName("ens/..x")).toBe(false);
    expect(isValidBranchName("-x")).toBe(false);
    expect(isValidBranchName("a b")).toBe(false);
    expect(isValidBranchName("x.lock")).toBe(false);
    expect(isValidBranchName("a//b")).toBe(false);
    expect(isValidBranchName("a/.b")).toBe(false);
    expect(branchNameFor("ens", "allegro")).toBe("ens/allegro");
    expect(() => branchNameFor("bad prefix", "allegro")).toThrow();
    expect(() => branchNameFor("ens", "Bad Name")).toThrow();
  });

  it("slugs repo paths", () => {
    expect(repoSlug("/Users/me/code/My Project")).toBe("my-project");
    expect(repoSlug("/x/.hidden")).toBe("hidden");
    expect(repoSlug("/x/!!!")).toBe("repo");
  });
});
