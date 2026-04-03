import React, { useEffect, useState } from "react";
import { Text, Box } from "ink";
import { z } from "zod/v4";
import { scanDirectory } from "../lib/discovery/scanner.ts";
import {
  readInventory,
  writeInventory,
  mergeInventory,
} from "../lib/inventory/store.ts";
import { buildProjectContext } from "../lib/analysis/context-builder.ts";
import { ClaudeAdapter } from "../lib/analysis/claude-adapter.ts";
import { MarkdownRenderer } from "../lib/output/markdown-renderer.ts";
import type { Project, ProjectAnalysis } from "../lib/types.ts";

export const args = z.tuple([
  z.string().describe("Directory to scan for projects"),
]);

export const options = z.object({
  output: z.string().optional().describe("Output file path (default: stdout)"),
  agent: z.string().default("claude").describe("Agent to use for analysis"),
  "no-cache": z.boolean().default(false).describe("Force fresh analysis, ignore cache"),
  "dry-run": z.boolean().default(false).describe("Show what would be sent to the LLM without sending"),
});

type Props = {
  args: z.infer<typeof args>;
  options: z.infer<typeof options>;
};

type Phase =
  | "scanning"
  | "selecting"
  | "checking-agent"
  | "analyzing"
  | "rendering"
  | "done"
  | "error";

export default function Generate({
  args: [directory],
  options: { output, agent, "no-cache": noCache, "dry-run": dryRun },
}: Props) {
  const [phase, setPhase] = useState<Phase>("scanning");
  const [projects, setProjects] = useState<Project[]>([]);
  const [current, setCurrent] = useState("");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [markdown, setMarkdown] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    async function run() {
      try {
        // Phase 1: Scan
        setPhase("scanning");
        const scanResult = await scanDirectory(directory, { verbose: false });

        if (scanResult.projects.length === 0) {
          setError(`No projects found in ${directory}`);
          setPhase("error");
          return;
        }

        // Merge with existing inventory
        const inventory = await readInventory();
        const merged = mergeInventory(
          inventory,
          scanResult.projects,
          directory
        );
        await writeInventory(merged);

        // For v0a, auto-select all projects (interactive selection in v0b)
        const selected = merged.projects.filter(
          (p) => !p.tags.includes("removed")
        );
        setProjects(selected);

        // Phase 2: Check agent
        setPhase("checking-agent");
        const adapter = new ClaudeAdapter();
        const available = await adapter.isAvailable();

        if (!available) {
          setError(
            `Agent "${agent}" not found in PATH.\n\n` +
              "Install Claude Code: https://claude.ai/claude-code\n" +
              "Or set an API key: export OPENROUTER_API_KEY=..."
          );
          setPhase("error");
          return;
        }

        // Phase 3: Analyze each project
        setPhase("analyzing");
        const toAnalyze = noCache
          ? selected
          : selected.filter((p) => !p.analysis);

        setProgress({ done: 0, total: toAnalyze.length });

        for (let i = 0; i < toAnalyze.length; i++) {
          const project = toAnalyze[i]!;
          setCurrent(project.displayName);

          if (dryRun) {
            const context = await buildProjectContext(project);
            console.error(
              `\n--- DRY RUN: ${project.displayName} ---\n` +
                `Context size: ~${Math.round((context.readme.length + context.dependencies.length + context.directoryTree.length + context.gitShortlog.length + context.recentCommits.length) / 4)} tokens\n` +
                `README: ${context.readme.length} chars\n` +
                `Dependencies: ${context.dependencies.length} chars\n` +
                `Tree: ${context.directoryTree.length} chars\n` +
                `Git: ${context.gitShortlog.length + context.recentCommits.length} chars\n`
            );
            setProgress({ done: i + 1, total: toAnalyze.length });
            continue;
          }

          try {
            const context = await buildProjectContext(project);
            const analysis = await adapter.analyze(context);
            project.analysis = analysis;
          } catch (err: any) {
            console.error(
              `Warning: Failed to analyze ${project.displayName}: ${err.message}`
            );
            // Continue with other projects
          }

          setProgress({ done: i + 1, total: toAnalyze.length });
        }

        // Save updated inventory with analyses
        if (!dryRun) {
          await writeInventory(merged);
        }

        // Phase 4: Render
        setPhase("rendering");
        const renderer = new MarkdownRenderer();
        const md = renderer.render(merged, selected.map((p) => p.id));
        setMarkdown(md);

        // Write to file or stdout
        if (output && !dryRun) {
          await Bun.write(output, md);
        }

        setPhase("done");
      } catch (err: any) {
        setError(err.message);
        setPhase("error");
      }
    }
    run();
  }, [directory, agent, noCache, dryRun, output]);

  if (phase === "error") {
    return <Text color="red">Error: {error}</Text>;
  }

  if (phase === "scanning") {
    return <Text color="yellow">Scanning {directory} for projects...</Text>;
  }

  if (phase === "checking-agent") {
    return <Text color="yellow">Checking agent availability...</Text>;
  }

  if (phase === "analyzing") {
    return (
      <Box flexDirection="column">
        <Text color="yellow">
          Analyzing [{progress.done}/{progress.total}]: {current}
        </Text>
        {dryRun && (
          <Text dimColor>(dry-run mode, no LLM calls)</Text>
        )}
      </Box>
    );
  }

  if (phase === "rendering") {
    return <Text color="yellow">Generating CV...</Text>;
  }

  // Done
  const analyzed = projects.filter((p) => p.analysis).length;
  const secrets = projects.reduce(
    (n, p) => n + (p.privacyAudit?.secretsFound ?? 0),
    0
  );

  return (
    <Box flexDirection="column">
      <Text color="green" bold>
        CV generated! {projects.length} projects, {analyzed} analyzed.
      </Text>
      {secrets > 0 && (
        <Text color="yellow">
          Privacy: {secrets} file{secrets !== 1 ? "s" : ""} with secrets excluded from analysis.
        </Text>
      )}
      {output ? (
        <Text dimColor>Written to: {output}</Text>
      ) : (
        <>
          <Text> </Text>
          <Text>{markdown}</Text>
        </>
      )}
    </Box>
  );
}

export const description =
  "Full flow: scan directory, analyze projects with AI, generate markdown CV";
