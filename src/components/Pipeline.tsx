import React, { useEffect, useState, useCallback } from "react";
import { Text, Box, useInput } from "ink";
import { readInventory, writeInventory } from "../lib/inventory/store.ts";
import { resolveAdapter } from "../lib/analysis/resolve-adapter.ts";
import { ProjectSelector } from "./ProjectSelector.tsx";
import { EmailPicker } from "./EmailPicker.tsx";
import { AgentPicker } from "./AgentPicker.tsx";
import {
  scanAndMerge,
  collectEmails,
  recountAndTag,
  analyzeProjects,
  type ProjectStatus,
} from "../lib/pipeline.ts";
import type { Project, Inventory, AgentAdapter } from "../lib/types.ts";
import { markNoticeSeen, track } from "../lib/telemetry.ts";

export interface PipelineOptions {
  directory: string;
  all?: boolean;
  email?: string;
  agent?: string;
  noCache?: boolean;
  dryRun?: boolean;
}

export interface PipelineResult {
  projects: Project[];
  inventory: Inventory;
  adapter: AgentAdapter;
}

interface Props {
  options: PipelineOptions;
  onComplete: (result: PipelineResult) => void;
  onError: (error: string) => void;
}

type Phase =
  | "init" | "scanning" | "picking-emails" | "recounting" | "selecting"
  | "picking-agent" | "analyzing" | "analysis-failed" | "done";

/**
 * Reusable pipeline component: scan → emails → recount → select → agent → analyze.
 * Commands provide onComplete to do their specific thing with the results.
 */
export function Pipeline({ options, onComplete, onError }: Props) {
  const { directory, all: selectAll, email, agent = "auto", noCache, dryRun } = options;

  const [phase, setPhase] = useState<Phase>("init");
  const [showTelemetryNotice, setShowTelemetryNotice] = useState(false);
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [selectedProjects, setSelectedProjects] = useState<Project[]>([]);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [resolvedAdapter, setResolvedAdapter] = useState<AgentAdapter | null>(null);

  // Scan progress (throttled to avoid excessive re-renders)
  const [scanCount, setScanCount] = useState(0);
  const [scanDir, setScanDir] = useState("");
  const [lastFound, setLastFound] = useState("");
  const scanThrottle = React.useRef(0);

  // Email picker state
  const [emailCounts, setEmailCounts] = useState<Map<string, number>>(new Map());
  const [gitConfigEmails, setGitConfigEmails] = useState<Set<string>>(new Set());
  const [confirmedEmails, setConfirmedEmails] = useState<string[]>([]);

  // Analysis progress
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [current, setCurrent] = useState("");
  const [projectStatuses, setProjectStatuses] = useState<Map<string, { status: ProjectStatus; detail?: string }>>(new Map());

  // Phase 0: Show telemetry notice (first run only), then start scanning
  useEffect(() => {
    if (phase !== "init") return;
    markNoticeSeen().then((alreadySeen) => {
      if (!alreadySeen) setShowTelemetryNotice(true);
      setPhase("scanning");
    });
  }, [phase]);

  // Phase 1: Scan
  useEffect(() => {
    if (phase !== "scanning") return;
    async function scan() {
      try {
        await track("command_start", { command: "pipeline" });
        const scanState = { count: 0, last: "", dir: "" };
        const result = await scanAndMerge(directory, {
          onProjectFound: (p, total) => {
            scanState.count = total;
            scanState.last = p.path.replace(directory, "").replace(/^\//, "") || p.displayName;
            const now = Date.now();
            if (now - scanThrottle.current > 150) {
              scanThrottle.current = now;
              setScanCount(scanState.count);
              setLastFound(scanState.last);
              if (scanState.dir) setScanDir(scanState.dir);
            }
          },
          onDirectoryEnter: (dir) => {
            scanState.dir = dir.replace(directory, "").replace(/^\//, "") || ".";
          },
        });
        // Final update with latest values
        setScanCount(scanState.count);
        setLastFound(scanState.last);

        if (result.projects.length === 0) {
          onError(`No projects found in ${directory}`);
          return;
        }

        setInventory(result.inventory);
        setAllProjects(result.projects);

        if (email) {
          setConfirmedEmails(email.split(",").map((e) => e.trim()));
          setPhase("recounting");
          return;
        }

        const emails = await collectEmails(result.projects, result.inventory.profile.emails);
        setEmailCounts(emails.emailCounts);
        setGitConfigEmails(emails.preSelected);

        if (emails.emailCounts.size === 0) {
          setConfirmedEmails([]);
          setPhase("selecting");
          return;
        }
        setPhase("picking-emails");
      } catch (err: any) { onError(err.message); }
    }
    scan();
  }, [phase, directory, email]);

  // Email picker
  const handleEmailPick = useCallback(async (selected: string[], save: boolean) => {
    setConfirmedEmails(selected);
    if (save && inventory) {
      inventory.profile.emails = selected;
      inventory.profile.emailsConfirmed = true;
      await writeInventory(inventory);
    }
    setPhase("recounting");
  }, [inventory]);

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
      } catch (err: any) { onError(err.message); }
    }
    recount();
  }, [phase, confirmedEmails, allProjects, inventory, selectAll]);

  // Project selection — save included/excluded to inventory
  const handleSelection = useCallback(async (selected: Project[]) => {
    if (selected.length === 0) { onError("No projects selected."); return; }
    const selectedIds = new Set(selected.map((p) => p.id));
    for (const p of allProjects) {
      p.included = selectedIds.has(p.id);
      p.tags = p.tags.filter((t) => t !== "new");
    }
    if (inventory) await writeInventory(inventory);
    setSelectedProjects(selected);
    if (agent !== "auto") {
      try {
        const { adapter } = await resolveAdapter(agent);
        setResolvedAdapter(adapter);
        setPhase("analyzing");
      } catch (err: any) { onError(err.message); }
      return;
    }
    setPhase("picking-agent");
  }, [agent]);

  // Agent picker — save choice to inventory
  const handleAgentPick = useCallback(async (adapter: AgentAdapter, name: string) => {
    if (inventory) {
      inventory.lastAgent = name;
      await writeInventory(inventory);
    }
    setResolvedAdapter(adapter);
    setPhase("analyzing");
  }, [inventory]);

  const handleAgentBack = useCallback(() => {
    setPhase("selecting");
  }, []);

  // Analysis failure state
  const [failedProjects, setFailedProjects] = useState<Array<{ project: Project; error: string }>>([]);

  function finishAnalysis() {
    // Generate profile insights (bio, highlights, narrative, skills)
    async function finish() {
      try {
        if (!dryRun && inventory && !inventory.insights.bio) {
          setCurrent("generating profile insights...");
          try {
            const { generateProfileInsights } = await import("../lib/analysis/bio-generator.ts");
            const insights = await generateProfileInsights(selectedProjects, resolvedAdapter!);
            if (insights) {
              inventory.insights = insights;
            }
          } catch { /* optional */ }
        }
        if (inventory) await writeInventory(inventory);
        setPhase("done");
        onComplete({ projects: selectedProjects, inventory: inventory!, adapter: resolvedAdapter! });
      } catch (err: any) { onError(err.message); }
    }
    finish();
  }

  // Phase 3: Analyze
  useEffect(() => {
    if (phase !== "analyzing" || !resolvedAdapter) return;
    async function run() {
      try {
        const result = await analyzeProjects(selectedProjects, resolvedAdapter!, inventory!, {
          noCache, dryRun,
          onProgress: (done, total, cur) => { setProgress({ done, total }); setCurrent(cur); },
          onProjectStatus: (id, status, detail) => {
            setProjectStatuses((prev) => {
              const next = new Map(prev);
              next.set(id, { status, detail });
              return next;
            });
          },
        });

        await track("analysis_complete", {
          analyzed: result.analyzed,
          failed: result.failed.length,
          cached: result.skipped,
          agent: resolvedAdapter!.name,
        });

        if (result.failed.length > 0) {
          setFailedProjects(result.failed);
          setPhase("analysis-failed");
          return;
        }

        finishAnalysis();
      } catch (err: any) { onError(err.message); }
    }
    run();
  }, [phase, selectedProjects, resolvedAdapter, noCache, dryRun, inventory]);

  // Handle failure screen input
  useInput((input, key) => {
    if (phase !== "analysis-failed") return;
    if (input === "r") {
      // Retry failed projects with same adapter
      setSelectedProjects(failedProjects.map((f) => f.project));
      setFailedProjects([]);
      setPhase("analyzing");
    } else if (input === "s") {
      // Skip failures, continue
      finishAnalysis();
    } else if (input === "a") {
      // Switch agent and retry
      setSelectedProjects(failedProjects.map((f) => f.project));
      setFailedProjects([]);
      setResolvedAdapter(null);
      setPhase("picking-agent");
    }
  });

  // Render based on phase
  if (phase === "init") return null;
  if (phase === "scanning") return (
    <Box flexDirection="column">
      {showTelemetryNotice && (
        <Box marginBottom={1} flexDirection="column">
          <Text dimColor>Anonymous telemetry enabled. Disable: agent-cv config or AGENT_CV_TELEMETRY=off</Text>
        </Box>
      )}
      <Text color="yellow">Scanning {directory}...</Text>
      {scanCount > 0 && (
        <Text>
          <Text color="green">Found {scanCount} project{scanCount !== 1 ? "s" : ""}</Text>
          {lastFound ? <Text dimColor> — {lastFound}</Text> : null}
        </Text>
      )}
    </Box>
  );
  if (phase === "picking-emails") return <EmailPicker emailCounts={emailCounts} preSelected={gitConfigEmails} onSubmit={handleEmailPick} />;
  if (phase === "recounting") return <Text color="yellow">Identifying your projects...</Text>;
  if (phase === "selecting") return <ProjectSelector projects={allProjects} scanRoot={directory} onSubmit={handleSelection} />;
  if (phase === "picking-agent") return <AgentPicker onSubmit={handleAgentPick} onBack={handleAgentBack} defaultAgent={inventory?.lastAgent} />;
  if (phase === "analyzing") {
    const statusIcon = (s: ProjectStatus) => {
      switch (s) {
        case "cached": return "✓";
        case "done": return "✓";
        case "analyzing": return "◌";
        case "failed": return "✗";
        case "queued": return "·";
      }
    };
    const statusColor = (s: ProjectStatus) => {
      switch (s) {
        case "cached": return "gray";
        case "done": return "green";
        case "analyzing": return "yellow";
        case "failed": return "red";
        case "queued": return "gray";
      }
    };

    // Show last ~15 projects (most recent activity visible)
    const allEntries = [...projectStatuses.entries()]
      .map(([id, { status, detail }]) => {
        const p = selectedProjects.find((p) => p.id === id);
        return { name: p?.displayName || id, status, detail };
      });
    const analyzing = allEntries.filter((e) => e.status === "analyzing");
    const done = allEntries.filter((e) => e.status === "done" || e.status === "cached");
    const failed = allEntries.filter((e) => e.status === "failed");
    const queued = allEntries.filter((e) => e.status === "queued");

    // Show: analyzing first, then last few done, then queued count
    const visible = [
      ...analyzing,
      ...failed,
      ...done.slice(-5),
    ];

    return (
      <Box flexDirection="column">
        <Text bold>Analyzing projects [{done.length}/{allEntries.length}]</Text>
        {dryRun && <Text dimColor>(dry-run mode, no LLM calls)</Text>}
        <Text> </Text>
        {visible.map((entry) => (
          <Box key={entry.name} gap={1}>
            <Text color={statusColor(entry.status)}>{statusIcon(entry.status)}</Text>
            <Text color={entry.status === "analyzing" ? "yellow" : entry.status === "failed" ? "red" : undefined}>
              {entry.name}
            </Text>
            {entry.detail && entry.status === "done" && <Text dimColor>{entry.detail}</Text>}
            {entry.detail && entry.status === "failed" && <Text color="red" dimColor>{entry.detail}</Text>}
            {entry.status === "analyzing" && <Text color="yellow">analyzing...</Text>}
          </Box>
        ))}
        {queued.length > 0 && <Text dimColor>{"\n"}  {queued.length} more in queue</Text>}
      </Box>
    );
  }
  if (phase === "analysis-failed") {
    const analyzed = selectedProjects.length - failedProjects.length;
    return (
      <Box flexDirection="column">
        <Text color="yellow" bold>Analysis complete with errors</Text>
        <Text color="green">  {analyzed} analyzed successfully</Text>
        <Text color="red">  {failedProjects.length} failed:</Text>
        {failedProjects.slice(0, 10).map((f) => (
          <Text key={f.project.id} dimColor>    {f.project.displayName}: {f.error.slice(0, 80)}</Text>
        ))}
        {failedProjects.length > 10 && <Text dimColor>    ...and {failedProjects.length - 10} more</Text>}
        <Text> </Text>
        <Text>[r] retry failed  [a] switch agent and retry  [s] skip and continue</Text>
      </Box>
    );
  }

  return null; // done phase handled by parent via onComplete
}
