import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { exec } from "node:child_process";
import {
  readAuthToken,
  runDeviceFlowPoll,
  startDeviceFlow,
  type AuthToken,
} from "@agent-cv/core/src/auth/index.ts";
import { markNoticeSeen } from "@agent-cv/core/src/telemetry.ts";

export type AuthGateProps = {
  /** When false, device flow failure calls `onSkipped` instead of blocking with error. */
  required: boolean;
  onAuthenticated: (token: AuthToken) => void;
  /** Invoked when `required` is false and auth failed or was cancelled. */
  onSkipped?: () => void;
  /** Invoked when `required` is true and auth failed or was cancelled. */
  onError?: (message: string) => void;
  /** Optional heading above the device URL (default: Sign in to GitHub). */
  headline?: string;
};

type UiPhase = "checking" | "authenticating" | "failed";

/**
 * Shared GitHub device flow: check disk JWT, else device code + poll with Spinner.
 * Press **q** or **Ctrl+C** during polling to abort (required: error/skipped per props).
 */
export function AuthGate({
  required,
  onAuthenticated,
  onSkipped,
  onError,
  headline = "Sign in to GitHub",
}: AuthGateProps) {
  const [phase, setPhase] = useState<UiPhase>("checking");
  const [userCode, setUserCode] = useState("");
  const [verificationUri, setVerificationUri] = useState("");
  const [error, setError] = useState("");
  const [showTelemetryNotice, setShowTelemetryNotice] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const settledRef = useRef(false);

  function settleError(message: string) {
    if (settledRef.current) return;
    settledRef.current = true;
    setError(message);
    setPhase("failed");
    if (required) {
      onError?.(message);
    } else {
      onSkipped?.();
    }
  }

  function settleSkipped() {
    if (settledRef.current) return;
    settledRef.current = true;
    onSkipped?.();
  }

  function settleSuccess(token: AuthToken) {
    if (settledRef.current) return;
    settledRef.current = true;
    onAuthenticated(token);
  }

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const existing = await readAuthToken();
        if (cancelled) return;
        if (existing?.jwt) {
          settleSuccess(existing);
          return;
        }

        const flow = await startDeviceFlow();
        if (cancelled) return;
        setUserCode(flow.userCode);
        setVerificationUri(flow.verificationUri);
        const alreadySeen = await markNoticeSeen();
        if (cancelled) return;
        setShowTelemetryNotice(!alreadySeen);
        setPhase("authenticating");
        try {
          exec(`open ${flow.verificationUri}`);
        } catch {
          /* manual open via printed URL */
        }
        abortRef.current = new AbortController();
        const token = await runDeviceFlowPoll(flow.deviceCode, flow.interval, {
          signal: abortRef.current.signal,
        });
        if (cancelled) return;
        settleSuccess(token);
      } catch (e: unknown) {
        if (cancelled) return;
        const err = e instanceof Error ? e : new Error(String(e));
        if (err.name === "AbortError") {
          if (required) {
            settleError("Cancelled.");
          } else {
            settleSkipped();
          }
          return;
        }
        if (required) {
          settleError(err.message);
        } else {
          settleSkipped();
        }
      }
    }

    run();

    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, []);

  useInput(
    (input) => {
      if (input === "q" && phase === "authenticating") {
        abortRef.current?.abort();
      }
    },
    { isActive: phase === "authenticating" }
  );

  useEffect(() => {
    const onSigint = () => {
      abortRef.current?.abort();
    };
    process.on("SIGINT", onSigint);
    return () => {
      process.off("SIGINT", onSigint);
    };
  }, []);

  if (phase === "checking") {
    return (
      <Text color="gray">Checking authentication...</Text>
    );
  }

  if (phase === "failed" && error) {
    return <Text color="red">Error: {error}</Text>;
  }

  if (phase === "authenticating") {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{headline}</Text>
        {showTelemetryNotice && (
          <Text dimColor>
            Anonymous telemetry enabled. Disable: agent-cv config or AGENT_CV_TELEMETRY=off
          </Text>
        )}
        <Text>
          Code:{" "}
          <Text bold color="yellow">
            {userCode}
          </Text>
        </Text>
        <Text color="gray">We opened the browser. If it did not, open:</Text>
        <Text color="cyan">{verificationUri}</Text>
        <Box>
          <Text color="gray">
            <Text color="green">
              <Spinner type="dots" />
            </Text>{" "}
            Waiting for authorization…
          </Text>
          <Text dimColor> (press q to cancel)</Text>
        </Box>
      </Box>
    );
  }

  return null;
}
