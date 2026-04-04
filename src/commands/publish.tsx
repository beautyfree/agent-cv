import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { readInventory } from "../lib/inventory/store.ts";
import {
  readAuthToken,
  startDeviceFlow,
  pollForToken,
  publishToApi,
  PendingError,
  SlowDownError,
} from "../lib/auth.ts";
import type { Inventory, Project } from "../lib/types.ts";

type Phase = "checking" | "auth" | "polling" | "reading" | "publishing" | "done" | "error";

interface Props {
  options: { bio?: string };
}

export default function Publish({ options }: Props) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [userCode, setUserCode] = useState("");
  const [verificationUri, setVerificationUri] = useState("");
  const [resultUrl, setResultUrl] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    run();
  }, []);

  async function run() {
    try {
      // 1. Check for existing token
      setPhase("checking");
      let auth = await readAuthToken();

      // 2. Auth if needed
      if (!auth) {
        setPhase("auth");
        const flow = await startDeviceFlow();
        setUserCode(flow.userCode);
        setVerificationUri(flow.verificationUri);

        // Open browser
        try {
          const { exec } = await import("node:child_process");
          exec(`open ${flow.verificationUri}`);
        } catch { /* ignore */ }

        // 3. Poll for token
        setPhase("polling");
        let interval = flow.interval;
        while (true) {
          await sleep(interval * 1000);
          try {
            auth = await pollForToken(flow.deviceCode);
            break;
          } catch (e) {
            if (e instanceof PendingError) continue;
            if (e instanceof SlowDownError) { interval += 2; continue; }
            throw e;
          }
        }
      }

      // 4. Read inventory
      setPhase("reading");
      const inventory = await readInventory();

      if (inventory.projects.length === 0) {
        setError("No projects found. Run `agent-cv scan ~/Projects` first.");
        setPhase("error");
        return;
      }

      // 5. Sanitize and publish
      setPhase("publishing");
      const payload = sanitizeForPublish(inventory, options.bio);

      try {
        const result = await publishToApi(auth!.jwt, payload);
        setResultUrl(result.url);
        setPhase("done");
      } catch (e: any) {
        if (e.message === "AUTH_EXPIRED") {
          // Clear token and retry
          const { writeAuthToken } = await import("../lib/auth.ts");
          await writeAuthToken({ jwt: "", username: "", obtainedAt: "" });
          setError("Session expired. Run `agent-cv publish` again to re-authenticate.");
          setPhase("error");
        } else {
          throw e;
        }
      }
    } catch (e: any) {
      setError(e.message || "Unknown error");
      setPhase("error");
    }
  }

  return (
    <Box flexDirection="column" padding={1}>
      {phase === "checking" && (
        <Text color="gray">Checking authentication...</Text>
      )}

      {phase === "auth" && (
        <Box flexDirection="column" gap={1}>
          <Text>Open this URL in your browser:</Text>
          <Text bold color="cyan">{verificationUri}</Text>
          <Text>Enter code: <Text bold color="yellow">{userCode}</Text></Text>
        </Box>
      )}

      {phase === "polling" && (
        <Box flexDirection="column" gap={1}>
          <Text color="gray">Waiting for authorization...</Text>
          <Text>Enter code: <Text bold color="yellow">{userCode}</Text></Text>
          <Text color="gray">at {verificationUri}</Text>
        </Box>
      )}

      {phase === "reading" && (
        <Text color="gray">Reading inventory...</Text>
      )}

      {phase === "publishing" && (
        <Text color="gray">Publishing to agent-cv.dev...</Text>
      )}

      {phase === "done" && (
        <Box flexDirection="column" gap={1}>
          <Text> </Text>
          <Box borderStyle="round" borderColor="green" paddingX={2} paddingY={1} flexDirection="column" alignItems="center">
            <Text bold>Your portfolio is live at</Text>
            <Text bold color="cyan">{resultUrl}</Text>
          </Box>
          <Text> </Text>
        </Box>
      )}

      {phase === "error" && (
        <Text color="red">Error: {error}</Text>
      )}
    </Box>
  );
}

function sanitizeForPublish(inventory: Inventory, bio?: string) {
  const projects = inventory.projects
    .filter((p) => p.included !== false)
    .map((p: Project) => ({
      id: p.id,
      displayName: p.displayName,
      type: p.type,
      language: p.language,
      frameworks: p.frameworks,
      dateRange: p.dateRange,
      hasGit: p.hasGit,
      commitCount: p.commitCount,
      authorCommitCount: p.authorCommitCount,
      hasUncommittedChanges: p.hasUncommittedChanges,
      lastCommit: p.lastCommit,
      analysis: p.analysis,
      tags: p.tags,
      included: true,
      // Only include remoteUrl for repos under known public paths
      remoteUrl: null, // TODO: extract from git remote and check isPublic
      isPublic: undefined,
    }));

  return {
    inventory: { version: inventory.version, projects },
    bio,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
