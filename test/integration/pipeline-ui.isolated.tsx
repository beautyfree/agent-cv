/**
 * Not named *.test.* so `bun test` does not load it in the main suite (mock.module would leak).
 * Executed only via `test/pipeline-ui-runner.test.ts` subprocess.
 */
import { describe, expect, mock, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";

async function waitForFrame(
  lastFrame: () => string | undefined,
  predicate: (s: string) => boolean,
  timeoutMs = 4000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const f = lastFrame();
    if (f !== undefined && predicate(f)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timeout waiting for frame; last: ${lastFrame() ?? "(empty)"}`);
}

describe("Pipeline (integration, mocked core)", () => {
  test("renders telemetry notice (first run) and scanning UI while scan is in progress", async () => {
    mock.module("@agent-cv/core/src/telemetry.ts", () => ({
      // false => machine sets showTelemetryNotice; matches first-time prompt before user opts out
      markNoticeSeen: async () => false,
      track: mock(() => Promise.resolve()),
      trackPipelineStep: mock(() => Promise.resolve()),
    }));

    mock.module("@agent-cv/core/src/inventory/store.ts", () => ({
      readInventory: async () => ({
        version: "1",
        lastScan: "",
        scanPaths: [],
        projects: [],
        profile: { emails: [], emailsConfirmed: false },
        insights: {},
      }),
      writeInventory: mock(() => Promise.resolve()),
    }));

    mock.module("@agent-cv/core/src/pipeline.ts", () => ({
      scanAndMerge: () =>
        new Promise(() => {
          /* never resolves — keeps Pipeline in scanning */
        }),
      collectEmails: async () => ({ emailCounts: new Map(), preSelected: new Set<string>() }),
      recountAndTag: async (projects: unknown) => projects,
      analyzeProjects: async () => ({
        analyzed: 0,
        failed: [] as { project: unknown; error: string }[],
        skipped: 0,
        durationMs: 0,
      }),
      shouldSkipPhases: () => ({ skipEmails: false, skipSelector: false, skipAgent: false }),
      detectProjectGroups: mock(() => {}),
      detectProjectGroupsFromRemotes: mock(() => {}),
    }));

    mock.module("@agent-cv/core/src/discovery/github-scanner.ts", () => ({
      detectGitHubUsername: () => null,
    }));

    mock.module("@agent-cv/core/src/pipeline/github-cloud-phase.ts", () => ({
      mergeGitHubCloudIntoScanResult: async (input: { inventory: unknown; projects: unknown }) => ({
        inventory: input.inventory,
        projects: input.projects,
        applied: false,
      }),
    }));

    mock.module("@agent-cv/core/src/analysis/adapters/resolve-adapter.ts", () => ({
      resolveAdapter: async () => {
        throw new Error("not used in this test");
      },
    }));

    mock.module("@agent-cv/core/src/insights/bio-generator.ts", () => ({
      generateProfileInsights: async () => null,
    }));

    const { Pipeline } = await import("../../src/components/Pipeline.tsx");

    const dir = "/tmp/agent-cv-pipeline-ui-test";
    const { lastFrame, unmount } = render(
      <Pipeline options={{ directory: dir, dryRun: true }} onComplete={() => {}} onError={() => {}} />
    );

    await waitForFrame(lastFrame, (s) =>
      s.includes("Scanning") && s.includes(dir)
    );
    unmount();
  });
});
