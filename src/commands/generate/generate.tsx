import React, { useEffect } from "react";
import { Text, Box, useInput } from "ink";
import { useMachine } from "@xstate/react";
import { exec } from "node:child_process";
import { Pipeline, type PipelineResult } from "../../components/Pipeline.tsx";
import { PublishResult } from "../../components/PublishResult.tsx";
import { AuthGate } from "../../components/AuthGate.tsx";
import { generateFlowMachine, type GenerateFlowOptions } from "./generate.machine.ts";
import { useClearAuthOnSessionExpired } from "../../hooks/useClearAuthOnSessionExpired.ts";
import { useInkTerminalExit } from "../../hooks/useInkTerminalExit.ts";

interface Props {
  args: [string];
  options: GenerateFlowOptions;
}

export default function Generate({ args: [directory], options }: Props) {
  const { output, dryRun } = options;
  const [state, send] = useMachine(generateFlowMachine, {
    input: {
      directory: directory || undefined,
      options,
    },
  });

  const terminal = state.matches("published") || state.matches("done") || state.matches("failed");
  useInkTerminalExit(terminal, state.matches("failed"), state.context.error);
  useClearAuthOnSessionExpired(state.matches("failed"), state.context.error);

  useInput(
    (input, key) => {
      if (!state.matches("publishOffer")) return;
      if (input === "y" || input === "Y") send({ type: "OFFER_YES" });
      else if (input === "n" || input === "N" || key.return || key.escape) send({ type: "OFFER_NO" });
    },
    { isActive: state.matches("publishOffer") }
  );

  // After successful publish, open the profile URL (macOS `open`); failures are ignored.
  useEffect(() => {
    if (!state.matches("published")) return;
    const url = state.context.publishUrl;
    const timer = setTimeout(() => {
      try {
        exec(`open ${url}`);
      } catch {
        /* ignore */
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, [state]);

  if (state.matches("awaitingAuth")) {
    return (
      <AuthGate
        required={false}
        headline="Sign in with GitHub to enable cloud scanning and publishing:"
        onAuthenticated={(token) => send({ type: "AUTH_OK", token })}
        onSkipped={() => send({ type: "AUTH_SKIPPED" })}
      />
    );
  }

  if (state.matches("resolving")) {
    return <Text color="yellow">Resolving scan paths...</Text>;
  }

  if (state.matches("runningPipeline")) {
    return (
      <Pipeline
        options={{ directory: state.context.resolvedDir, ...options }}
        onComplete={(result: PipelineResult) => send({ type: "PIPELINE_DONE", result })}
        onError={(msg) => send({ type: "PIPELINE_ERROR", message: msg })}
      />
    );
  }

  if (state.matches("rendering")) {
    return <Text color="yellow">Generating CV...</Text>;
  }

  if (state.matches("publishing")) {
    return <Text color="yellow">Publishing to agent-cv.dev...</Text>;
  }

  if (state.matches("failed")) {
    return <Text color="red">Error: {state.context.error}</Text>;
  }

  if (state.matches("published")) {
    const result = state.context.result;
    const analyzed = result?.projects.filter((p) => p.analysis).length ?? 0;
    const total = result?.projects.length ?? 0;
    return (
      <Box flexDirection="column">
        <Text color="green" bold>
          CV generated! {total} projects, {analyzed} analyzed.
        </Text>
        {output && <Text dimColor>Written to: {output}</Text>}
        <PublishResult url={state.context.publishUrl} />
      </Box>
    );
  }

  if (state.matches("publishOffer")) {
    const result = state.context.result;
    const analyzed = result?.projects.filter((p) => p.analysis).length ?? 0;
    const total = result?.projects.length ?? 0;
    return (
      <Box flexDirection="column">
        <Text color="green" bold>
          CV generated! {total} projects, {analyzed} analyzed.
        </Text>
        {output && <Text dimColor>Written to: {output}</Text>}
        <Text> </Text>
        <Text>
          Publish to agent-cv.dev?{" "}
          <Text color="green" bold>
            (y)
          </Text>{" "}
          / <Text color="red">N</Text>
        </Text>
      </Box>
    );
  }

  if (state.matches("done")) {
    const result = state.context.result;
    const analyzed = result?.projects.filter((p) => p.analysis).length ?? 0;
    const total = result?.projects.length ?? 0;
    const markdown = state.context.markdown;
    const hasJwt = state.context.hasJwt;

    return (
      <Box flexDirection="column">
        <Text color="green" bold>
          CV generated! {total} projects, {analyzed} analyzed.
        </Text>
        {output ? (
          <Text dimColor>Written to: {output}</Text>
        ) : (
          <>
            <Text> </Text>
            <Text>{markdown}</Text>
          </>
        )}
        {!hasJwt && <Text dimColor>Share online: run `agent-cv publish`</Text>}
      </Box>
    );
  }

  return null;
}
