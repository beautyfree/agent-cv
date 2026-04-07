import { describe, it, expect } from "bun:test";
import { detectGitHubUsername } from "../src/lib/discovery/github-scanner.ts";
import type { Inventory } from "../src/lib/types.ts";

function makeInventory(projects: Array<{ remoteUrl?: string }>): Inventory {
  return {
    version: "1.0",
    lastScan: "",
    scanPaths: [],
    projects: projects.map((p, i) => ({
      id: String(i),
      path: `/test/${i}`,
      displayName: `project-${i}`,
      type: "node",
      language: "TypeScript",
      frameworks: [],
      dateRange: { start: "", end: "", approximate: true },
      hasGit: true,
      commitCount: 10,
      authorCommitCount: 5,
      hasUncommittedChanges: false,
      markers: [],
      size: { files: 10, lines: 100 },
      tags: [],
      included: true,
      remoteUrl: p.remoteUrl,
    })),
    profile: { emails: [], emailsConfirmed: false },
    insights: {},
  };
}

describe("detectGitHubUsername", () => {
  it("extracts username from HTTPS remoteUrls", () => {
    const inv = makeInventory([
      { remoteUrl: "https://github.com/beautyfree/llm-cv" },
      { remoteUrl: "https://github.com/beautyfree/other-repo" },
    ]);
    expect(detectGitHubUsername(inv)).toBe("beautyfree");
  });

  it("extracts username from SSH remoteUrls (normalized)", () => {
    const inv = makeInventory([
      { remoteUrl: "https://github.com/testuser/repo1" },
      { remoteUrl: "https://github.com/testuser/repo2" },
    ]);
    expect(detectGitHubUsername(inv)).toBe("testuser");
  });

  it("picks the most common username when multiple exist", () => {
    const inv = makeInventory([
      { remoteUrl: "https://github.com/alice/repo1" },
      { remoteUrl: "https://github.com/bob/repo2" },
      { remoteUrl: "https://github.com/alice/repo3" },
      { remoteUrl: "https://github.com/alice/repo4" },
    ]);
    expect(detectGitHubUsername(inv)).toBe("alice");
  });

  it("returns null when no GitHub remoteUrls exist", () => {
    const inv = makeInventory([
      { remoteUrl: "https://gitlab.com/user/repo" },
      { remoteUrl: undefined },
    ]);
    expect(detectGitHubUsername(inv)).toBeNull();
  });

  it("returns null for empty inventory", () => {
    const inv = makeInventory([]);
    expect(detectGitHubUsername(inv)).toBeNull();
  });
});
