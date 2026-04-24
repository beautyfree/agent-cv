import React, { useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { useMachine } from "@xstate/react";
import { exec } from "node:child_process";
import { track, flush as flushTelemetry } from "@agent-cv/core/src/telemetry.ts";
import { sanitizeForPublish } from "@agent-cv/core/src/publish.ts";
import { Pipeline, type PipelineResult } from "../../components/Pipeline.tsx";
import { PublishResult } from "../../components/PublishResult.tsx";
import { AuthGate } from "../../components/AuthGate.tsx";
import { publishFlowMachine, type PublishFlowOptions } from "./publish.machine.ts";
import { useClearAuthOnSessionExpired } from "../../hooks/useClearAuthOnSessionExpired.ts";
import { useInkTerminalExit } from "../../hooks/useInkTerminalExit.ts";

interface Props {
  args?: string[];
  options: PublishFlowOptions;
}

export default function Publish({ args, options }: Props) {
  const dir = args?.[0];
  const [state, send] = useMachine(publishFlowMachine, {
    input: { directory: dir, options },
  });

  const terminal = state.matches("done") || state.matches("failed");
  useInkTerminalExit(terminal, state.matches("failed"), state.context.error);
  useClearAuthOnSessionExpired(state.matches("failed"), state.context.error);

  useInput(
    (input, key) => {
      if (input === "y" || key.return) send({ type: "CONFIRM" });
      else if (input === "n" || key.escape) send({ type: "CANCEL" });
    },
    { isActive: state.matches("confirming") && !options.yes }
  );

  // Side effects after terminal UI state (order matters for perceived behavior):
  // 1) telemetry on success — 2) optional `open` URL after delay
  useEffect(() => {
    if (!state.matches("done")) return;
    const inv = state.context.inventory;
    if (!inv) return;
    void (async () => {
      const payload = sanitizeForPublish(inv);
      await track("publish_complete", { projects: payload.inventory.projects.length });
      await flushTelemetry();
    })();
  }, [state]);

  useEffect(() => {
    if (!state.matches("done")) return;
    const url = state.context.resultUrl;
    const timer = setTimeout(() => {
      try {
        exec(`open ${url}`);
      } catch {
        console.error(`Open manually: ${url}`);
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, [state]);

  if (state.matches("awaitingAuth")) {
    return (
      <AuthGate
        required
        headline="Sign in to GitHub"
        onAuthenticated={(token) => send({ type: "AUTH_OK", token })}
        onError={(message) => send({ type: "AUTH_FAIL", message })}
      />
    );
  }

  if (state.matches("resolving")) {
    return <Text color="yellow">Resolving scan path...</Text>;
  }

  if (state.matches("runningPipeline")) {
    return (
      <Pipeline
        options={{
          directory: state.context.resolvedDir,
          all: options.all,
          email: options.email,
          agent: options.agent,
          interactive: options.interactive,
          fresh: options.fresh,
        }}
        onComplete={(result: PipelineResult) => send({ type: "PIPELINE_DONE", result })}
        onError={(msg) => send({ type: "PIPELINE_ERROR", message: msg })}
      />
    );
  }

  if (state.matches("loadingCache")) {
    return <Text color="gray">Loading inventory...</Text>;
  }

  if (state.matches("checkingPublic")) {
    return <Text color="gray">Checking repos...</Text>;
  }

  if (state.matches("confirming")) {
    const inventory = state.context.inventory;
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Ready to publish your profile:</Text>
        {!dir && !options.fresh && inventory?.lastScan && (
          <Text color="gray">
            {" "}
            Using inventory from {new Date(inventory.lastScan).toLocaleDateString()}. To rescan: `agent-cv publish{" "}
            {inventory.scanPaths?.[0] || "~/Projects"}`
          </Text>
        )}
        <Text color="gray"> {state.context.totalCount} projects will appear on your page</Text>
        <Text color="gray"> {state.context.publicCount} with GitHub links (public repos only)</Text>
        <Text color="gray"> {state.context.totalCount - state.context.publicCount} private (URLs hidden)</Text>
        <Text color="gray"> Local paths, secrets, emails are stripped</Text>
        <Text> </Text>
        <Text>
          Publish to agent-cv.dev?{" "}
          <Text color="green" bold>
            (y)
          </Text>{" "}
          / <Text color="red">n</Text>
        </Text>
      </Box>
    );
  }

  if (state.matches("publishing")) {
    return <Text color="gray">Publishing to agent-cv.dev...</Text>;
  }

  if (state.matches("failed")) {
    return <Text color="red">Error: {state.context.error}</Text>;
  }

  if (state.matches("done")) {
    return (
      <PublishResult
        url={state.context.resultUrl}
        totalCount={state.context.totalCount}
        analyzedCount={state.context.analyzedCount}
        publicCount={state.context.publicCount}
      />
    );
  }

  return null;
}
