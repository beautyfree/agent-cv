import { assign, fromPromise, setup } from "xstate";
import { type AuthToken } from "@agent-cv/core/src/auth/index.ts";
import { unpublishViaSync } from "@agent-cv/core/src/sync/publish.ts";

const deletePortfolio = fromPromise(async ({ input }: { input: { jwt: string } }) => {
  void input.jwt;
  await unpublishViaSync();
});

export const unpublishFlowMachine = setup({
  types: {
    context: {} as { error: string; jwt: string },
    events: {} as
      | { type: "AUTH_OK"; token: AuthToken }
      | { type: "AUTH_FAIL"; message: string },
    input: {} as Record<string, never>,
  },
  actors: {
    deletePortfolio,
  },
}).createMachine({
  id: "unpublishFlow",
  context: { error: "", jwt: "" },
  initial: "awaitingAuth",
  states: {
    awaitingAuth: {
      on: {
        AUTH_OK: {
          target: "deleting",
          actions: assign({
            jwt: ({ event }) => event.token.jwt,
            error: () => "",
          }),
        },
        AUTH_FAIL: {
          target: "failed",
          actions: assign({ error: ({ event }) => event.message }),
        },
      },
    },
    deleting: {
      invoke: {
        src: "deletePortfolio",
        input: ({ context }) => ({ jwt: context.jwt }),
        onDone: { target: "done" },
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => {
              const err = (event as unknown as { error?: unknown }).error;
              return err instanceof Error ? err.message : String(err);
            },
          }),
        },
      },
    },
    done: { type: "final" },
    failed: { type: "final" },
  },
});
