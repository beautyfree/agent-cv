import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { readInventory } from "../lib/inventory/store.ts";
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
      const inv = await readInventory();
      if (inv.projects.length === 0) {
        setError("No projects found. Provide a directory: `agent-cv publish ~/Projects`");
        setPhase("error");
        return;
      }
      setInventory(inv);
      const projects = inv.projects.filter((p) => !p.tags.includes("removed") && p.included !== false);
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

  const [publicFlags, setPublicFlags] = useState<Record<string, { isPublic: boolean; stars: number }>>({});

  // Step 5a: Check public repos
  useEffect(() => {
    if (phase !== "checking-public") return;
    async function check() {
      try {
        setTotalCount(selectedProjects.length);
        setAnalyzedCount(selectedProjects.filter((p) => p.analysis).length);
        const flags = await checkPublicRepos(selectedProjects);
        // Save stars to projects
        for (const p of selectedProjects) {
          const info = flags[p.id];
          if (info) p.stars = info.stars;
        }
        setPublicFlags(flags);
        setPublicCount(Object.values(flags).filter((f) => f.isPublic).length);
        if (options.yes) {
          doPublish();
          return;
        }
        setPhase("confirming");
      } catch (e: any) { setError(e.message); setPhase("error"); }
    }
    check();
  }, [phase, selectedProjects]);

  // Confirmation — only active in confirming phase without --yes
  useInput((input, key) => {
    if (input === "y" || key.return) doPublish();
    else if (input === "n" || key.escape) { setError("Cancelled."); setPhase("error"); }
  }, { isActive: phase === "confirming" && !options.yes });

  async function doPublish() {
    setPhase("publishing");
    try {
      const payload = sanitizeForPublish(inventory!, publicFlags, options.bio);
      const result = await publishToApi(jwt, payload);
      await track("publish_complete", { projects: payload.inventory.projects.length });
      await flushTelemetry();
      setResultUrl(result.url);
      setPhase("done");
      if (!options.noOpen) { try { exec(`open ${result.url}`); } catch {} }
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
  if (phase === "using-cache") return <Text color="gray">Loading inventory...</Text>;
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

async function checkPublicRepos(projects: Project[]): Promise<Record<string, { isPublic: boolean; stars: number }>> {
  const flags: Record<string, { isPublic: boolean; stars: number }> = {};
  const toCheck = projects.filter((p) => p.remoteUrl?.includes("github.com"));
  for (let i = 0; i < toCheck.length; i += 10) {
    const batch = toCheck.slice(i, i + 10);
    const results = await Promise.all(batch.map(async (p) => {
      try {
        const match = p.remoteUrl!.match(/github\.com\/([^/]+\/[^/]+)/);
        if (!match) return { id: p.id, isPublic: false, stars: 0 };
        const res = await fetch(`https://api.github.com/repos/${match[1]}`, { redirect: "follow", headers: { "User-Agent": "agent-cv" } });
        if (res.status === 200) {
          const data = await res.json();
          return { id: p.id, isPublic: !data.private, stars: data.stargazers_count || 0 };
        }
        return { id: p.id, isPublic: false, stars: 0 };
      } catch { return { id: p.id, isPublic: false, stars: 0 }; }
    }));
    for (const r of results) flags[r.id] = { isPublic: r.isPublic, stars: r.stars };
  }
  for (const p of projects) { if (!(p.id in flags)) flags[p.id] = { isPublic: false, stars: 0 }; }
  return flags;
}

function sanitizeForPublish(
  inventory: Inventory,
  publicFlags: Record<string, { isPublic: boolean; stars: number }>,
  bioOverride?: string
) {
  const { profile, insights } = inventory;
  const projects = inventory.projects.filter((p) => p.included !== false).map((p: Project) => {
    const info = publicFlags[p.id];
    const isPublic = info?.isPublic ?? false;
    return {
      id: p.id, displayName: p.displayName, type: p.type, language: p.language,
      frameworks: p.frameworks, dateRange: p.dateRange, hasGit: p.hasGit,
      commitCount: p.commitCount, authorCommitCount: p.authorCommitCount,
      hasUncommittedChanges: p.hasUncommittedChanges,
      lastCommit: p.lastCommit,
      analysis: p.analysis,
      tags: p.tags, included: true,
      remoteUrl: isPublic ? p.remoteUrl : null,
      stars: info?.stars || undefined,
      isPublic,
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
    highlights: insights.highlights,
    narrative: insights.narrative,
    strongestSkills: insights.strongestSkills,
    uniqueTraits: insights.uniqueTraits,
  };
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
