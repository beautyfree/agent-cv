import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useMachine } from "@xstate/react";
import { Text, Box, useInput, useStdout } from "ink";
import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { readInventory, writeInventory } from "@agent-cv/core/src/inventory/store.ts";
import { resolveAdapter } from "@agent-cv/core/src/analysis/adapters/resolve-adapter.ts";
import { generateProfileInsights } from "@agent-cv/core/src/insights/bio-generator.ts";
import { ProjectSelector } from "./ProjectSelector.tsx";
import { EmailPicker } from "./EmailPicker.tsx";
import { AgentPicker } from "./AgentPicker.tsx";
import {
  scanAndMerge,
  collectEmails,
  recountAndTag,
  analyzeProjects,
  shouldSkipPhases,
  detectProjectGroups,
  detectProjectGroupsFromRemotes,
  type ProjectStatus,
} from "@agent-cv/core/src/pipeline.ts";
import type { Project, Inventory, AgentAdapter } from "@agent-cv/core/src/types.ts";
import { markNoticeSeen, track, trackPipelineStep } from "@agent-cv/core/src/telemetry.ts";
import { detectGitHubUsername } from "@agent-cv/core/src/discovery/github-scanner.ts";
import { mergeGitHubCloudIntoScanResult } from "@agent-cv/core/src/pipeline/github-cloud-phase.ts";
import { pipelinePhaseMachine, gotoPhaseEvent, isValidPhaseTransition, type Phase } from "../pipeline/phase-machine.ts";

/** Ink attaches stdin raw mode only while some `useInput` is active; otherwise Ctrl+C never reaches `exitOnCtrlC`. */
const PIPELINE_PHASES_PASSIVE_STDIN = new Set<Phase>(["scanning", "recounting", "analyzing", "finishing"]);

/**
 * Long-running scan/analyze UI. Phase orchestration is `pipelinePhaseMachine` (XState).
 * `setPhase` below forwards to `send(gotoPhaseEvent(...))` with `isValidPhaseTransition` —
 * it is not a separate React `useState` phase model (see CONTRIBUTING.md, “CLI architecture”).
 */
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
  /** Merge scan without reusing saved projects or analysis (see scan-merge `fresh`) */
  fresh?: boolean;
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

/**
 * Reusable pipeline component: scan → emails → recount → select → agent → analyze.
 * Commands provide onComplete to do their specific thing with the results.
 */
export function Pipeline({ options, onComplete, onError }: Props) {
  const {
    directory,
    all: selectAll,
    email,
    agent = "auto",
    noCache,
    dryRun,
    github: githubUsername,
    includeForks,
    interactive,
    fresh,
  } = options;

  const { write } = useStdout();
  const pipelineMachineInput = useMemo(
    () => ({
      bootstrap: async () => ({ alreadySeen: await markNoticeSeen() }),
    }),
    []
  );
  const [snapshot, send, phaseActor] = useMachine(pipelinePhaseMachine, {
    input: pipelineMachineInput,
  });
  const phase = snapshot.value as Phase;
  const showTelemetryNotice = snapshot.context.showTelemetryNotice;
  /** Tracks last committed machine phase for clear-screen on interactive steps only after a real transition. */
  const lastPhaseForClearRef = useRef<Phase | null>(null);

  useEffect(() => {
    const interactivePhases = new Set<Phase>(["picking-emails", "selecting", "picking-agent"]);
    const prev = lastPhaseForClearRef.current;
    if (prev !== null && prev !== phase && interactivePhases.has(phase)) {
      write("\x1b[2J\x1b[H");
    }
    lastPhaseForClearRef.current = phase;
  }, [phase, write]);

  const setPhase = useCallback(
    (next: Phase) => {
      const from = phaseActor.getSnapshot().value as Phase;
      if (!isValidPhaseTransition(from, next)) {
        if (process.env.NODE_ENV !== "production") {
          console.warn(`[Pipeline] Ignored invalid phase transition: ${from} -> ${next}`);
        }
        return;
      }
      send(gotoPhaseEvent(next));
    },
    [send, phaseActor]
  );
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [selectedProjects, setSelectedProjects] = useState<Project[]>([]);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [resolvedAdapter, setResolvedAdapter] = useState<AgentAdapter | null>(null);

  // Scan progress (throttled to avoid excessive re-renders)
  const [scanCount, setScanCount] = useState(0);
  const [lastFound, setLastFound] = useState("");
  const [prevProjectCount, setPrevProjectCount] = useState(0);
  const [scanElapsedSec, setScanElapsedSec] = useState(0);
  const [scanStatus, setScanStatus] = useState("Preparing scan...");
  const scanThrottle = React.useRef(0);

  // Email picker state
  const [emailCounts, setEmailCounts] = useState<Map<string, number>>(new Map());
  const [gitConfigEmails, setGitConfigEmails] = useState<Set<string>>(new Set());
  const [confirmedEmails, setConfirmedEmails] = useState<string[]>([]);

  // Analysis progress
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [current, setCurrent] = useState("");
  const [projectStatuses, setProjectStatuses] = useState<Map<string, { status: ProjectStatus; detail?: string }>>(
    new Map()
  );

  // Phase 1: Scan
  const scanningRef = useRef(false);
  useEffect(() => {
    if (phase !== "scanning") {
      scanningRef.current = false;
      return;
    }
    if (scanningRef.current) return;
    scanningRef.current = true;

    const scanAbort = new AbortController();

    async function scan() {
      const phaseScanStarted = Date.now();
      try {
        await track("command_start", { command: "pipeline" });
        const existingInv = await readInventory();
        const absDir = resolvePath(directory);
        const prevCount = existingInv.projects.filter(
          (p) => !p.tags.includes("removed") && p.path.startsWith(absDir)
        ).length;
        setPrevProjectCount(prevCount);
        const scanState = { count: 0, last: "" };
        const result = await scanAndMerge(
          directory,
          {
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
            onStatus: (message) => {
              setScanStatus(message);
            },
          },
          { skipGitHubEnrich: dryRun, signal: scanAbort.signal, fresh }
        );
        // Final update with latest values
        setScanCount(scanState.count);
        setLastFound(scanState.last);

        if (result.projects.length === 0) {
          await trackPipelineStep("phase_scan", Date.now() - phaseScanStarted, {
            outcome: "no_projects",
          });
          onError(`No projects found in ${directory}`);
          return;
        }

        // Detect project groups (frontend+backend in same org → one group)
        detectProjectGroups(result.projects, directory);

        // GitHub cloud scanning + package registries (lib module — testable with mocked client)
        const ghUser = githubUsername || detectGitHubUsername(result.inventory);
        if (ghUser) {
          const cloud = await mergeGitHubCloudIntoScanResult(
            {
              inventory: result.inventory,
              projects: result.projects,
              ghUser,
              includeForks,
              signal: scanAbort.signal,
            },
            {
              onStatus: setCurrent,
              onGitHubProgress: (done, total, name) => {
                setCurrent(`GitHub: ${done}/${total} — ${name}`);
              },
              onGitHubScanComplete: async (durationMs, meta) => {
                await trackPipelineStep("github_cloud_scan", durationMs, {
                  cloud_repos: meta.cloud_repos,
                });
              },
              onPackageRegistrySearchComplete: async (durationMs, meta) => {
                await trackPipelineStep("package_registry_search", durationMs, {
                  packages_found: meta.packages_found,
                });
              },
            }
          );
          result.inventory = cloud.inventory;
          result.projects = cloud.projects;
        }

        detectProjectGroupsFromRemotes(result.projects);

        setInventory(result.inventory);
        setAllProjects(result.projects);

        const reportPhaseScan = async (branch: string) => {
          await trackPipelineStep("phase_scan", Date.now() - phaseScanStarted, {
            outcome: "ok",
            branch,
            project_count: result.projects.length,
          });
        };

        if (email) {
          await reportPhaseScan("email_flag");
          setConfirmedEmails(email.split(",").map((e) => e.trim()));
          setPhase("recounting");
          return;
        }

        // Smart skip: use saved emails if already confirmed
        const skips = shouldSkipPhases(result.inventory, result.projects, { interactive, agent });
        if (skips.skipEmails && result.inventory.profile.emails.length > 0) {
          setCurrent(`Using saved emails (${result.inventory.profile.emails.join(", ")})`);
          await reportPhaseScan("skip_emails_saved");
          setConfirmedEmails(result.inventory.profile.emails);
          setPhase("recounting");
          return;
        }

        const emails = await collectEmails(result.projects, result.inventory.profile.emails);
        setEmailCounts(emails.emailCounts);
        setGitConfigEmails(emails.preSelected);

        if (emails.emailCounts.size === 0) {
          await reportPhaseScan("no_git_emails");
          setConfirmedEmails([]);
          setPhase("selecting");
          return;
        }
        await reportPhaseScan("to_email_picker");
        setPhase("picking-emails");
      } catch (err: any) {
        if (err?.name === "AbortError") {
          return;
        }
        await trackPipelineStep("phase_scan", Date.now() - phaseScanStarted, { outcome: "error" });
        onError(err.message);
      } finally {
        scanningRef.current = false;
      }
    }
    void scan();
    return () => {
      scanAbort.abort();
    };
  }, [phase, directory, email, dryRun, githubUsername, includeForks, interactive, agent, fresh]);

  useEffect(() => {
    if (phase !== "scanning") {
      setScanElapsedSec(0);
      setScanStatus("Preparing scan...");
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(() => {
      setScanElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [phase]);

  // Email picker
  const handleEmailPick = useCallback(
    async (selected: string[], save: boolean) => {
      setConfirmedEmails(selected);
      if (save && inventory) {
        inventory.profile.emails = selected;
        inventory.profile.emailsConfirmed = true;
        await writeInventory(inventory);
      }
      setPhase("recounting");
    },
    [inventory]
  );

  // Phase 2: Recount
  const recountingRef = useRef(false);
  useEffect(() => {
    if (phase !== "recounting") {
      recountingRef.current = false;
      return;
    }
    if (recountingRef.current) return;
    recountingRef.current = true;
    async function recount() {
      try {
        const updated = await recountAndTag(allProjects, confirmedEmails);
        setAllProjects(updated);
        if (inventory) await writeInventory(inventory);
        if (selectAll) {
          setSelectedProjects(updated);
          setPhase("picking-agent");
        } else {
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
              } catch (err: any) {
                onError(err.message);
              }
            } else {
              (await trySkipAgent()) || setPhase("picking-agent");
            }
          } else {
            setPhase("selecting");
          }
        }
      } catch (err: any) {
        onError(err.message);
      }
    }
    recount();
  }, [phase]);

  // Try to skip agent picker using saved agent
  async function trySkipAgent(): Promise<boolean> {
    if (interactive) return false;
    const savedAgent = inventory?.lastAgent;
    if (!savedAgent) return false;
    try {
      const { getAdapterByName } = await import("@agent-cv/core/src/analysis/adapters/resolve-adapter.ts");
      const adapter = getAdapterByName(savedAgent);
      if (adapter && (await adapter.isAvailable())) {
        setCurrent(`Using ${savedAgent}`);
        setResolvedAdapter(adapter);
        setPhase("analyzing");
        return true;
      }
    } catch {
      /* agent unavailable, show picker */
    }
    return false;
  }

  // Project selection — save included/excluded to inventory
  const handleSelection = useCallback(
    async (selected: Project[]) => {
      if (selected.length === 0) {
        onError("No projects selected.");
        return;
      }
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
        } catch (err: any) {
          onError(err.message);
        }
        return;
      }
      // Smart skip: use saved agent if still available
      (await trySkipAgent()) || setPhase("picking-agent");
    },
    [agent]
  );

  // Agent picker — save choice to inventory
  const handleAgentPick = useCallback(
    async (adapter: AgentAdapter, name: string) => {
      if (inventory) {
        inventory.lastAgent = name;
        await writeInventory(inventory);
      }
      setResolvedAdapter(adapter);
      setPhase("analyzing");
    },
    [inventory]
  );

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
      const finishStarted = Date.now();
      try {
        setPhase("finishing");
        if (dryRun) {
          setCurrent("Dry-run: skipping scoring and profile synthesis…");
        }

        // GitHub metadata (stars, visibility, fork) is enriched in scanAndMerge (one GET /repos per repo).

        // Calculate significance scores and assign tiers
        if (!dryRun && inventory) {
          setCurrent("Scoring projects and assigning tiers…");
          const { assignTiers } = await import("@agent-cv/core/src/discovery/significance.ts");
          const tiers = assignTiers(fullProjects);
          // Write to both fullProjects and inventory.projects by id
          const tiersById = new Map(tiers);
          for (const p of inventory.projects) {
            const info = tiersById.get(p.id);
            if (info) {
              p.significance = info.score;
              p.tier = info.tier;
            }
          }
          for (const p of fullProjects) {
            const info = tiersById.get(p.id);
            if (info) {
              p.significance = info.score;
              p.tier = info.tier;
            }
          }
          await writeInventory(inventory);
        }

        // Generate profile insights (bio, highlights, narrative, skills)
        if (!dryRun && inventory) {
          const analyzed = fullProjects.filter((p) => p.analysis);
          const fingerprint = createHash("md5")
            .update(
              analyzed
                .map((p) => `${p.id}:${p.analysis?.analyzedAt}:${p.significance}`)
                .sort()
                .join("|")
            )
            .digest("hex");

          if (fingerprint !== (inventory.insights?._fingerprint ?? "")) {
            try {
              const insights = await generateProfileInsights(fullProjects, resolvedAdapter!, (step) =>
                setCurrent(step)
              );
              if (insights) {
                inventory.insights = { ...insights, _fingerprint: fingerprint };
              }
            } catch (e: any) {
              setCurrent(`Warning: insights failed — ${e.message}. Publishing with existing.`);
            }
          } else {
            setCurrent("Profile insights up to date (cache hit).");
          }
        }
        if (inventory) {
          setCurrent("Saving inventory…");
          await writeInventory(inventory);
        }
        await trackPipelineStep("phase_finish", Date.now() - finishStarted, {
          dry_run: dryRun,
        });
        setPhase("done");
        onComplete({ projects: fullProjects, inventory: inventory!, adapter: resolvedAdapter! });
      } catch (err: any) {
        onError(err.message);
      }
    }
    finish();
  }

  // Phase 3: Analyze
  const analyzingRef = useRef(false);
  const abortAnalyzeRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortAnalyzeRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (phase !== "analyzing") {
      analyzingRef.current = false;
      return;
    }
    if (!resolvedAdapter || analyzingRef.current) return;
    analyzingRef.current = true;
    async function run() {
      const ac = new AbortController();
      abortAnalyzeRef.current = ac;
      try {
        // On first run, projectsToAnalyze is empty — use selectedProjects
        const toAnalyze = projectsToAnalyze.length > 0 ? projectsToAnalyze : selectedProjects;
        // Save the full set on first analysis run
        if (allSelectedRef.current.length === 0) {
          allSelectedRef.current = selectedProjects;
        }

        const result = await analyzeProjects(toAnalyze, resolvedAdapter!, inventory!, {
          noCache,
          dryRun,
          signal: ac.signal,
          onProgress: (done, total, cur) => {
            setProgress({ done, total });
            setCurrent(cur);
          },
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
          duration_ms: result.durationMs,
        });

        if (result.failed.length > 0) {
          setFailedProjects(result.failed);
          setPhase("analysis-failed");
          return;
        }

        // Clear retry state
        setProjectsToAnalyze([]);
        finishAnalysis();
      } catch (err: any) {
        analyzingRef.current = false;
        const aborted = err?.name === "AbortError" || err?.message === "Analysis cancelled";
        if (aborted) {
          onError("Cancelled.");
          return;
        }
        onError(err.message ?? String(err));
      } finally {
        abortAnalyzeRef.current = null;
      }
    }
    run();
  }, [phase, resolvedAdapter]);

  // Handle failure screen input
  useInput(
    (input) => {
      if (input === "r") {
        // Retry only failed projects, keep successful results intact
        setProjectsToAnalyze(failedProjects.map((f) => f.project));
        setFailedProjects([]);
        analyzingRef.current = false;
        setPhase("analyzing");
      } else if (input === "s") {
        // Skip failures, continue with whatever succeeded
        setProjectsToAnalyze([]);
        setFailedProjects([]);
        finishAnalysis();
      } else if (input === "a") {
        // Switch agent and retry failed projects only
        setProjectsToAnalyze(failedProjects.map((f) => f.project));
        setFailedProjects([]);
        analyzingRef.current = false;
        setResolvedAdapter(null);
        setPhase("picking-agent");
      }
    },
    { isActive: phase === "analysis-failed" }
  );

  useInput(() => {}, { isActive: PIPELINE_PHASES_PASSIVE_STDIN.has(phase) });

  // Render based on phase
  if (phase === "init") return null;
  if (phase === "scanning")
    return (
      <Box flexDirection="column">
        {showTelemetryNotice && (
          <Box marginBottom={1} flexDirection="column">
            <Text dimColor>Anonymous telemetry enabled. Disable: agent-cv config or AGENT_CV_TELEMETRY=off</Text>
          </Box>
        )}
        <Text color="yellow">Scanning {directory}...</Text>
        <Text dimColor>
          {scanStatus} {scanElapsedSec}s elapsed
        </Text>
        {scanCount === 0 && scanElapsedSec >= 10 && (
          <Text dimColor>This can take time on large folders before first matches appear.</Text>
        )}
        {scanCount > 0 && (
          <Text>
            <Text color="green">
              Found {scanCount} project{scanCount !== 1 ? "s" : ""}
              {prevProjectCount > 0 ? <Text color="gray"> (was {prevProjectCount})</Text> : ""}
            </Text>
            {lastFound ? <Text dimColor> — {lastFound}</Text> : null}
          </Text>
        )}
      </Box>
    );
  if (phase === "picking-emails")
    return <EmailPicker emailCounts={emailCounts} preSelected={gitConfigEmails} onSubmit={handleEmailPick} />;
  if (phase === "recounting") return <Text color="yellow">Identifying your projects...</Text>;
  if (phase === "selecting")
    return <ProjectSelector projects={allProjects} scanRoot={directory} onSubmit={handleSelection} />;
  if (phase === "picking-agent")
    return <AgentPicker onSubmit={handleAgentPick} onBack={handleAgentBack} defaultAgent={inventory?.lastAgent} />;
  if (phase === "analyzing") {
    const allEntries = [...projectStatuses.entries()].map(([id, { status, detail }]) => {
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
          <Text>
            [{completed}/{total}]{" "}
          </Text>
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
        <Text color="yellow" bold>
          Analysis complete with errors
        </Text>
        <Text color="green"> {analyzed} analyzed successfully</Text>
        <Text color="red"> {failedProjects.length} failed:</Text>
        {failedProjects.slice(0, 10).map((f) => (
          <Text key={f.project.id} dimColor>
            {" "}
            {f.project.path}: {f.error.slice(0, 80)}
          </Text>
        ))}
        {failedProjects.length > 10 && <Text dimColor> ...and {failedProjects.length - 10} more</Text>}
        <Text> </Text>
        <Text>[r] retry failed [a] switch agent and retry [s] skip and continue</Text>
      </Box>
    );
  }
  if (phase === "finishing") {
    return (
      <Box flexDirection="column">
        <Text color="yellow" bold>
          Wrapping up
        </Text>
        <Text dimColor>{current || "…"}</Text>
      </Box>
    );
  }

  return null; // done phase handled by parent via onComplete
}
