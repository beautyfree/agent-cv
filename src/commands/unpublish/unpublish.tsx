import React from "react";
import { Text } from "ink";
import { useMachine } from "@xstate/react";
import { AuthGate } from "../../components/AuthGate.tsx";
import { unpublishFlowMachine } from "./unpublish.machine.ts";
import { useInkTerminalExit } from "../../hooks/useInkTerminalExit.ts";

export default function Unpublish() {
  const [state, send] = useMachine(unpublishFlowMachine, { input: {} });
  const terminal = state.matches("done") || state.matches("failed");
  useInkTerminalExit(terminal, state.matches("failed"), state.context.error);

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

  if (state.matches("deleting")) {
    return <Text color="gray">Removing portfolio...</Text>;
  }

  if (state.matches("failed")) {
    return <Text color="red">Error: {state.context.error}</Text>;
  }

  if (state.matches("done")) {
    return <Text color="green">Portfolio removed from agent-cv.dev.</Text>;
  }

  return null;
}
