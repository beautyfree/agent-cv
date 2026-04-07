import React, { useEffect, useState, useCallback, useRef } from "react";
import { Text, Box, useInput, useStdout } from "ink";
import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { readInventory, writeInventory } from "../lib/inventory/store.ts";
import { resolveAdapter } from "../lib/analysis/resolve-adapter.ts";
import { generateProfileInsights } from "../lib/analysis/bio-generator.ts";
import { ProjectSelector } from "./ProjectSelector.tsx";
import { EmailPicker } from "./EmailPicker.tsx";
import { AgentPicker } from "./AgentPicker.tsx";
import {
  scanAndMerge,
  collectEmails,
  recountAndTag,
  analyzeProjects,
  enrichGitHubData,
  shouldSkipPhases,
  detectProjectGroups,
  type ProjectStatus,
} from "../lib/pipeline.ts";
import type { Project, Inventory, AgentAdapter } from "../lib/types.ts";
import { markNoticeSeen, track } from "../lib/telemetry.ts";
import { GitHubClient, GitHubAuthError } from "../lib/discovery/github-client.ts";
import { detectGitHubUsername, scanGitHub } from "../lib/discovery/github-scanner.ts";
import { mergeCloudProjects } from "../lib/inventory/store.ts";
import { searchPackageRegistries } from "../lib/discovery/package-registries.ts";

export interface PipelineOptions {
  directory: string;
  all?: boolean;
  email?: string;
  agent?: string;
  noCache?: boolean;
  dryRun?: boolean;
  github?: string;
  includeForks?: boolean;
  interactive?: boolean;
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
  const { directory, all: selectAll, email, agent = "auto", noCache, dryRun, github: githubUsername, includeForks, interactive } = options;

  const { write } = useStdout();
  const prevPhase = useRef<Phase>("init");
  const [phase, _setPhase] = useState<Phase>("init");
  const setPhase = useCallback((next: Phase) => {
    // Only clear screen for interactive picker phases (not silent skips)
    const interactivePhases = new Set<Phase>(["picking-emails", "selecting", "picking-agent"]);
    if (prevPhase.current !== next && interactivePhases.has(next)) {
      write("\x1b[2J\x1b[H");
    }
    prevPhase.current = next;
    _setPhase(next);
  }, [write]);
  const [showTelemetryNotice, setShowTelemetryNotice] = useState(false);
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [selectedProjects, setSelectedProjects] = useState<Project[]>([]);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [resolvedAdapter, setResolvedAdapter] = useState<AgentAdapter | null>(null);

  // Scan progress (throttled to avoid excessive re-renders)
  const [scanCount, setScanCount] = useState(0);
  const [lastFound, setLastFound] = useState("");
  const [prevProjectCount, setPrevProjectCount] = useState(0);
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
        const existingInv = await readInventory();
        const absDir = resolvePath(directory);
        const prevCount = existingInv.projects.filter((p) => !p.tags.includes("removed") && p.path.startsWith(absDir)).length;
        setPrevProjectCount(prevCount);
        const scanState = { count: 0, last: "" };
        const result = await scanAndMerge(directory, {
          onProjectFound: (p, total) => {
            scanState.count = total;
            scanState.last = p.path.replace(directory, "").replace(/^\//, "") || p.displayName;
            const now = Date.now();
            if (now - scanThrottle.current > 150) {
              scanThrottle.current = now;
              setScanCount(scanState.count);
              setLastFound(scanState.last);
            }
          },
        });
        // Final update with latest values
        setScanCount(scanState.count);
        setLastFound(scanState.last);

        if (result.projects.length === 0) {
          onError(`No projects found in ${directory}`);
          return;
        }

        // Detect project groups (frontend+backend in same org → one group)
        detectProjectGroups(result.projects, directory);

        // GitHub cloud scanning
        const ghUser = githubUsername || detectGitHubUsername(result.inventory);
        if (ghUser) {
          const ghClient = await GitHubClient.create();
          if (!ghClient.isAuthenticated) {
            setCurrent("Skipping GitHub scan — set GITHUB_TOKEN for cloud scanning");
          } else {
            try {
              setCurrent(`Scanning GitHub repos for ${ghUser}...`);
              const ghResult = await scanGitHub(ghUser, ghClient, {
                includeForks,
                onProgress: (done, total, name) => {
                  setCurrent(`GitHub: ${done}/${total} — ${name}`);
                },
              });

              // Merge cloud projects into inventory (dedup via remoteUrl)
              result.inventory = mergeCloudProjects(result.inventory, ghResult.projects);
              result.projects = result.inventory.projects.filter((p) => !p.tags.includes("removed"));

              // Save GitHub profile data
              if (ghResult.profile) {
                result.inventory.profile.name = result.inventory.profile.name || ghResult.profile.name || undefined;
                if (ghResult.profile.bio) {
                  result.inventory.profile.socials = {
                    ...result.inventory.profile.socials,
                    github: ghUser,
                    website: result.inventory.profile.socials?.website || ghResult.profile.blog || undefined,
                  };
                }
              }

              // Save starred repos and contributions to inventory for rendering
              if (ghResult.starredRepos.length > 0 || ghResult.contributions.length > 0) {
                (result.inventory as any).githubExtras = {
                  starredRepos: ghResult.starredRepos.slice(0, 200),
                  contributions: ghResult.contributions,
                  avatarUrl: ghResult.profile?.avatar_url,
                };
              }

              // Search package registries
              try {
                setCurrent("Searching package registries...");
                const packages = await searchPackageRegistries(ghUser, (registry, error) => {
                  setCurrent(`Warning: ${error}`);
                });
                if (packages.length > 0) {
                  (result.inventory as any).publishedPackages = packages;
                }
              } catch {
                // Package registries are best-effort
              }

              await writeInventory(result.inventory);

              if (ghResult.errors.length > 0) {
                for (const err of ghResult.errors) {
                  setCurrent(`Warning: ${err.context} — ${err.error}`);
                }
              }

              setCurrent(`GitHub: found ${ghResult.projects.length} repos, ${ghResult.starredRepos.length} starred`);
            } catch (err: any) {
              if (err instanceof GitHubAuthError) {
                setCurrent(`GitHub auth failed: ${err.message}`);
              } else {
                setCurrent(`GitHub scan failed: ${err.message}`);
              }
              // Continue with local-only results
            }
          }
        }

        setInventory(result.inventory);
        setAllProjects(result.projects);

        if (email) {
          setConfirmedEmails(email.split(",").map((e) => e.trim()));
          setPhase("recounting");
          return;
        }

        // Smart skip: use saved emails if already confirmed
        const skips = shouldSkipPhases(result.inventory, result.projects, { interactive, agent });
        if (skips.skipEmails && result.inventory.profile.emails.length > 0) {
          setCurrent(`Using saved emails (${result.inventory.profile.emails.join(", ")})`);
          setConfirmedEmails(result.inventory.profile.emails);
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
        else {
          // Smart skip: use saved selections if no new projects
          const skips = shouldSkipPhases(inventory!, updated, { interactive, agent });
          if (skips.skipSelector) {
            const saved = updated.filter((p) => p.included !== false);
            setCurrent(`${saved.length} projects selected (saved)`);
            setSelectedProjects(saved);
            // Also try to skip agent picker
            if (agent !== "auto") {
              try {
                const { adapter } = await resolveAdapter(agent);
                setResolvedAdapter(adapter);
                setPhase("analyzing");
              } catch (err: any) { onError(err.message); }
            } else {
              await trySkipAgent() || setPhase("picking-agent");
            }
          } else {
            setPhase("selecting");
          }
        }
      } catch (err: any) { onError(err.message); }
    }
    recount();
  }, [phase]);

  // Try to skip agent picker using saved agent
  async function trySkipAgent(): Promise<boolean> {
    if (interactive) return false;
    const savedAgent = inventory?.lastAgent;
    if (!savedAgent) return false;
    try {
      const { getAdapterByName } = await import("../lib/analysis/resolve-adapter.ts");
      const adapter = getAdapterByName(savedAgent);
      if (adapter && await adapter.isAvailable()) {
        setCurrent(`Using ${savedAgent}`);
        setResolvedAdapter(adapter);
        setPhase("analyzing");
        return true;
      }
    } catch { /* agent unavailable, show picker */ }
    return false;
  }

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
    // Smart skip: use saved agent if still available
    await trySkipAgent() || setPhase("picking-agent");
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
  // Track the full project set across retries so we don't lose successful results
  const allSelectedRef = useRef<Project[]>([]);
  // Track projects currently being analyzed (subset on retry)
  const [projectsToAnalyze, setProjectsToAnalyze] = useState<Project[]>([]);

  function finishAnalysis() {
    // Always use the full project set for post-analysis steps
    const fullProjects = allSelectedRef.current.length > 0 ? allSelectedRef.current : selectedProjects;
    async function finish() {
      try {
        // Enrich with GitHub data (stars, isPublic)
        if (!dryRun) {
          setCurrent("fetching GitHub data...");
          const enrichClient = await GitHubClient.create();
          await enrichGitHubData(fullProjects, enrichClient);
          // Sync to inventory.projects
          if (inventory) {
            const enriched = new Map(fullProjects.map((p) => [p.id, p]));
            for (const p of inventory.projects) {
              const ep = enriched.get(p.id);
              if (ep) { p.stars = ep.stars; p.isPublic = ep.isPublic; }
            }
          }
        }

        // Calculate significance scores and assign tiers
        if (!dryRun && inventory) {
          const { assignTiers } = await import("../lib/discovery/significance.ts");
          const tiers = assignTiers(fullProjects);
          // Write to both fullProjects and inventory.projects by id
          const tiersById = new Map(tiers);
          for (const p of inventory.projects) {
            const info = tiersById.get(p.id);
            if (info) { p.significance = info.score; p.tier = info.tier; }
          }
          for (const p of fullProjects) {
            const info = tiersById.get(p.id);
            if (info) { p.significance = info.score; p.tier = info.tier; }
          }
          await writeInventory(inventory);
        }

        // Generate profile insights (bio, highlights, narrative, skills)
        if (!dryRun && inventory) {
          const analyzed = fullProjects.filter((p) => p.analysis);
          const fingerprint = createHash("md5")
            .update(analyzed.map((p) => `${p.id}:${p.analysis?.analyzedAt}:${p.significance}`).sort().join("|"))
            .digest("hex");

          if (fingerprint !== inventory.insights._fingerprint) {
            try {
              const insights = await generateProfileInsights(fullProjects, resolvedAdapter!, (step) => setCurrent(step));
              if (insights) {
                inventory.insights = { ...insights, _fingerprint: fingerprint };
              }
            } catch (e: any) {
              setCurrent(`Warning: insights failed — ${e.message}. Publishing with existing.`);
            }
          }
        }
        if (inventory) await writeInventory(inventory);
        setPhase("done");
        onComplete({ projects: fullProjects, inventory: inventory!, adapter: resolvedAdapter! });
      } catch (err: any) { onError(err.message); }
    }
    finish();
  }

  // Phase 3: Analyze
  useEffect(() => {
    if (phase !== "analyzing" || !resolvedAdapter) return;
    async function run() {
      try {
        // On first run, projectsToAnalyze is empty — use selectedProjects
        const toAnalyze = projectsToAnalyze.length > 0 ? projectsToAnalyze : selectedProjects;
        // Save the full set on first analysis run
        if (allSelectedRef.current.length === 0) {
          allSelectedRef.current = selectedProjects;
        }

        const result = await analyzeProjects(toAnalyze, resolvedAdapter!, inventory!, {
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

        // Clear retry state
        setProjectsToAnalyze([]);
        finishAnalysis();
      } catch (err: any) { onError(err.message); }
    }
    run();
  }, [phase, resolvedAdapter]);

  // Handle failure screen input
  useInput((input, key) => {
    if (phase !== "analysis-failed") return;
    if (input === "r") {
      // Retry only failed projects, keep successful results intact
      setProjectsToAnalyze(failedProjects.map((f) => f.project));
      setFailedProjects([]);
      setPhase("analyzing");
    } else if (input === "s") {
      // Skip failures, continue with whatever succeeded
      setProjectsToAnalyze([]);
      finishAnalysis();
    } else if (input === "a") {
      // Switch agent and retry failed projects only
      setProjectsToAnalyze(failedProjects.map((f) => f.project));
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
          <Text color="green">Found {scanCount} project{scanCount !== 1 ? "s" : ""}{prevProjectCount > 0 ? <Text color="gray"> (was {prevProjectCount})</Text> : ""}</Text>
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
    const allEntries = [...projectStatuses.entries()]
      .map(([id, { status, detail }]) => {
        const p = selectedProjects.find((p) => p.id === id);
        return { id, name: p?.displayName || id, status, detail };
      });
    const analyzing = allEntries.filter((e) => e.status === "analyzing");
    const done = allEntries.filter((e) => e.status === "done" || e.status === "cached");
    const failed = allEntries.filter((e) => e.status === "failed");
    const total = allEntries.length || progress.total || 1;
    const completed = done.length;
    const currentName = analyzing[0]?.name || current || "";

    // Progress bar
    const barWidth = 20;
    const filledWidth = Math.round((completed / total) * barWidth);
    const bar = "█".repeat(filledWidth) + "░".repeat(barWidth - filledWidth);
    const pct = Math.round((completed / total) * 100);

    return (
      <Box flexDirection="column">
        {dryRun && <Text dimColor>(dry-run mode, no LLM calls)</Text>}
        <Text>
          <Text color="yellow">Analyzing </Text>
          <Text>[{completed}/{total}] </Text>
          <Text bold>{currentName} </Text>
          <Text color="yellow">{bar}</Text>
          <Text> {pct}%</Text>
        </Text>
        {failed.length > 0 && <Text color="red">{failed.length} failed</Text>}
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
