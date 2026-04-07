import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { readInventory } from "../lib/inventory/store.ts";
import { track, flush as flushTelemetry } from "../lib/telemetry.ts";
import { Pipeline, type PipelineResult } from "../components/Pipeline.tsx";
import { PublishResult } from "../components/PublishResult.tsx";
import {
  readAuthToken,
  startDeviceFlow,
  pollForToken,
  publishToApi,
  writeAuthToken,
  PendingError,
  SlowDownError,
} from "../lib/auth.ts";
import type { Inventory, Project } from "../lib/types.ts";
import { sanitizeForPublish } from "../lib/publish.ts";
import { exec } from "node:child_process";

type Phase =
  | "checking-auth" | "auth" | "polling"
  | "pipeline" | "using-cache"
  | "checking-public" | "confirming" | "publishing" | "done" | "error";

type CacheStep = "loading" | "done";

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

  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [selectedProjects, setSelectedProjects] = useState<Project[]>([]);
  const [cacheStep, setCacheStep] = useState<CacheStep>("loading");

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
        setError("No projects found. Run `agent-cv generate ~/Projects` first.");
        setPhase("error");
        return;
      }
      const projects = inv.projects.filter((p) => !p.tags.includes("removed") && p.included !== false);

      if (!inv.insights?.bio && !inv.insights?._fingerprint) {
        setError("No insights generated yet. Run `agent-cv generate ~/Projects` first to analyze projects.");
        setPhase("error");
        return;
      }

      setCacheStep("done");
      setInventory(inv);
      setSelectedProjects(projects);
      setPhase("checking-public");
    }
    loadCache();
  }, [phase]);

  // Pipeline complete
  const handlePipelineComplete = useCallback(async (result: PipelineResult) => {
    setInventory(result.inventory);
    setSelectedProjects(result.projects);
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
      if (!options.noOpen) { setTimeout(() => { try { exec(`open "${result.url}"`); } catch {} }, 2000); }
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
    return <Text color="gray">Loading inventory...</Text>;
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

  return <PublishResult url={resultUrl} totalCount={totalCount} analyzedCount={analyzedCount} publicCount={publicCount} />;
}


function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
