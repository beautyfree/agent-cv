import React, { useEffect, useState, useCallback } from "react";
import { Text, Box } from "ink";
import { z } from "zod/v4";
import { scanDirectory } from "../lib/discovery/scanner.ts";
import {
  readInventory,
  writeInventory,
  mergeInventory,
} from "../lib/inventory/store.ts";
import { buildProjectContext } from "../lib/analysis/context-builder.ts";
import { resolveAdapter } from "../lib/analysis/resolve-adapter.ts";
import { MarkdownRenderer } from "../lib/output/markdown-renderer.ts";
import { ProjectSelector } from "../components/ProjectSelector.tsx";
import { EmailPicker } from "../components/EmailPicker.tsx";
import { readConfig, writeConfig } from "../lib/config.ts";
import {
  collectUserEmails,
  collectAllRepoEmails,
  recountAuthorCommitsBatch,
} from "../lib/discovery/git-metadata.ts";
import { detectForgottenGems } from "../lib/discovery/forgotten-gems.ts";
import type { Project, Inventory } from "../lib/types.ts";

export const args = z.tuple([
  z.string().describe("Directory to scan for projects"),
]);

export const options = z.object({
  output: z.string().optional().describe("Output file path (default: stdout)"),
  agent: z.string().default("auto").describe("Agent to use: auto, claude, codex, api"),
  noCache: z.boolean().default(false).describe("Force fresh analysis, ignore cache"),
  dryRun: z.boolean().default(false).describe("Show what would be sent to the LLM without sending"),
  all: z.boolean().default(false).describe("Skip interactive selection, analyze all projects"),
  email: z.string().optional().describe("Email(s) to filter by, for generating someone else's CV (comma-separated)"),
});

type Props = {
  args: z.infer<typeof args>;
  options: z.infer<typeof options>;
};

type Phase =
  | "scanning"
  | "picking-emails"
  | "recounting"
  | "selecting"
  | "checking-agent"
  | "analyzing"
  | "rendering"
  | "done"
  | "error";

export default function Generate({
  args: [directory],
  options: { output, agent, noCache, dryRun, all: selectAll, email },
}: Props) {
  const [phase, setPhase] = useState<Phase>("scanning");
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [selectedProjects, setSelectedProjects] = useState<Project[]>([]);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [current, setCurrent] = useState("");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [markdown, setMarkdown] = useState("");
  const [error, setError] = useState("");

  // Scan progress state
  const [scanCount, setScanCount] = useState(0);
  const [scanDir, setScanDir] = useState("");
  const [lastFound, setLastFound] = useState("");

  // Email state
  const [emailCounts, setEmailCounts] = useState<Map<string, number>>(new Map());
  const [gitConfigEmails, setGitConfigEmails] = useState<Set<string>>(new Set());
  const [confirmedEmails, setConfirmedEmails] = useState<string[]>([]);

  // Phase 1: Single scan (collects everything, no email filtering yet)
  useEffect(() => {
    async function scan() {
      try {
        // Scan with empty emails first (just collect metadata)
        const scanResult = await scanDirectory(directory, {
          verbose: false,
          emails: [],
          onProjectFound: (project, total) => {
            setScanCount(total);
            setLastFound(project.displayName);
          },
          onDirectoryEnter: (dir) => {
            // Show relative path from scan root
            const rel = dir.replace(directory, "").replace(/^\//, "") || ".";
            setScanDir(rel);
          },
        });

        if (scanResult.projects.length === 0) {
          setError(`No projects found in ${directory}`);
          setPhase("error");
          return;
        }

        // Merge and save
        const existingInventory = await readInventory();
        const merged = mergeInventory(existingInventory, scanResult.projects, directory);
        await writeInventory(merged);
        setInventory(merged);
        setAllProjects(merged.projects.filter((p) => !p.tags.includes("removed")));

        // If --email provided, skip picker entirely
        if (email) {
          const emails = email.split(",").map((e) => e.trim());
          setConfirmedEmails(emails);
          setPhase("recounting");
          return;
        }

        // Collect all emails from shortlog + git config
        const gitDirs = scanResult.projects.filter((p) => p.hasGit).map((p) => p.path);
        const allEmails = await collectAllRepoEmails(gitDirs);
        const configEmails = await collectUserEmails([]);

        // Pre-select: saved config emails + git config emails
        const config = await readConfig();
        const preSelected = new Set<string>([
          ...configEmails,
          ...(config.emails || []).map((e) => e.toLowerCase()),
        ]);

        setEmailCounts(allEmails);
        setGitConfigEmails(preSelected);

        // Always show picker (user confirms every time)
        if (allEmails.size === 0) {
          // No git repos at all, skip email step
          setConfirmedEmails([]);
          setPhase("selecting");
          return;
        }

        setPhase("picking-emails");
      } catch (err: any) {
        setError(err.message);
        setPhase("error");
      }
    }
    scan();
  }, [directory, email]);

  // Handle email picker submit
  const handleEmailPick = useCallback(async (selected: string[], save: boolean) => {
    setConfirmedEmails(selected);
    if (save) {
      await writeConfig({ emails: selected, emailsConfirmed: true });
    }
    setPhase("recounting");
  }, []);

  // Phase 2: Recount author commits with confirmed emails (no rescan)
  useEffect(() => {
    if (phase !== "recounting") return;

    async function recount() {
      try {
        const projects = [...allProjects];

        // Recount authorCommitCount in parallel batches
        if (confirmedEmails.length > 0) {
          const counts = await recountAuthorCommitsBatch(projects, confirmedEmails);
          for (const project of projects) {
            const result = counts.get(project.path);
            if (result) {
              project.authorCommitCount = result.authorCommits;
              project.authorEmail = result.matchedEmail;
            }
          }
        }

        // Tag forgotten gems
        const gems = detectForgottenGems(projects);
        for (const gem of gems) {
          if (!gem.tags.includes("forgotten-gem")) {
            gem.tags.push("forgotten-gem");
          }
        }

        setAllProjects(projects);

        // Update inventory with recounted values
        if (inventory) {
          await writeInventory(inventory);
        }

        if (selectAll) {
          setSelectedProjects(projects);
          setPhase("checking-agent");
        } else {
          setPhase("selecting");
        }
      } catch (err: any) {
        setError(err.message);
        setPhase("error");
      }
    }
    recount();
  }, [phase, confirmedEmails, allProjects, inventory, selectAll]);

  // Handle project selection submit
  const handleSelection = useCallback((selected: Project[]) => {
    if (selected.length === 0) {
      setError("No projects selected.");
      setPhase("error");
      return;
    }
    setSelectedProjects(selected);
    setPhase("checking-agent");
  }, []);

  // Phase 3+4: Agent check, analyze, render
  useEffect(() => {
    if (phase !== "checking-agent") return;

    async function analyzeAndRender() {
      try {
        let resolved;
        try {
          resolved = await resolveAdapter(agent);
        } catch (err: any) {
          setError(err.message);
          setPhase("error");
          return;
        }
        const adapter = resolved.adapter;

        setPhase("analyzing");
        const toAnalyze = noCache
          ? selectedProjects
          : selectedProjects.filter((p) => !p.analysis);

        setProgress({ done: 0, total: toAnalyze.length });

        for (let i = 0; i < toAnalyze.length; i++) {
          const project = toAnalyze[i]!;
          setCurrent(project.displayName);

          if (dryRun) {
            const context = await buildProjectContext(project);
            const totalChars =
              context.readme.length + context.dependencies.length +
              context.directoryTree.length + context.gitShortlog.length +
              context.recentCommits.length;
            console.error(
              `\n--- DRY RUN: ${project.displayName} ---\n` +
                `Context size: ~${Math.round(totalChars / 4)} tokens\n`
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
          }

          setProgress({ done: i + 1, total: toAnalyze.length });
        }

        if (!dryRun && inventory) {
          await writeInventory(inventory);
        }

        setPhase("rendering");
        const renderer = new MarkdownRenderer();
        const md = renderer.render(
          inventory!,
          selectedProjects.map((p) => p.id)
        );
        setMarkdown(md);

        if (output && !dryRun) {
          await Bun.write(output, md);
        }

        setPhase("done");
      } catch (err: any) {
        setError(err.message);
        setPhase("error");
      }
    }
    analyzeAndRender();
  }, [phase, selectedProjects, agent, noCache, dryRun, output, inventory]);

  // Render
  if (phase === "error") {
    return <Text color="red">Error: {error}</Text>;
  }

  if (phase === "scanning") {
    return (
      <Box flexDirection="column">
        <Text color="yellow">
          Scanning {directory}...
        </Text>
        {scanCount > 0 && (
          <Text color="green">
            Found {scanCount} project{scanCount !== 1 ? "s" : ""}
            {lastFound ? ` — ${lastFound}` : ""}
          </Text>
        )}
        {scanDir && (
          <Text dimColor>
            {scanDir}
          </Text>
        )}
      </Box>
    );
  }

  if (phase === "picking-emails") {
    return (
      <EmailPicker
        emailCounts={emailCounts}
        preSelected={gitConfigEmails}
        onSubmit={handleEmailPick}
      />
    );
  }

  if (phase === "recounting") {
    return <Text color="yellow">Identifying your projects...</Text>;
  }

  if (phase === "selecting") {
    return (
      <ProjectSelector
        projects={allProjects}
        scanRoot={directory}
        onSubmit={handleSelection}
      />
    );
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
        {dryRun && <Text dimColor>(dry-run mode, no LLM calls)</Text>}
      </Box>
    );
  }

  if (phase === "rendering") {
    return <Text color="yellow">Generating CV...</Text>;
  }

  const analyzed = selectedProjects.filter((p) => p.analysis).length;
  const secrets = selectedProjects.reduce(
    (n, p) => n + (p.privacyAudit?.secretsFound ?? 0),
    0
  );

  return (
    <Box flexDirection="column">
      <Text color="green" bold>
        CV generated! {selectedProjects.length} projects, {analyzed} analyzed.
      </Text>
      {secrets > 0 && (
        <Text color="yellow">
          Privacy: {secrets} file{secrets !== 1 ? "s" : ""} with secrets
          excluded from analysis.
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
