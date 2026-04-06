import { describe, test, expect } from "bun:test";
import {
  generateProfileInsights,
  detectDomains,
  type YearlyInsight,
} from "../src/lib/analysis/bio-generator.ts";
import type { AgentAdapter, Project, ProjectAnalysis, ProjectContext } from "../src/lib/types.ts";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "test-" + Math.random().toString(36).slice(2, 8),
    path: "/tmp/test",
    displayName: "test-project",
    type: "node",
    language: "TypeScript",
    frameworks: [],
    dateRange: { start: "2024-01-01", end: "2024-06-01", approximate: false },
    hasGit: true,
    commitCount: 10,
    authorCommitCount: 8,
    hasUncommittedChanges: false,
    lastCommit: "2024-06-01",
    markers: ["package.json"],
    size: { files: 5, lines: 500 },
    tags: [],
    included: true,
    significance: 50,
    tier: "primary" as const,
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<ProjectAnalysis> = {}): ProjectAnalysis {
  return {
    summary: "A test project for testing purposes.",
    techStack: ["TypeScript", "React"],
    contributions: ["Built the thing"],
    impactScore: 7,
    analyzedAt: new Date().toISOString(),
    analyzedBy: "test",
    ...overrides,
  };
}

function createMockAdapter(defaultResponse: string): AgentAdapter {
  return {
    name: "test",
    isAvailable: async () => true,
    analyze: async (ctx: ProjectContext) => {
      return {
        summary: defaultResponse,
        techStack: [],
        contributions: [],
        analyzedAt: new Date().toISOString(),
        analyzedBy: "test",
      };
    },
  };
}

describe("detectDomains", () => {
  test("detects frontend from React", () => {
    const projects = [makeProject({ frameworks: ["React"] })];
    const domains = detectDomains(projects);
    expect(domains.has("frontend")).toBe(true);
  });

  test("detects crypto from Solana tech stack", () => {
    const projects = [makeProject({
      analysis: makeAnalysis({ techStack: ["Solana", "@solana/web3.js"] }),
    })];
    const domains = detectDomains(projects);
    expect(domains.has("crypto/web3")).toBe(true);
  });

  test("detects Rust/systems from language", () => {
    const projects = [makeProject({ language: "Rust" })];
    const domains = detectDomains(projects);
    expect(domains.has("Rust/systems")).toBe(true);
  });

  test("detects multiple domains", () => {
    const projects = [
      makeProject({ frameworks: ["React", "Express"], language: "TypeScript" }),
      makeProject({ language: "Rust", analysis: makeAnalysis({ techStack: ["Tokio", "Axum"] }) }),
    ];
    const domains = detectDomains(projects);
    expect(domains.has("frontend")).toBe(true);
    expect(domains.has("backend")).toBe(true);
    expect(domains.has("Rust/systems")).toBe(true);
  });

  test("returns empty set for unknown tech", () => {
    const projects = [makeProject({ language: "Unknown", frameworks: [] })];
    const domains = detectDomains(projects);
    expect(domains.size).toBe(0);
  });
});

describe("generateProfileInsights", () => {
  test("returns null when no analyzed projects", async () => {
    const projects = [makeProject()]; // no analysis
    const adapter = createMockAdapter("{}");
    const result = await generateProfileInsights(projects, adapter);
    expect(result).toBeNull();
  });

  test("generates insights with per-year pipeline", async () => {
    const projects = [
      makeProject({
        displayName: "my-app",
        dateRange: { start: "2024-01-01", end: "2024-06-01", approximate: false },
        analysis: makeAnalysis(),
        significance: 80,
        tier: "primary",
        authorCommitCount: 50,
      }),
      makeProject({
        displayName: "my-api",
        dateRange: { start: "2024-03-01", end: "2024-09-01", approximate: false },
        analysis: makeAnalysis({ techStack: ["Express", "PostgreSQL"] }),
        significance: 60,
        tier: "secondary",
        authorCommitCount: 30,
      }),
      makeProject({
        displayName: "old-tool",
        dateRange: { start: "2023-01-01", end: "2023-12-01", approximate: false },
        analysis: makeAnalysis({ techStack: ["Rust", "CLI"] }),
        significance: 40,
        tier: "primary",
        authorCommitCount: 20,
      }),
    ];

    // Response that satisfies both per-year and aggregate prompts
    const adapter = createMockAdapter(JSON.stringify({
      focus: "Built things this year",
      highlights: ["my-app"],
      skills: ["Development"],
      domains: ["frontend"],
      bio: "Full-stack developer shipping real products.",
      narrative: "Started with Rust CLI tools, then moved to web.",
      strongestSkills: ["Full-stack web", "CLI tools", "API design", "Rust", "Solo shipping"],
      uniqueTraits: ["Builds CLI and web", "Solo products", "Wide range"],
    }));

    const result = await generateProfileInsights(projects, adapter);
    expect(result).not.toBeNull();
    expect(result!.bio).toBeTruthy();
    expect(result!.narrative).toBeTruthy();
    expect(result!.strongestSkills.length).toBeGreaterThan(0);
    expect(result!.uniqueTraits.length).toBeGreaterThan(0);
    expect(result!.yearlyThemes.length).toBe(2); // 2023 + 2024
    expect(result!.yearlyInsights!.length).toBe(2);
    expect(result!.highlightsByYear).toBeDefined();
  });

  test("uses metadata fallback for thin years", async () => {
    const projects = [
      // 2024 has 3 analyzed projects → LLM call
      makeProject({
        displayName: "app-a",
        dateRange: { start: "2024-01-01", end: "2024-12-01", approximate: false },
        analysis: makeAnalysis(),
        significance: 80,
      }),
      makeProject({
        displayName: "app-b",
        dateRange: { start: "2024-02-01", end: "2024-11-01", approximate: false },
        analysis: makeAnalysis(),
        significance: 60,
      }),
      makeProject({
        displayName: "app-c",
        dateRange: { start: "2024-03-01", end: "2024-10-01", approximate: false },
        analysis: makeAnalysis(),
        significance: 40,
      }),
      // 2023 has 1 analyzed project → metadata fallback
      makeProject({
        displayName: "tiny-tool",
        dateRange: { start: "2023-06-01", end: "2023-06-01", approximate: false },
        analysis: makeAnalysis(),
        significance: 20,
      }),
    ];

    let llmCallCount = 0;
    const adapter: AgentAdapter = {
      name: "test",
      isAvailable: async () => true,
      analyze: async () => {
        llmCallCount++;
        return {
          summary: JSON.stringify({
            focus: "Built web apps",
            highlights: ["app-a"],
            skills: ["Web dev"],
            domains: ["frontend"],
          }),
          techStack: [],
          contributions: [],
          analyzedAt: new Date().toISOString(),
          analyzedBy: "test",
        };
      },
    };

    const result = await generateProfileInsights(projects, adapter);
    expect(result).not.toBeNull();

    // 2023 should be metadata fallback (≤2 analyzed projects)
    const insight2023 = result!.yearlyInsights!.find((yi) => yi.year === "2023");
    expect(insight2023).toBeDefined();
    expect(insight2023!.source).toBe("metadata");

    // 2024 should be LLM-generated
    const insight2024 = result!.yearlyInsights!.find((yi) => yi.year === "2024");
    expect(insight2024).toBeDefined();
    expect(insight2024!.source).toBe("llm");
  });

  test("handles adapter failure on one year gracefully", async () => {
    let callCount = 0;
    const adapter: AgentAdapter = {
      name: "test",
      isAvailable: async () => true,
      analyze: async () => {
        callCount++;
        if (callCount === 1) throw new Error("LLM failed");
        return {
          summary: JSON.stringify({
            focus: "Built things",
            highlights: ["proj"],
            skills: ["Development"],
            domains: ["frontend"],
          }),
          techStack: [],
          contributions: [],
          analyzedAt: new Date().toISOString(),
          analyzedBy: "test",
        };
      },
    };

    const projects = [
      // Year 1 — will fail
      ...Array.from({ length: 3 }, (_, i) =>
        makeProject({
          displayName: `fail-${i}`,
          dateRange: { start: "2023-01-01", end: "2023-12-01", approximate: false },
          analysis: makeAnalysis(),
          significance: 50 - i * 10,
        })
      ),
      // Year 2 — will succeed
      ...Array.from({ length: 3 }, (_, i) =>
        makeProject({
          displayName: `ok-${i}`,
          dateRange: { start: "2024-01-01", end: "2024-12-01", approximate: false },
          analysis: makeAnalysis(),
          significance: 50 - i * 10,
        })
      ),
    ];

    const result = await generateProfileInsights(projects, adapter);
    expect(result).not.toBeNull();
    // Both years should be in results (failed year gets metadata fallback)
    expect(result!.yearlyInsights!.length).toBe(2);
    // First call fails — with newest-first ordering, 2024 is processed first and fails
    const failed = result!.yearlyInsights!.find((yi) => yi.year === "2024");
    expect(failed!.source).toBe("metadata"); // fallback on failure
  });

  test("handles malformed JSON from per-year LLM call", async () => {
    let callCount = 0;
    const adapter: AgentAdapter = {
      name: "test",
      isAvailable: async () => true,
      analyze: async () => {
        callCount++;
        // First call (per-year) returns garbage, second (aggregate) returns valid
        const response = callCount === 1
          ? "This is not JSON"
          : JSON.stringify({
              bio: "A developer.", narrative: "They built.",
              strongestSkills: ["Coding"], uniqueTraits: ["Persistent"],
            });
        return {
          summary: response, techStack: [], contributions: [],
          analyzedAt: new Date().toISOString(), analyzedBy: "test",
        };
      },
    };

    const projects = Array.from({ length: 3 }, (_, i) =>
      makeProject({
        displayName: `proj-${i}`,
        dateRange: { start: "2024-01-01", end: "2024-12-01", approximate: false },
        analysis: makeAnalysis(),
        significance: 50,
      })
    );

    const result = await generateProfileInsights(projects, adapter);
    expect(result).not.toBeNull();
    // Per-year should have fallen back to metadata
    const yi = result!.yearlyInsights!.find((y) => y.year === "2024");
    expect(yi!.source).toBe("metadata");
  });
});
