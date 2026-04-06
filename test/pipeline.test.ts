import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { analyzeProjects, type ProjectStatus } from "../src/lib/pipeline.ts";
import type { AgentAdapter, Project, ProjectAnalysis, ProjectContext, Inventory } from "../src/lib/types.ts";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

beforeEach(async () => {
  process.env.AGENT_CV_DATA_DIR = await mkdtemp(join(tmpdir(), "agent-cv-pipeline-test-"));
});
afterAll(() => {
  delete process.env.AGENT_CV_DATA_DIR;
});

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "test-" + Math.random().toString(36).slice(2, 8),
    path: "/tmp/test-project",
    displayName: "test-project",
    type: "node",
    language: "TypeScript",
    frameworks: [],
    dateRange: { start: "2024-01-01", end: "2024-06-01", approximate: false },
    hasGit: false, // no git to avoid buildProjectContext needing real repo
    commitCount: 0,
    authorCommitCount: 0,
    hasUncommittedChanges: false,
    markers: ["package.json"],
    size: { files: 5, lines: 500 },
    tags: [],
    included: true,
    ...overrides,
  };
}

function makeInventory(projects: Project[]): Inventory {
  return {
    version: "1.0",
    lastScan: new Date().toISOString(),
    scanPaths: ["/tmp"],
    projects,
    profile: { emails: [], emailsConfirmed: false },
    insights: {},
  };
}

function createMockAdapter(behavior: {
  failCount?: number;
  failMessage?: string;
  response?: Partial<ProjectAnalysis>;
} = {}): AgentAdapter {
  const { failCount = 0, failMessage = "API error 500: Internal Server Error", response = {} } = behavior;
  let callCount = 0;
  return {
    name: "test",
    isAvailable: async () => true,
    analyze: async (_ctx: ProjectContext): Promise<ProjectAnalysis> => {
      callCount++;
      if (callCount <= failCount) {
        throw new Error(failMessage);
      }
      return {
        summary: response.summary || "A test project.",
        techStack: response.techStack || ["TypeScript"],
        contributions: response.contributions || ["Built it"],
        impactScore: response.impactScore || 5,
        analyzedAt: new Date().toISOString(),
        analyzedBy: "test",
      };
    },
  };
}

describe("analyzeProjects", () => {
  test("analyzes projects successfully", async () => {
    const projects = [makeProject({ displayName: "proj-a" }), makeProject({ displayName: "proj-b" })];
    const inventory = makeInventory(projects);
    const adapter = createMockAdapter();

    const result = await analyzeProjects(projects, adapter, inventory);

    expect(result.analyzed).toBe(2);
    expect(result.failed.length).toBe(0);
    expect(projects[0].analysis).toBeDefined();
    expect(projects[1].analysis).toBeDefined();
  });

  test("retries transient errors and succeeds", async () => {
    const projects = [makeProject({ displayName: "flaky-proj" })];
    const inventory = makeInventory(projects);
    // Fails once with 500 (transient), then succeeds
    const adapter = createMockAdapter({ failCount: 1, failMessage: "API error 500: Internal Server Error" });

    const statuses: Array<{ id: string; status: ProjectStatus; detail?: string }> = [];
    const result = await analyzeProjects(projects, adapter, inventory, {
      onProjectStatus: (id, status, detail) => statuses.push({ id, status, detail }),
    });

    expect(result.analyzed).toBe(1);
    expect(result.failed.length).toBe(0);
    // Should have reported retry status
    const retryStatus = statuses.find((s) => s.detail?.includes("retry"));
    expect(retryStatus).toBeDefined();
  });

  test("does not retry permanent errors", async () => {
    const projects = [makeProject({ displayName: "bad-proj" })];
    const inventory = makeInventory(projects);
    // Permanent error (empty summary) should not be retried
    const adapter = createMockAdapter({ failCount: 99, failMessage: "Analysis has empty summary" });

    const result = await analyzeProjects(projects, adapter, inventory);

    expect(result.analyzed).toBe(0);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0].error).toContain("empty summary");
  });

  test("fails after exhausting retries on transient error", async () => {
    const projects = [makeProject({ displayName: "doomed-proj" })];
    const inventory = makeInventory(projects);
    // Fails 5 times (more than max 3 retries) with transient error
    // Note: this test takes ~6s due to backoff (2s + 4s)
    const adapter = createMockAdapter({ failCount: 5, failMessage: "API error 429: rate limit exceeded" });

    const result = await analyzeProjects(projects, adapter, inventory);

    expect(result.analyzed).toBe(0);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0].error).toContain("429");
  }, 15_000);

  test("handles mixed success and failure in a batch", async () => {
    const goodProj = makeProject({ displayName: "good-proj", path: "/tmp/good-project" });
    const badProj = makeProject({ displayName: "bad-proj", path: "/tmp/bad-project" });
    const projects = [goodProj, badProj];
    const inventory = makeInventory(projects);

    const adapter: AgentAdapter = {
      name: "test",
      isAvailable: async () => true,
      analyze: async (ctx: ProjectContext) => {
        if (ctx.path === "/tmp/bad-project") {
          throw new Error("Analysis has empty techStack");
        }
        return {
          summary: "Good project.",
          techStack: ["TypeScript"],
          contributions: ["Built it"],
          analyzedAt: new Date().toISOString(),
          analyzedBy: "test",
        };
      },
    };

    const result = await analyzeProjects(projects, adapter, inventory);

    expect(result.analyzed).toBe(1);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0].project.displayName).toBe("bad-proj");
    expect(goodProj.analysis).toBeDefined();
    expect(badProj.analysis).toBeUndefined();
  });

  test("reports project statuses via callback", async () => {
    const projects = [makeProject({ displayName: "status-proj" })];
    const inventory = makeInventory(projects);
    const adapter = createMockAdapter();

    const statuses: Array<{ id: string; status: ProjectStatus }> = [];
    await analyzeProjects(projects, adapter, inventory, {
      onProjectStatus: (id, status) => statuses.push({ id, status }),
    });

    const statusSequence = statuses.map((s) => s.status);
    expect(statusSequence).toContain("queued");
    expect(statusSequence).toContain("analyzing");
    expect(statusSequence).toContain("done");
  });

  test("skips cached projects", async () => {
    const cachedProj = makeProject({
      displayName: "cached-proj",
      analysis: {
        summary: "Already analyzed.",
        techStack: ["TypeScript"],
        contributions: ["Done"],
        analyzedAt: new Date().toISOString(),
        analyzedBy: "test",
        analyzedAtCommit: "files:5:2024-06-01",
        promptVersion: "2",
      },
    });
    const newProj = makeProject({ displayName: "new-proj" });
    const projects = [cachedProj, newProj];
    const inventory = makeInventory(projects);
    const adapter = createMockAdapter();

    const result = await analyzeProjects(projects, adapter, inventory);

    expect(result.skipped).toBe(1);
    expect(result.analyzed).toBe(1);
  });

  test("retries timeout errors", async () => {
    const projects = [makeProject({ displayName: "timeout-proj" })];
    const inventory = makeInventory(projects);
    // Fails once with timeout (transient), then succeeds
    const adapter = createMockAdapter({ failCount: 1, failMessage: "API request timed out after 120s" });

    const result = await analyzeProjects(projects, adapter, inventory);

    expect(result.analyzed).toBe(1);
    expect(result.failed.length).toBe(0);
  });

  test("circuit breaker stops after 3 consecutive batch failures", async () => {
    // Simulate 12 projects, adapter always fails (e.g. billing expired)
    const projects = Array.from({ length: 12 }, (_, i) =>
      makeProject({ displayName: `proj-${i}`, path: `/tmp/proj-${i}` })
    );
    const inventory = makeInventory(projects);
    let adapterCallCount = 0;
    const adapter: AgentAdapter = {
      name: "test",
      isAvailable: async () => true,
      analyze: async () => {
        adapterCallCount++;
        throw new Error("Cursor agent exited with code 1: billing expired");
      },
    };

    const result = await analyzeProjects(projects, adapter, inventory);

    expect(result.analyzed).toBe(0);
    expect(result.failed.length).toBe(12);
    // Circuit breaker should trip after 3 batches (9 projects attempted),
    // remaining 3 should be skipped without calling the adapter
    // Batch size is 3, so 3 batches = 9 adapter calls
    expect(adapterCallCount).toBe(9);
  });

  test("circuit breaker resets on success", async () => {
    // 9 projects: first 6 fail (2 batches), then batch 3 succeeds, then batch 4 fails
    const projects = Array.from({ length: 12 }, (_, i) =>
      makeProject({ displayName: `proj-${i}`, path: `/tmp/proj-${i}` })
    );
    const inventory = makeInventory(projects);
    let callIndex = 0;
    const adapter: AgentAdapter = {
      name: "test",
      isAvailable: async () => true,
      analyze: async (ctx: ProjectContext) => {
        callIndex++;
        // Batches 1-2 fail (calls 1-6), batch 3 succeeds (calls 7-9), batch 4 fails (calls 10-12)
        if (callIndex <= 6 || callIndex >= 10) {
          throw new Error("Cursor agent exited with code 1: billing expired");
        }
        return {
          summary: "Works.", techStack: ["TS"], contributions: ["Built"],
          analyzedAt: new Date().toISOString(), analyzedBy: "test",
        };
      },
    };

    const result = await analyzeProjects(projects, adapter, inventory);

    // Batch 3 succeeded (3 projects), so circuit breaker reset.
    // All 12 projects should have been attempted (no early stop).
    expect(result.analyzed).toBe(3);
    expect(result.failed.length).toBe(9);
  });

  test("retries rate limit errors", async () => {
    const projects = [makeProject({ displayName: "ratelimit-proj" })];
    const inventory = makeInventory(projects);
    // Fails once with rate limit, then succeeds
    const adapter = createMockAdapter({ failCount: 1, failMessage: "429 rate limit exceeded" });

    const result = await analyzeProjects(projects, adapter, inventory);

    expect(result.analyzed).toBe(1);
    expect(result.failed.length).toBe(0);
  });
});
