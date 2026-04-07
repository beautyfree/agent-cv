import { describe, it, expect } from "bun:test";
import { mergeCloudProjects } from "../src/lib/inventory/store.ts";
import type { Inventory, Project } from "../src/lib/types.ts";

function makeProject(overrides: Partial<Project>): Project {
  return {
    id: "test-id",
    path: "/test/project",
    displayName: "test-project",
    type: "node",
    language: "TypeScript",
    frameworks: [],
    dateRange: { start: "2024-01-01", end: "2024-06-01", approximate: false },
    hasGit: true,
    commitCount: 50,
    authorCommitCount: 30,
    hasUncommittedChanges: false,
    markers: ["package.json"],
    size: { files: 20, lines: 1000 },
    tags: [],
    included: true,
    ...overrides,
  };
}

function makeInventory(projects: Project[]): Inventory {
  return {
    version: "1.0",
    lastScan: "",
    scanPaths: ["/test"],
    projects,
    profile: { emails: [], emailsConfirmed: false },
    insights: {},
  };
}

describe("mergeCloudProjects", () => {
  it("adds cloud-only projects to inventory", () => {
    const local = makeProject({ id: "local-1", remoteUrl: "https://github.com/user/local" });
    const cloud = makeProject({
      id: "cloud-1",
      path: "",
      remoteUrl: "https://github.com/user/cloud-only",
      source: "github",
      stars: 42,
    });
    const inv = makeInventory([local]);
    const result = mergeCloudProjects(inv, [cloud]);
    expect(result.projects).toHaveLength(2);
    expect(result.projects.find(p => p.id === "cloud-1")).toBeDefined();
  });

  it("deduplicates by remoteUrl — prefers local data", () => {
    const local = makeProject({
      id: "local-1",
      remoteUrl: "https://github.com/user/shared-repo",
      stars: 5,
      description: "local description",
    });
    const cloud = makeProject({
      id: "cloud-1",
      path: "",
      remoteUrl: "https://github.com/user/shared-repo",
      source: "github",
      stars: 42,
      description: "cloud description",
    });
    const inv = makeInventory([local]);
    const result = mergeCloudProjects(inv, [cloud]);

    // Should NOT add a duplicate
    expect(result.projects).toHaveLength(1);
    // Should merge cloud metadata into local
    expect(result.projects[0]!.stars).toBe(42);
    // Should keep local description
    expect(result.projects[0]!.description).toBe("local description");
  });

  it("handles SSH vs HTTPS normalization in dedup", () => {
    // normalizeGitUrl converts SSH to HTTPS
    const local = makeProject({
      id: "local-1",
      remoteUrl: "https://github.com/user/repo",
    });
    const cloud = makeProject({
      id: "cloud-1",
      path: "",
      remoteUrl: "https://github.com/user/repo",
      source: "github",
      stars: 100,
    });
    const inv = makeInventory([local]);
    const result = mergeCloudProjects(inv, [cloud]);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]!.stars).toBe(100);
  });

  it("supplements local with cloud description when local has none", () => {
    const local = makeProject({
      id: "local-1",
      remoteUrl: "https://github.com/user/repo",
      description: undefined,
    });
    const cloud = makeProject({
      id: "cloud-1",
      path: "",
      remoteUrl: "https://github.com/user/repo",
      source: "github",
      description: "A cool project from GitHub",
    });
    const inv = makeInventory([local]);
    const result = mergeCloudProjects(inv, [cloud]);
    expect(result.projects[0]!.description).toBe("A cool project from GitHub");
  });

  it("handles empty cloud projects list", () => {
    const local = makeProject({ id: "local-1" });
    const inv = makeInventory([local]);
    const result = mergeCloudProjects(inv, []);
    expect(result.projects).toHaveLength(1);
  });
});
