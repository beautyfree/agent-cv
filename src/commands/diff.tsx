import React, { useEffect, useState } from "react";
import { Text, Box } from "ink";
import { z } from "zod/v4";
import { resolve } from "node:path";
import { scanDirectory } from "../lib/discovery/scanner.ts";
import { readInventory } from "../lib/inventory/store.ts";
import type { Project } from "../lib/types.ts";

export const args = z.tuple([
  z.string().describe("Directory to scan and compare against last inventory"),
]);

export const options = z.object({});

type Props = {
  args: z.infer<typeof args>;
  options: z.infer<typeof options>;
};

interface DiffResult {
  added: Project[];
  removed: Project[];
  updated: Array<{ project: Project; newCommits: number }>;
  unchanged: number;
}

export default function Diff({ args: [directory] }: Props) {
  const [status, setStatus] = useState<"scanning" | "comparing" | "done" | "error">("scanning");
  const [result, setResult] = useState<DiffResult | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    async function run() {
      try {
        const absDir = resolve(directory);

        // Read existing inventory
        const inventory = await readInventory();
        const existingByPath = new Map(
          inventory.projects
            .filter((p) => p.path.startsWith(absDir))
            .map((p) => [p.path, p])
        );

        // Fresh scan
        const scanResult = await scanDirectory(directory, { verbose: false, emails: [] });
        const scannedByPath = new Map(
          scanResult.projects.map((p) => [p.path, p])
        );

        setStatus("comparing");

        // Compare
        const added: Project[] = [];
        const removed: Project[] = [];
        const updated: Array<{ project: Project; newCommits: number }> = [];
        let unchanged = 0;

        // New projects
        for (const [path, project] of scannedByPath) {
          const existing = existingByPath.get(path);
          if (!existing) {
            added.push(project);
          } else {
            const commitDelta = project.commitCount - existing.commitCount;
            if (commitDelta > 0) {
              updated.push({ project, newCommits: commitDelta });
            } else {
              unchanged++;
            }
          }
        }

        // Removed projects
        for (const [path, project] of existingByPath) {
          if (!scannedByPath.has(path) && !project.tags.includes("removed")) {
            removed.push(project);
          }
        }

        setResult({ added, removed, updated, unchanged });
        setStatus("done");
      } catch (err: any) {
        setError(err.message);
        setStatus("error");
      }
    }
    run();
  }, [directory]);

  if (status === "error") return <Text color="red">Error: {error}</Text>;
  if (status === "scanning") return <Text color="yellow">Scanning {directory}...</Text>;
  if (status === "comparing") return <Text color="yellow">Comparing with inventory...</Text>;
  if (!result) return null;

  const hasChanges = result.added.length > 0 || result.removed.length > 0 || result.updated.length > 0;

  if (!hasChanges) {
    return <Text dimColor>No changes since last scan. {result.unchanged} projects unchanged.</Text>;
  }

  return (
    <Box flexDirection="column">
      {result.added.length > 0 && (
        <>
          <Text color="green" bold>
            {result.added.length} new {result.added.length === 1 ? "project" : "projects"}:
          </Text>
          {result.added.map((p) => (
            <Box key={p.id} gap={1}>
              <Text color="green">  + {p.displayName}</Text>
              <Text dimColor>
                {p.language}
                {p.dateRange.start ? `, created ${p.dateRange.start}` : ""}
              </Text>
            </Box>
          ))}
          <Text> </Text>
        </>
      )}

      {result.updated.length > 0 && (
        <>
          <Text color="yellow" bold>
            {result.updated.length} updated:
          </Text>
          {result.updated.map(({ project, newCommits }) => (
            <Box key={project.id} gap={1}>
              <Text color="yellow">  ~ {project.displayName}</Text>
              <Text dimColor>
                +{newCommits} {newCommits === 1 ? "commit" : "commits"}
                {project.lastCommit ? `, last: ${project.lastCommit}` : ""}
              </Text>
            </Box>
          ))}
          <Text> </Text>
        </>
      )}

      {result.removed.length > 0 && (
        <>
          <Text color="red" bold>
            {result.removed.length} removed:
          </Text>
          {result.removed.map((p) => (
            <Box key={p.id} gap={1}>
              <Text color="red">  - {p.displayName}</Text>
              <Text dimColor>directory deleted</Text>
            </Box>
          ))}
          <Text> </Text>
        </>
      )}

      <Text dimColor>
        {result.unchanged} unchanged
      </Text>
    </Box>
  );
}

export const description = "Show what changed since last scan";
