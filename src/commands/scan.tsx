import React, { useEffect, useState } from "react";
import { Text, Box } from "ink";
import { z } from "zod/v4";
import { scanDirectory, type ScanResult } from "../lib/discovery/scanner.ts";
import {
  readInventory,
  writeInventory,
  mergeInventory,
} from "../lib/inventory/store.ts";

export const args = z.tuple([
  z.string().describe("Directory to scan for projects"),
]);

export const options = z.object({
  verbose: z.boolean().default(false).describe("Show detailed scan progress"),
  json: z.boolean().default(false).describe("Output raw JSON instead of formatted text"),
});

type Props = {
  args: z.infer<typeof args>;
  options: z.infer<typeof options>;
};

export default function Scan({ args: [directory], options: { verbose, json } }: Props) {
  const [status, setStatus] = useState<"scanning" | "saving" | "done" | "error">("scanning");
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    async function run() {
      try {
        const scanResult = await scanDirectory(directory, { verbose });
        setResult(scanResult);

        setStatus("saving");
        const inventory = await readInventory();
        const merged = mergeInventory(inventory, scanResult.projects, directory);
        await writeInventory(merged);

        setStatus("done");
      } catch (err: any) {
        setError(err.message);
        setStatus("error");
      }
    }
    run();
  }, [directory, verbose]);

  if (status === "error") {
    return <Text color="red">Error: {error}</Text>;
  }

  if (status === "scanning") {
    return <Text color="yellow">Scanning {directory}...</Text>;
  }

  if (!result) {
    return <Text color="yellow">Processing...</Text>;
  }

  if (json) {
    return <Text>{JSON.stringify(result.projects, null, 2)}</Text>;
  }

  const secrets = result.projects.reduce(
    (n, p) => n + (p.privacyAudit?.secretsFound ?? 0),
    0
  );

  return (
    <Box flexDirection="column">
      <Text color="green" bold>
        Found {result.projects.length} project{result.projects.length !== 1 ? "s" : ""} in {directory}
      </Text>
      <Text> </Text>
      {result.projects.map((p) => (
        <Box key={p.id} gap={1}>
          <Text color="cyan">{p.displayName}</Text>
          <Text dimColor>
            {p.language} | {p.dateRange.approximate ? "~" : ""}
            {p.dateRange.start || "?"} — {p.dateRange.end || "?"}
            {p.commitCount > 0 ? ` | ${p.commitCount} commits` : ""}
          </Text>
        </Box>
      ))}
      {result.errors.length > 0 && (
        <>
          <Text> </Text>
          <Text color="yellow">
            {result.errors.length} warning{result.errors.length !== 1 ? "s" : ""}:
          </Text>
          {result.errors.map((e, i) => (
            <Text key={i} dimColor>
              {e.path}: {e.error}
            </Text>
          ))}
        </>
      )}
      {secrets > 0 && (
        <Text color="yellow">
          {"\n"}Privacy: {secrets} file{secrets !== 1 ? "s" : ""} with potential secrets detected and excluded.
        </Text>
      )}
      <Text dimColor>{"\n"}Saved to ~/.llm-cv/inventory.json</Text>
    </Box>
  );
}

export const description = "Scan a directory tree for software projects";
