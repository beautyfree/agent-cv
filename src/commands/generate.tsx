import React, { useEffect, useState, useCallback } from "react";
import { Text, Box } from "ink";
import { z } from "zod/v4";
import { writeInventory } from "../lib/inventory/store.ts";
import { MarkdownRenderer } from "../lib/output/markdown-renderer.ts";
import { resolveAdapter } from "../lib/analysis/resolve-adapter.ts";
import { writeConfig } from "../lib/config.ts";
import { ProjectSelector } from "../components/ProjectSelector.tsx";
import { EmailPicker } from "../components/EmailPicker.tsx";
import { AgentPicker } from "../components/AgentPicker.tsx";
import {
  scanAndMerge,
  collectEmails,
  recountAndTag,
  analyzeProjects,
} from "../lib/pipeline.ts";
import type { Project, Inventory, AgentAdapter } from "../lib/types.ts";

export const args = z.tuple([
  z.string().describe("Directory to scan for projects"),
]);

export const options = z.object({
  output: z.string().optional().describe("Output file path (default: stdout)"),
  agent: z.string().default("auto").describe("Agent to use: auto, claude, codex, cursor, api (auto = show picker)"),
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
  | "scanning" | "picking-emails" | "recounting" | "selecting"
  | "picking-agent" | "analyzing" | "rendering" | "done" | "error";

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
  const [scanCount, setScanCount] = useState(0);
  const [scanDir, setScanDir] = useState("");
  const [lastFound, setLastFound] = useState("");
  const [resolvedAdapter, setResolvedAdapter] = useState<AgentAdapter | null>(null);
  const [emailCounts, setEmailCounts] = useState<Map<string, number>>(new Map());
  const [gitConfigEmails, setGitConfigEmails] = useState<Set<string>>(new Set());
  const [confirmedEmails, setConfirmedEmails] = useState<string[]>([]);

  // Phase 1: Scan
  useEffect(() => {
    async function scan() {
      try {
        const result = await scanAndMerge(directory, {
          onProjectFound: (project, total) => { setScanCount(total); setLastFound(project.displayName); },
          onDirectoryEnter: (dir) => { setScanDir(dir.replace(directory, "").replace(/^\//, "") || "."); },
        });

        if (result.projects.length === 0) {
          setError(`No projects found in ${directory}`);
          setPhase("error");
          return;
        }

        setInventory(result.inventory);
        setAllProjects(result.projects);

        if (email) {
          setConfirmedEmails(email.split(",").map((e) => e.trim()));
          setPhase("recounting");
          return;
        }

        const emails = await collectEmails(result.projects);
        setEmailCounts(emails.emailCounts);
        setGitConfigEmails(emails.preSelected);

        if (emails.emailCounts.size === 0) {
          setConfirmedEmails([]);
          setPhase("selecting");
          return;
        }
        setPhase("picking-emails");
      } catch (err: any) { setError(err.message); setPhase("error"); }
    }
    scan();
  }, [directory, email]);

  const handleEmailPick = useCallback(async (selected: string[], save: boolean) => {
    setConfirmedEmails(selected);
    if (save) await writeConfig({ emails: selected, emailsConfirmed: true });
    setPhase("recounting");
  }, []);

  // Phase 2: Recount
  useEffect(() => {
    if (phase !== "recounting") return;
    async function recount() {
      try {
        const updated = await recountAndTag(allProjects, confirmedEmails);
        setAllProjects(updated);
        if (inventory) await writeInventory(inventory);
        if (selectAll) { setSelectedProjects(updated); setPhase("picking-agent"); }
        else setPhase("selecting");
      } catch (err: any) { setError(err.message); setPhase("error"); }
    }
    recount();
  }, [phase, confirmedEmails, allProjects, inventory, selectAll]);

  const handleSelection = useCallback(async (selected: Project[]) => {
    if (selected.length === 0) { setError("No projects selected."); setPhase("error"); return; }
    setSelectedProjects(selected);
    if (agent !== "auto") {
      try {
        const { adapter, name } = await resolveAdapter(agent);
        setResolvedAdapter(adapter);
        setPhase("analyzing");
      } catch (err: any) { setError(err.message); setPhase("error"); }
      return;
    }
    setPhase("picking-agent");
  }, [agent]);

  const handleAgentPick = useCallback((adapter: AgentAdapter) => {
    setResolvedAdapter(adapter);
    setPhase("analyzing");
  }, []);

  // Phase 3+4: Analyze + render
  useEffect(() => {
    if (phase !== "analyzing" || !resolvedAdapter) return;
    async function run() {
      try {
        await analyzeProjects(selectedProjects, resolvedAdapter!, inventory!, {
          noCache, dryRun,
          onProgress: (done, total, cur) => { setProgress({ done, total }); setCurrent(cur); },
        });

        setPhase("rendering");
        const renderer = new MarkdownRenderer();
        const md = renderer.render(inventory!, selectedProjects.map((p) => p.id));
        setMarkdown(md);
        if (output && !dryRun) await Bun.write(output, md);
        setPhase("done");
      } catch (err: any) { setError(err.message); setPhase("error"); }
    }
    run();
  }, [phase, selectedProjects, resolvedAdapter, noCache, dryRun, output, inventory]);

  if (phase === "error") return <Text color="red">Error: {error}</Text>;
  if (phase === "scanning") return (
    <Box flexDirection="column">
      <Text color="yellow">Scanning {directory}...</Text>
      {scanCount > 0 && <Text color="green">Found {scanCount} project{scanCount !== 1 ? "s" : ""}{lastFound ? ` — ${lastFound}` : ""}</Text>}
      {scanDir && <Text dimColor>{scanDir}</Text>}
    </Box>
  );
  if (phase === "picking-emails") return <EmailPicker emailCounts={emailCounts} preSelected={gitConfigEmails} onSubmit={handleEmailPick} />;
  if (phase === "recounting") return <Text color="yellow">Identifying your projects...</Text>;
  if (phase === "selecting") return <ProjectSelector projects={allProjects} scanRoot={directory} onSubmit={handleSelection} />;
  if (phase === "picking-agent") return <AgentPicker onSubmit={handleAgentPick} />;
  if (phase === "analyzing") return (
    <Box flexDirection="column">
      <Text color="yellow">Analyzing [{progress.done}/{progress.total}]: {current}</Text>
      {dryRun && <Text dimColor>(dry-run mode, no LLM calls)</Text>}
    </Box>
  );
  if (phase === "rendering") return <Text color="yellow">Generating CV...</Text>;

  const analyzed = selectedProjects.filter((p) => p.analysis).length;
  const secrets = selectedProjects.reduce((n, p) => n + (p.privacyAudit?.secretsFound ?? 0), 0);

  return (
    <Box flexDirection="column">
      <Text color="green" bold>CV generated! {selectedProjects.length} projects, {analyzed} analyzed.</Text>
      {secrets > 0 && <Text color="yellow">Privacy: {secrets} file{secrets !== 1 ? "s" : ""} with secrets excluded from analysis.</Text>}
      {output ? <Text dimColor>Written to: {output}</Text> : <><Text> </Text><Text>{markdown}</Text></>}
    </Box>
  );
}

export const description = "Full flow: scan directory, analyze projects with AI, generate markdown CV";
