import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { readInventory, writeInventory } from "../lib/inventory/store.ts";
import { countUnanalyzed } from "../lib/pipeline.ts";
import { track, flush as flushTelemetry } from "../lib/telemetry.ts";
import { Pipeline, type PipelineResult } from "../components/Pipeline.tsx";
import {
  readAuthToken,
  startDeviceFlow,
  pollForToken,
  publishToApi,
  writeAuthToken,
  PendingError,
  SlowDownError,
} from "../lib/auth.ts";
import type { Inventory, Project, AgentAdapter } from "../lib/types.ts";
import { exec } from "node:child_process";

type Phase =
  | "checking-auth" | "auth" | "polling"
  | "pipeline" | "using-cache"
  | "checking-public" | "confirming" | "publishing" | "done" | "error";

type CacheStep = "loading" | "scoring" | "insights" | "saving" | "done";

interface Props {
  args?: string[];
  options: { bio?: string; noOpen?: boolean; all?: boolean; agent?: string; email?: string; yes?: boolean };
}

export default function Publish({ args, options }: Props) {
  const { exit } = useApp();
  const dir = args?.[0];
  const [phase, setPhase] = useState<Phase>("checking-auth");
  const [userCode, setUserCode] = useState("");
  const [verificationUri, setVerificationUri] = useState("");
  const [resultUrl, setResultUrl] = useState("");
  const [error, setError] = useState("");
  const [publicCount, setPublicCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [analyzedCount, setAnalyzedCount] = useState(0);
  const [jwt, setJwt] = useState("");

  const [pipelineResult, setPipelineResult] = useState<PipelineResult | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [selectedProjects, setSelectedProjects] = useState<Project[]>([]);
  const [adapter, setAdapter] = useState<AgentAdapter | null>(null);
  const [cacheStep, setCacheStep] = useState<CacheStep>("loading");
  const [yearProgress, setYearProgress] = useState<Map<string, "pending" | "running" | "done">>(new Map());

  // Step 1: Auth
  useEffect(() => {
    async function auth() {
      try {
        let authData = await readAuthToken();
        if (authData?.jwt) {
          setJwt(authData.jwt);
          startPipeline();
          return;
        }
        setPhase("auth");
        const flow = await startDeviceFlow();
        setUserCode(flow.userCode);
        setVerificationUri(flow.verificationUri);
        try { exec(`open ${flow.verificationUri}`); } catch {}

        setPhase("polling");
        let interval = flow.interval;
        while (true) {
          await sleep(interval * 1000);
          try {
            authData = await pollForToken(flow.deviceCode);
            setJwt(authData.jwt);
            startPipeline();
            return;
          } catch (e) {
            if (e instanceof PendingError) continue;
            if (e instanceof SlowDownError) { interval += 2; continue; }
            throw e;
          }
        }
      } catch (e: any) { setError(e.message); setPhase("error"); }
    }
    auth();
  }, []);

  function startPipeline() {
    if (dir) {
      setPhase("pipeline");
    } else {
      // No dir — use existing inventory, skip pipeline
      setPhase("using-cache");
    }
  }

  // Load cached inventory when no directory
  useEffect(() => {
    if (phase !== "using-cache") return;
    async function loadCache() {
      setCacheStep("loading");
      const inv = await readInventory();
      if (inv.projects.length === 0) {
        setError("No projects found. Provide a directory: `agent-cv publish ~/Projects`");
        setPhase("error");
        return;
      }
      const projects = inv.projects.filter((p) => !p.tags.includes("removed") && p.included !== false);

      // Enrich GitHub data if not done (isPublic, stars)
      const needsGitHub = projects.some((p) => p.remoteUrl?.includes("github.com") && p.isPublic == null);
      if (needsGitHub) {
        setCacheStep("scoring"); // reuse scoring step visually
        const { enrichGitHubData } = await import("../lib/pipeline.ts");
        await enrichGitHubData(projects);
        // Sync back to inventory
        const enriched = new Map(projects.map((p) => [p.id, p]));
        for (const p of inv.projects) {
          const ep = enriched.get(p.id);
          if (ep) { p.stars = ep.stars; p.isPublic = ep.isPublic; }
        }
      }

      // Ensure significance scores exist (may be missing if last run was cached)
      const needsScoring = projects.some((p) => p.significance == null);
      if (needsScoring) {
        setCacheStep("scoring");
        const { assignTiers } = await import("../lib/discovery/significance.ts");
        const tiers = assignTiers(projects);
        for (const p of inv.projects) {
          const info = tiers.get(p.id);
          if (info) { p.significance = info.score; p.tier = info.tier; }
        }
        for (const p of projects) {
          const info = tiers.get(p.id);
          if (info) { p.significance = info.score; p.tier = info.tier; }
        }
      }

      // Regenerate insights if fingerprint changed (scores affect project selection)
      const { createHash } = await import("node:crypto");
      const { generateProfileInsights } = await import("../lib/analysis/bio-generator.ts");
      const analyzed = projects.filter((p) => p.analysis);
      const fingerprint = createHash("md5")
        .update(analyzed.map((p) => `${p.id}:${p.analysis?.analyzedAt}:${p.significance}`).sort().join("|"))
        .digest("hex");

      if (fingerprint !== inv.insights._fingerprint) {
        // Build year list for progress display
        const yearSet = new Set<string>();
        for (const p of projects) {
          const y = (p.dateRange.end || p.dateRange.start || "").split("-")[0];
          if (y && y !== "Unknown") yearSet.add(y);
        }
        const initYears = new Map<string, "pending" | "running" | "done">();
        [...yearSet].sort((a, b) => b.localeCompare(a)).forEach((y) => initYears.set(y, "pending"));
        setYearProgress(initYears);
        setCacheStep("insights");
        try {
          const { resolveAdapter } = await import("../lib/analysis/resolve-adapter.ts");
          const { adapter: adapterInstance } = await resolveAdapter();
          if (adapterInstance) {
            const insights = await generateProfileInsights(projects, adapterInstance, (step) => {
              // Parse year from step like "2026 (45 projects)..."
              const yearMatch = step.match(/^(\d{4})\s/);
              if (yearMatch) {
                setYearProgress((prev) => {
                  const next = new Map(prev);
                  // Mark previous running years as done
                  for (const [y, s] of next) { if (s === "running") next.set(y, "done"); }
                  next.set(yearMatch[1], "running");
                  return next;
                });
              } else if (step.includes("profile")) {
                // Aggregation step — mark all years done
                setYearProgress((prev) => {
                  const next = new Map(prev);
                  for (const [y, s] of next) { if (s === "running") next.set(y, "done"); }
                  return next;
                });
                setCacheStep("insights");
              }
            });
            if (insights) {
              inv.insights = { ...insights, _fingerprint: fingerprint };
            }
          }
        } catch (e: any) {
          console.error(`Warning: insights generation failed: ${e.message}. Publishing with existing insights.`);
        }
      }

      setCacheStep("saving");
      await writeInventory(inv);
      setCacheStep("done");
      setInventory(inv);
      setSelectedProjects(projects);
      setPhase("checking-public");
    }
    loadCache();
  }, [phase]);

  // Pipeline complete
  const handlePipelineComplete = useCallback(async (result: PipelineResult) => {
    setPipelineResult(result);
    setInventory(result.inventory);
    setSelectedProjects(result.projects);
    setAdapter(result.adapter);
    setPhase("checking-public");
  }, []);

  // Step 5a: Count public repos (data already enriched by pipeline)
  useEffect(() => {
    if (phase !== "checking-public") return;
    setTotalCount(selectedProjects.length);
    setAnalyzedCount(selectedProjects.filter((p) => p.analysis).length);
    setPublicCount(selectedProjects.filter((p) => p.isPublic).length);
    if (options.yes) {
      doPublish();
      return;
    }
    setPhase("confirming");
  }, [phase, selectedProjects]);

  // Confirmation — only active in confirming phase without --yes
  useInput((input, key) => {
    if (input === "y" || key.return) doPublish();
    else if (input === "n" || key.escape) { setError("Cancelled."); setPhase("error"); }
  }, { isActive: phase === "confirming" && !options.yes });

  async function doPublish() {
    setPhase("publishing");
    try {
      const payload = sanitizeForPublish(inventory!, options.bio);
      const result = await publishToApi(jwt, payload);
      await track("publish_complete", { projects: payload.inventory.projects.length });
      await flushTelemetry();
      setResultUrl(result.url);
      setPhase("done");
      // Wait briefly for server to process before opening browser
      if (!options.noOpen) { setTimeout(() => { try { exec(`open ${result.url}`); } catch {} }, 2000); }
    } catch (e: any) {
      if (e.message === "AUTH_EXPIRED") {
        await writeAuthToken({ jwt: "", username: "", obtainedAt: "" });
        setError("Session expired. Run `agent-cv publish` again.");
        setPhase("error");
      } else { setError(e.message); setPhase("error"); }
    }
  }

  // Exit on terminal states
  useEffect(() => {
    if (phase === "error" || phase === "done") {
      const timer = setTimeout(() => exit(), 100);
      return () => clearTimeout(timer);
    }
  }, [phase, exit]);

  // Render
  if (phase === "error") return <Text color="red">Error: {error}</Text>;
  if (phase === "checking-auth") return <Text color="gray">Checking authentication...</Text>;
  if (phase === "auth") return (
    <Box flexDirection="column" gap={1}>
      <Text>Open this URL in your browser:</Text>
      <Text bold color="cyan">{verificationUri}</Text>
      <Text>Enter code: <Text bold color="yellow">{userCode}</Text></Text>
    </Box>
  );
  if (phase === "polling") return (
    <Box flexDirection="column" gap={1}>
      <Text color="gray">Waiting for authorization...</Text>
      <Text>Enter code: <Text bold color="yellow">{userCode}</Text></Text>
    </Box>
  );
  if (phase === "pipeline") return (
    <Pipeline
      options={{ directory: dir!, all: options.all, email: options.email, agent: options.agent }}
      onComplete={handlePipelineComplete}
      onError={(msg) => { setError(msg); setPhase("error"); }}
    />
  );
  if (phase === "using-cache") {
    if (cacheStep === "loading") return <Text color="gray">Loading inventory...</Text>;
    if (cacheStep === "scoring") return <Text color="gray">Scoring projects...</Text>;
    if (cacheStep === "saving") return <Text color="gray">Saving...</Text>;
    if (cacheStep === "insights") {
      return (
        <Box flexDirection="column">
          <Text color="gray">Generating insights:</Text>
          {[...yearProgress.entries()].map(([year, status]) => (
            <Text key={year} color={status === "done" ? "green" : status === "running" ? "yellow" : "gray"}>
              {"  "}{status === "done" ? "✓" : status === "running" ? "◌" : "·"} {year}
            </Text>
          ))}
        </Box>
      );
    }
    return <Text color="gray">Preparing...</Text>;
  }
  if (phase === "checking-public") return <Text color="gray">Checking repos...</Text>;
  if (phase === "confirming") return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Ready to publish your profile:</Text>
      {!dir && inventory?.lastScan && (
        <Text color="gray">  Using inventory from {new Date(inventory.lastScan).toLocaleDateString()}. To rescan: `agent-cv publish {inventory.scanPaths?.[0] || "~/Projects"}`</Text>
      )}
      <Text color="gray">  {totalCount} projects will appear on your page</Text>
      <Text color="gray">  {publicCount} with GitHub links (public repos only)</Text>
      <Text color="gray">  {totalCount - publicCount} private (URLs hidden)</Text>
      <Text color="gray">  Local paths, secrets, emails are stripped</Text>
      <Text> </Text>
      <Text>Publish to agent-cv.dev? <Text color="green" bold>(y)</Text> / <Text color="red">n</Text></Text>
    </Box>
  );
  if (phase === "publishing") return <Text color="gray">Publishing to agent-cv.dev...</Text>;

  return (
    <Box flexDirection="column" gap={1}>
      <Text> </Text>
      <Box borderStyle="round" borderColor="green" paddingX={2} paddingY={1} flexDirection="column" alignItems="center">
        <Text bold>Your profile is live at</Text>
        <Text bold color="cyan">{resultUrl}</Text>
      </Box>
      <Text color="gray">{totalCount} projects ({analyzedCount} with AI analysis) · {publicCount} public, {totalCount - publicCount} private</Text>
      <Text> </Text>
    </Box>
  );
}


function sanitizeForPublish(
  inventory: Inventory,
  bioOverride?: string
) {
  const { profile, insights } = inventory;
  const projects = inventory.projects.filter((p) => p.included !== false).map((p: Project) => {
    const isPublic = p.isPublic ?? false;
    return {
      id: p.id, displayName: p.displayName, type: p.type, language: p.language,
      frameworks: p.frameworks, dateRange: p.dateRange, hasGit: p.hasGit,
      commitCount: p.commitCount, authorCommitCount: p.authorCommitCount,
      hasUncommittedChanges: p.hasUncommittedChanges,
      lastCommit: p.lastCommit,
      analysis: p.analysis,
      tags: p.tags, included: true,
      remoteUrl: isPublic ? p.remoteUrl : null,
      stars: p.stars || undefined,
      isPublic,
      isOwner: p.isOwner,
      significance: p.significance,
      tier: p.tier,
    };
  });
  // Build socialLinks in the format the web API expects (full URLs)
  const socialLinks: Record<string, string> = {};
  if (profile.socials?.github) socialLinks.github = `https://github.com/${profile.socials.github}`;
  if (profile.socials?.twitter) socialLinks.twitter = `https://twitter.com/${profile.socials.twitter}`;
  if (profile.socials?.linkedin) socialLinks.linkedin = `https://linkedin.com/in/${profile.socials.linkedin}`;
  if (profile.socials?.telegram) socialLinks.telegram = `https://t.me/${profile.socials.telegram}`;
  if (profile.socials?.website) socialLinks.website = profile.socials.website;
  if (profile.emailPublic && profile.emails?.[0]) socialLinks.email = profile.emails[0];

  return {
    inventory: { version: inventory.version, projects },
    bio: bioOverride || insights.bio,
    socialLinks: Object.keys(socialLinks).length > 0 ? socialLinks : undefined,
    name: profile.name,
    highlightsByYear: insights.highlightsByYear,
    narrative: insights.narrative,
    strongestSkills: insights.strongestSkills,
    uniqueTraits: insights.uniqueTraits,
    yearlyThemes: insights.yearlyThemes,
    yearlyInsights: insights.yearlyInsights,
  };
}

/**
 * Ensure every year gets at least 1 highlight, then fill remaining slots.
 * Newest years get priority for extra slots.
 */
function compactHighlights(
  byYear: Record<string, string[]> | undefined,
  limit: number
): string[] {
  if (!byYear) return [];
  const years = Object.keys(byYear).sort((a, b) => b.localeCompare(a)); // newest first
  const result: string[] = [];

  // Round 1: 1 highlight per year
  for (const year of years) {
    const projs = byYear[year] ?? [];
    if (projs[0] && result.length < limit) result.push(projs[0]);
  }

  // Round 2: fill remaining slots with extras (newest years first)
  for (const year of years) {
    const projs = byYear[year] ?? [];
    if (projs.length === 0) continue;
    for (let i = 1; i < projs.length && result.length < limit; i++) {
      const p = projs[i];
      if (p && !result.includes(p)) result.push(p);
    }
  }

  return result;
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
