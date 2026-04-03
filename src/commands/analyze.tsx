import React, { useEffect, useState } from "react";
import { Text, Box } from "ink";
import { z } from "zod/v4";
import { resolveAdapter } from "../lib/analysis/resolve-adapter.ts";
import { buildProjectContext } from "../lib/analysis/context-builder.ts";
import {
  readInventory,
  writeInventory,
} from "../lib/inventory/store.ts";
import type { ProjectAnalysis } from "../lib/types.ts";

export const args = z.tuple([
  z.string().describe("Path to the project to analyze"),
]);

export const options = z.object({
  agent: z
    .string()
    .default("auto")
    .describe("Agent to use: auto, claude, codex, api"),
});

type Props = {
  args: z.infer<typeof args>;
  options: z.infer<typeof options>;
};

export default function Analyze({ args: [projectPath], options: { agent } }: Props) {
  const [status, setStatus] = useState<
    "checking" | "building" | "analyzing" | "done" | "error"
  >("checking");
  const [analysis, setAnalysis] = useState<ProjectAnalysis | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    async function run() {
      try {
        let resolved;
        try {
          resolved = await resolveAdapter(agent);
        } catch (err: any) {
          setError(err.message);
          setStatus("error");
          return;
        }
        const adapter = resolved.adapter;

        // Find project in inventory or build a minimal one
        setStatus("building");
        const inventory = await readInventory();
        let project = inventory.projects.find(
          (p) => p.path === projectPath || p.path.endsWith("/" + projectPath)
        );

        if (!project) {
          // Project not in inventory, create a minimal one for context building
          const { resolve } = await import("node:path");
          const absPath = resolve(projectPath);
          project = {
            id: "temp",
            path: absPath,
            displayName: projectPath.split("/").pop() || projectPath,
            type: "unknown",
            language: "Unknown",
            frameworks: [],
            dateRange: { start: "", end: "", approximate: true },
            hasGit: true,
            commitCount: 0,
            authorCommitCount: 0,
            markers: [],
            size: { files: 0, lines: 0 },
            tags: [],
            included: true,
          };
        }

        const context = await buildProjectContext(project);

        setStatus("analyzing");
        const result = await adapter.analyze(context);
        setAnalysis(result);

        // Save analysis back to inventory if project exists there
        if (project.id !== "temp") {
          project.analysis = result;
          await writeInventory(inventory);
        }

        setStatus("done");
      } catch (err: any) {
        setError(err.message);
        setStatus("error");
      }
    }
    run();
  }, [projectPath, agent]);

  if (status === "error") {
    return <Text color="red">Error: {error}</Text>;
  }

  if (status === "checking") {
    return <Text color="yellow">Checking agent availability...</Text>;
  }

  if (status === "building") {
    return <Text color="yellow">Building project context...</Text>;
  }

  if (status === "analyzing") {
    return <Text color="yellow">Analyzing with {agent}... (this may take a minute)</Text>;
  }

  if (!analysis) {
    return <Text color="yellow">Processing...</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text color="green" bold>Analysis complete</Text>
      <Text> </Text>
      <Text bold>Summary:</Text>
      <Text>{analysis.summary}</Text>
      <Text> </Text>
      <Text bold>Tech Stack:</Text>
      <Text>{analysis.techStack.join(", ")}</Text>
      <Text> </Text>
      <Text bold>Key Contributions:</Text>
      {analysis.contributions.map((c, i) => (
        <Text key={i}>  - {c}</Text>
      ))}
    </Box>
  );
}

export const description = "Analyze a single project using an AI agent";
