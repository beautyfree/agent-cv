import React, { useState, useCallback, useEffect } from "react";
import { Text, Box, useInput, useApp } from "ink";
import { MarkdownRenderer } from "../lib/output/markdown-renderer.ts";
import { Pipeline, type PipelineResult } from "../components/Pipeline.tsx";
import { readInventory } from "../lib/inventory/store.ts";
import { readAuthToken, startDeviceFlow, pollForToken, publishToApi, PendingError, SlowDownError } from "../lib/auth.ts";
import { sanitizeForPublish } from "../lib/publish.ts";
import { exec } from "node:child_process";

interface Props {
  args: [string];
  options: {
    output?: string;
    agent?: string;
    noCache?: boolean;
    dryRun?: boolean;
    all?: boolean;
    email?: string;
    github?: string;
    includeForks?: boolean;
    interactive?: boolean;
    yes?: boolean;
  };
}

export default function Generate({ args: [directory], options }: Props) {
  const { exit } = useApp();
  const { output, dryRun, yes: autoPublish } = options;
  const [phase, setPhase] = useState<"checking-auth" | "auth" | "auth-polling" | "resolving" | "pipeline" | "rendering" | "done" | "publish-offer" | "publishing" | "published" | "error">("checking-auth");
  const [resolvedDir, setResolvedDir] = useState(directory);
  const [markdown, setMarkdown] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [publishUrl, setPublishUrl] = useState("");
  const [hasJwt, setHasJwt] = useState(false);
  const [userCode, setUserCode] = useState("");
  const [verificationUri, setVerificationUri] = useState("");

  // Phase 0: Check auth — if not logged in, run Device Flow (gets both JWT + GitHub token)
  useEffect(() => {
    if (phase !== "checking-auth") return;
    async function checkAuth() {
      try {
        const auth = await readAuthToken();
        if (auth?.jwt) {
          setHasJwt(true);
          setPhase(directory ? "pipeline" : "resolving");
          return;
        }
        // Start Device Flow
        const flow = await startDeviceFlow();
        setUserCode(flow.userCode);
        setVerificationUri(flow.verificationUri);
        try { (await import("node:child_process")).exec(`open ${flow.verificationUri}`); } catch {}
        setPhase("auth");

        // Poll for token
        let interval = flow.interval;
        while (true) {
          await new Promise((r) => setTimeout(r, interval * 1000));
          try {
            await pollForToken(flow.deviceCode);
            setHasJwt(true);
            setPhase(directory ? "pipeline" : "resolving");
            return;
          } catch (e) {
            if (e instanceof PendingError) continue;
            if (e instanceof SlowDownError) { interval += 2; continue; }
            throw e;
          }
        }
      } catch (e: any) {
        // Auth failed — continue without auth (no GitHub scanning, no publish)
        setPhase(directory ? "pipeline" : "resolving");
      }
    }
    checkAuth();
  }, [phase]);

  // Resolve directory from inventory scanPaths when not provided
  useEffect(() => {
    if (phase !== "resolving") return;
    async function resolve() {
      try {
        const inv = await readInventory();
        const paths = inv.scanPaths?.filter(Boolean) || [];
        if (paths.length === 0) {
          setError("No directory specified and no previous scan paths found.\nUsage: agent-cv generate <directory>");
          setPhase("error");
          return;
        }
        if (paths.length === 1) {
          setResolvedDir(paths[0]!);
          setPhase("pipeline");
          return;
        }
        // Multiple paths — use most recently added path
        setResolvedDir(paths[paths.length - 1]!);
        setPhase("pipeline");
      } catch {
        setError("No directory specified.\nUsage: agent-cv generate <directory>");
        setPhase("error");
      }
    }
    resolve();
  }, [phase]);

  const handleComplete = useCallback(async ({ projects, inventory, adapter }: PipelineResult) => {
    try {
      setPhase("rendering");
      const renderer = new MarkdownRenderer();
      const md = renderer.render(inventory, projects.map((p) => p.id));
      setMarkdown(md);
      if (output && !dryRun) await Bun.write(output, md);
      setResult({ projects, inventory, adapter });

      // Check if we can offer publish
      const auth = await readAuthToken();
      if (auth?.jwt) {
        setHasJwt(true);
        if (autoPublish) {
          // Auto-publish with --yes
          setPhase("publishing");
          try {
            const payload = sanitizeForPublish(inventory);
            const pubResult = await publishToApi(auth.jwt, payload);
            setPublishUrl(pubResult.url);
            setPhase("published");
            setTimeout(() => { try { exec(`open ${pubResult.url}`); } catch {} }, 2000);
          } catch (err: any) {
            if (err.message === "AUTH_EXPIRED") {
              setError("Session expired. Run `agent-cv publish` to re-authenticate.");
            } else {
              setError(`Publish failed: ${err.message}`);
            }
            setPhase("error");
          }
          return;
        }
        setPhase("publish-offer");
      } else {
        setPhase("done");
      }
    } catch (err: any) { setError(err.message); setPhase("error"); }
  }, [output, dryRun, autoPublish]);

  // Publish offer input
  useInput((input, key) => {
    if (phase !== "publish-offer") return;
    if (input === "y" || input === "Y") {
      doPublish();
    } else if (input === "n" || input === "N" || key.return || key.escape) {
      setPhase("done");
    }
  }, { isActive: phase === "publish-offer" });

  async function doPublish() {
    if (!result) return;
    setPhase("publishing");
    try {
      const auth = await readAuthToken();
      if (!auth?.jwt) { setPhase("done"); return; }
      const payload = sanitizeForPublish(result.inventory);
      const pubResult = await publishToApi(auth.jwt, payload);
      setPublishUrl(pubResult.url);
      setPhase("published");
      setTimeout(() => { try { exec(`open ${pubResult.url}`); } catch {} }, 2000);
    } catch (err: any) {
      if (err.message === "AUTH_EXPIRED") {
        setError("Session expired. Run `agent-cv publish` to re-authenticate.");
      } else {
        setError(`Publish failed: ${err.message}`);
      }
      setPhase("error");
    }
  }

  // Exit on terminal states
  useEffect(() => {
    if (phase === "published" || (phase === "done" && !hasJwt)) {
      const timer = setTimeout(() => exit(), 100);
      return () => clearTimeout(timer);
    }
  }, [phase, hasJwt, exit]);

  if (phase === "error") return <Text color="red">Error: {error}</Text>;
  if (phase === "checking-auth") return <Text dimColor>Checking authentication...</Text>;
  if (phase === "auth") return (
    <Box flexDirection="column" gap={1}>
      <Text>Sign in with GitHub to enable cloud scanning and publishing:</Text>
      <Text bold color="cyan">{verificationUri}</Text>
      <Text>Enter code: <Text bold color="yellow">{userCode}</Text></Text>
      <Text dimColor>Waiting for authorization...</Text>
    </Box>
  );
  if (phase === "resolving") return <Text color="yellow">Resolving scan paths...</Text>;

  if (phase === "pipeline") return (
    <Pipeline
      options={{ directory: resolvedDir, ...options }}
      onComplete={handleComplete}
      onError={(msg) => { setError(msg); setPhase("error"); }}
    />
  );

  if (phase === "rendering") return <Text color="yellow">Generating CV...</Text>;
  if (phase === "publishing") return <Text color="yellow">Publishing to agent-cv.dev...</Text>;

  if (phase === "published") {
    const analyzed = result?.projects.filter((p) => p.analysis).length ?? 0;
    const total = result?.projects.length ?? 0;
    return (
      <Box flexDirection="column">
        <Text color="green" bold>CV generated! {total} projects, {analyzed} analyzed.</Text>
        {output && <Text dimColor>Written to: {output}</Text>}
        <Text> </Text>
        <Box borderStyle="round" borderColor="green" paddingX={2} paddingY={1} flexDirection="column" alignItems="center">
          <Text bold>Published to</Text>
          <Text bold color="cyan">{publishUrl}</Text>
        </Box>
      </Box>
    );
  }

  if (phase === "publish-offer") {
    const analyzed = result?.projects.filter((p) => p.analysis).length ?? 0;
    const total = result?.projects.length ?? 0;
    return (
      <Box flexDirection="column">
        <Text color="green" bold>CV generated! {total} projects, {analyzed} analyzed.</Text>
        {output && <Text dimColor>Written to: {output}</Text>}
        <Text> </Text>
        <Text>Publish to agent-cv.dev? <Text color="green" bold>(y)</Text> / <Text color="red">N</Text></Text>
      </Box>
    );
  }

  // Done (no JWT or declined publish)
  const analyzed = result?.projects.filter((p) => p.analysis).length ?? 0;
  const total = result?.projects.length ?? 0;

  return (
    <Box flexDirection="column">
      <Text color="green" bold>CV generated! {total} projects, {analyzed} analyzed.</Text>
      {output ? <Text dimColor>Written to: {output}</Text> : <><Text> </Text><Text>{markdown}</Text></>}
      {!hasJwt && <Text dimColor>Share online: run `agent-cv publish`</Text>}
    </Box>
  );
}
