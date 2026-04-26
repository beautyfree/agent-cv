import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getCachedAnalysis,
  setCachedAnalysis,
} from "@agent-cv/core/src/analysis/cache.ts";
import type { ProjectContext, ProjectAnalysis } from "@agent-cv/core/src/types.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-cv-llm-cache-"));
  process.env.AGENT_CV_DATA_DIR = tmpDir;
  delete process.env.AGENT_CV_NO_CACHE;
});

afterEach(() => {
  delete process.env.AGENT_CV_DATA_DIR;
  delete process.env.AGENT_CV_NO_CACHE;
  rmSync(tmpDir, { recursive: true, force: true });
});

const ctx = (overrides: Partial<ProjectContext> = {}): ProjectContext => ({
  path: "/tmp/x",
  readme: "# A",
  dependencies: "{}",
  directoryTree: "src/",
  gitShortlog: "1\tA <a@b.c>",
  recentCommits: "abc First",
  isOwner: true,
  authorCommitCount: 1,
  commitCount: 1,
  displayName: "x",
  ...overrides,
});

const sampleResult: ProjectAnalysis = {
  summary: "A thing.",
  techStack: ["TS"],
  contributions: ["Built it"],
  analyzedAt: "2026-04-01T00:00:00Z",
  analyzedBy: "test",
};

describe("llm cache", () => {
  it("returns null on miss", async () => {
    const r = await getCachedAnalysis(ctx(), "claude", "3");
    expect(r).toBeNull();
  });

  it("round-trips a result", async () => {
    await setCachedAnalysis(ctx(), "claude", "3", sampleResult);
    const r = await getCachedAnalysis(ctx(), "claude", "3");
    expect(r).toEqual(sampleResult);
  });

  it("isolates by adapter", async () => {
    await setCachedAnalysis(ctx(), "claude", "3", sampleResult);
    const r = await getCachedAnalysis(ctx(), "ollama", "3");
    expect(r).toBeNull();
  });

  it("isolates by promptVersion", async () => {
    await setCachedAnalysis(ctx(), "claude", "3", sampleResult);
    const r = await getCachedAnalysis(ctx(), "claude", "4");
    expect(r).toBeNull();
  });

  it("ignores path/displayName for hash equality", async () => {
    await setCachedAnalysis(ctx({ path: "/a/x", displayName: "x" }), "claude", "3", sampleResult);
    const r = await getCachedAnalysis(ctx({ path: "/b/x", displayName: "x-clone" }), "claude", "3");
    expect(r).toEqual(sampleResult);
  });

  it("invalidates on changed README", async () => {
    await setCachedAnalysis(ctx({ readme: "# A" }), "claude", "3", sampleResult);
    const r = await getCachedAnalysis(ctx({ readme: "# B" }), "claude", "3");
    expect(r).toBeNull();
  });

  it("AGENT_CV_NO_CACHE=1 disables read and write", async () => {
    process.env.AGENT_CV_NO_CACHE = "1";
    await setCachedAnalysis(ctx(), "claude", "3", sampleResult);
    const r = await getCachedAnalysis(ctx(), "claude", "3");
    expect(r).toBeNull();
  });
});
