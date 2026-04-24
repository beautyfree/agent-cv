import React from "react";
import { Text } from "ink";
import { useMachine } from "@xstate/react";
import { AuthGate } from "../../components/AuthGate.tsx";
import { loginFlowMachine } from "./login.machine.ts";
import { useInkTerminalExit } from "../../hooks/useInkTerminalExit.ts";

export default function Login() {
  const [state, send] = useMachine(loginFlowMachine, { input: {} });
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

  if (state.matches("failed")) {
    return <Text color="red">Error: {state.context.error}</Text>;
  }

  if (state.matches("done")) {
    return (
      <Text color="green" bold>
        Logged in.
      </Text>
    );
  }

  return null;
}
