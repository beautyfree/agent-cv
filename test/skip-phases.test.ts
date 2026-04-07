import { describe, it, expect } from "bun:test";
import { shouldSkipPhases } from "../src/lib/pipeline.ts";
import type { Inventory, Project } from "../src/lib/types.ts";

function makeProject(overrides: Partial<Project> = {}): Project {
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

function makeInventory(overrides: Partial<Inventory> = {}): Inventory {
  return {
    version: "1.0",
    lastScan: "",
    scanPaths: ["/test"],
    projects: [],
    profile: { emails: [], emailsConfirmed: false },
    insights: {},
    ...overrides,
  };
}

describe("shouldSkipPhases", () => {
  describe("skipEmails", () => {
    it("skips when emails are confirmed", () => {
      const inv = makeInventory({ profile: { emails: ["a@b.com"], emailsConfirmed: true } });
      const result = shouldSkipPhases(inv, [], {});
      expect(result.skipEmails).toBe(true);
    });

    it("does not skip on first run (not confirmed)", () => {
      const inv = makeInventory();
      const result = shouldSkipPhases(inv, [], {});
      expect(result.skipEmails).toBe(false);
    });

    it("does not skip with --interactive", () => {
      const inv = makeInventory({ profile: { emails: ["a@b.com"], emailsConfirmed: true } });
      const result = shouldSkipPhases(inv, [], { interactive: true });
      expect(result.skipEmails).toBe(false);
    });
  });

  describe("skipSelector", () => {
    it("skips when no new projects and selections saved", () => {
      const projects = [
        makeProject({ id: "1", included: true, tags: [] }),
        makeProject({ id: "2", included: false, tags: [] }),
      ];
      const inv = makeInventory();
      const result = shouldSkipPhases(inv, projects, {});
      expect(result.skipSelector).toBe(true);
    });

    it("does not skip when new projects exist", () => {
      const projects = [
        makeProject({ id: "1", included: true, tags: ["new"] }),
      ];
      const inv = makeInventory();
      const result = shouldSkipPhases(inv, projects, {});
      expect(result.skipSelector).toBe(false);
    });

    it("does not skip on first run (no saved selections)", () => {
      // On first scan, projects have included=undefined (never been through selector)
      const projects = [
        makeProject({ id: "1", tags: [], included: undefined as any }),
      ];
      const inv = makeInventory();
      const result = shouldSkipPhases(inv, projects, {});
      expect(result.skipSelector).toBe(false);
    });

    it("skips when --all was used (all included=true)", () => {
      const projects = [
        makeProject({ id: "1", included: true, tags: [] }),
        makeProject({ id: "2", included: true, tags: [] }),
      ];
      const inv = makeInventory();
      const result = shouldSkipPhases(inv, projects, {});
      expect(result.skipSelector).toBe(true);
    });

    it("does not skip with --interactive", () => {
      const projects = [
        makeProject({ id: "1", included: true, tags: [] }),
      ];
      const inv = makeInventory();
      const result = shouldSkipPhases(inv, projects, { interactive: true });
      expect(result.skipSelector).toBe(false);
    });
  });

  describe("skipAgent", () => {
    it("skips when lastAgent is saved", () => {
      const inv = makeInventory({ lastAgent: "claude" } as any);
      const result = shouldSkipPhases(inv, [], {});
      expect(result.skipAgent).toBe(true);
    });

    it("skips when --agent flag provided", () => {
      const inv = makeInventory();
      const result = shouldSkipPhases(inv, [], { agent: "codex" });
      expect(result.skipAgent).toBe(true);
    });

    it("does not skip on first run (no lastAgent)", () => {
      const inv = makeInventory();
      const result = shouldSkipPhases(inv, [], {});
      expect(result.skipAgent).toBe(false);
    });

    it("does not skip with --interactive", () => {
      const inv = makeInventory({ lastAgent: "claude" } as any);
      const result = shouldSkipPhases(inv, [], { interactive: true });
      expect(result.skipAgent).toBe(false);
    });
  });

  describe("--interactive overrides all", () => {
    it("never skips anything with --interactive", () => {
      const inv = makeInventory({
        profile: { emails: ["a@b.com"], emailsConfirmed: true },
        lastAgent: "claude",
      } as any);
      const projects = [makeProject({ included: true, tags: [] })];
      const result = shouldSkipPhases(inv, projects, { interactive: true });
      expect(result.skipEmails).toBe(false);
      expect(result.skipSelector).toBe(false);
      expect(result.skipAgent).toBe(false);
    });
  });
});
