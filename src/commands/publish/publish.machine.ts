import { assign, fromPromise, setup } from "xstate";
import { readInventory } from "@agent-cv/core/src/inventory/store.ts";
import { type AuthToken } from "@agent-cv/core/src/auth/index.ts";
import { publishViaSync } from "@agent-cv/core/src/sync/publish.ts";
import type { Inventory, Project } from "@agent-cv/core/src/types.ts";
import type { PipelineResult } from "../../components/Pipeline.tsx";

export type PublishFlowOptions = {
  all?: boolean;
  agent?: string;
  email?: string;
  interactive?: boolean;
  /** Scan without merging into saved project list; use with a directory (or previous scan paths). */
  fresh?: boolean;
  yes?: boolean;
};

export type PublishFlowInput = {
  directory?: string;
  options: PublishFlowOptions;
};

type Ctx = {
  error: string;
  jwt: string;
  directory?: string;
  resolvedDir: string;
  options: PublishFlowOptions;
  inventory: Inventory | null;
  selectedProjects: Project[];
  totalCount: number;
  publicCount: number;
  analyzedCount: number;
  resultUrl: string;
};

const resolvePathActor = fromPromise(async () => {
  let inv;
  try {
    inv = await readInventory();
  } catch {
    throw new Error(
      "No directory specified.\nUsage: agent-cv publish <directory>\n   or: agent-cv publish --fresh <directory>"
    );
  }
  const paths = inv.scanPaths?.filter(Boolean) || [];
  if (paths.length === 0) {
    throw new Error(
      "No directory specified and no previous scan paths found.\nUsage: agent-cv publish <directory>\n   or: agent-cv publish --fresh <directory>"
    );
  }
  const pick = paths.length === 1 ? paths[0]! : paths[paths.length - 1]!;
  return { directory: pick };
});

const loadCacheActor = fromPromise(async () => {
  const inv = await readInventory();
  if (inv.projects.length === 0) {
    throw new Error("No projects found. Run `agent-cv generate ~/Projects` first.");
  }
  if (!inv.insights?.bio && !inv.insights?._fingerprint) {
    throw new Error("No insights generated yet. Run `agent-cv generate ~/Projects` first to analyze projects.");
  }
  const projects = inv.projects.filter((p) => !p.tags.includes("removed") && p.included !== false);
  return { inventory: inv, projects };
});

const publishActor = fromPromise(async ({ input }: { input: { jwt: string; inventory: Inventory } }) => {
  // JWT is read from disk by the sync client (readAuthToken).
  // `input.jwt` is retained in context for legacy compat but not used here.
  void input.jwt;
  return publishViaSync(input.inventory);
});

export const publishFlowMachine = setup({
  types: {
    context: {} as Ctx,
    events: {} as
      | { type: "AUTH_OK"; token: AuthToken }
      | { type: "AUTH_FAIL"; message: string }
      | { type: "PIPELINE_DONE"; result: PipelineResult }
      | { type: "PIPELINE_ERROR"; message: string }
      | { type: "CONFIRM" }
      | { type: "CANCEL" },
    input: {} as PublishFlowInput,
  },
  actors: {
    resolvePath: resolvePathActor,
    loadCache: loadCacheActor,
    publishToApi: publishActor,
  },
  guards: {
    hasDirectory: ({ context }) => Boolean(context.directory?.length),
    wantsFreshNoDir: ({ context }) => Boolean(context.options.fresh) && !context.directory?.length,
    skipConfirm: ({ context }) => Boolean(context.options.yes),
  },
}).createMachine({
  id: "publishFlow",
  context: ({ input }) => ({
    error: "",
    jwt: "",
    directory: input.directory,
    resolvedDir: input.directory || "",
    options: input.options,
    inventory: null,
    selectedProjects: [],
    totalCount: 0,
    publicCount: 0,
    analyzedCount: 0,
    resultUrl: "",
  }),
  initial: "awaitingAuth",
  states: {
    awaitingAuth: {
      on: {
        AUTH_OK: {
          target: "routeAfterAuth",
          actions: assign({ jwt: ({ event }) => event.token.jwt, error: () => "" }),
        },
        AUTH_FAIL: { target: "failed", actions: assign({ error: ({ event }) => event.message }) },
      },
    },
    routeAfterAuth: {
      always: [
        {
          guard: "hasDirectory",
          target: "runningPipeline",
          actions: assign({ resolvedDir: ({ context }) => context.directory! }),
        },
        { guard: "wantsFreshNoDir", target: "resolving" },
        { target: "loadingCache" },
      ],
    },
    resolving: {
      invoke: {
        src: "resolvePath",
        onDone: {
          target: "runningPipeline",
          actions: assign({
            resolvedDir: ({ event }) => (event.output as { directory: string }).directory,
          }),
        },
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
    runningPipeline: {
      on: {
        PIPELINE_DONE: {
          target: "checkingPublic",
          actions: assign({
            inventory: ({ event }) => event.result.inventory,
            selectedProjects: ({ event }) => event.result.projects,
            error: () => "",
          }),
        },
        PIPELINE_ERROR: {
          target: "failed",
          actions: assign({ error: ({ event }) => event.message }),
        },
      },
    },
    loadingCache: {
      invoke: {
        src: "loadCache",
        onDone: {
          target: "checkingPublic",
          actions: assign({
            inventory: ({ event }) => event.output.inventory,
            selectedProjects: ({ event }) => event.output.projects,
            error: () => "",
          }),
        },
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
    checkingPublic: {
      entry: assign({
        totalCount: ({ context }) => context.selectedProjects.length,
        publicCount: ({ context }) => context.selectedProjects.filter((p) => p.isPublic).length,
        analyzedCount: ({ context }) => context.selectedProjects.filter((p) => p.analysis).length,
      }),
      always: [{ guard: "skipConfirm", target: "publishing" }, { target: "confirming" }],
    },
    confirming: {
      on: {
        CONFIRM: { target: "publishing" },
        CANCEL: { target: "failed", actions: assign({ error: () => "Cancelled." }) },
      },
    },
    publishing: {
      invoke: {
        src: "publishToApi",
        input: ({ context }) => ({
          jwt: context.jwt,
          inventory: context.inventory!,
        }),
        onDone: {
          target: "done",
          actions: assign({
            resultUrl: ({ event }) => {
              const out = event.output as { url: string };
              return out.url.replace(/\n/g, "").trim();
            },
          }),
        },
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => {
              const err = (event as unknown as { error?: unknown }).error;
              const msg = err instanceof Error ? err.message : String(err);
              if (msg === "AUTH_EXPIRED") {
                return "Session expired. Run `agent-cv publish` again.";
              }
              return msg;
            },
          }),
        },
      },
    },
    done: { type: "final" },
    failed: { type: "final" },
  },
});
