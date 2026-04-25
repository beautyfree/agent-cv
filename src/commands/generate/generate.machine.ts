import { assign, fromPromise, setup } from "xstate";
import { readInventory } from "@agent-cv/core/src/inventory/store.ts";
import { readAuthToken, type AuthToken } from "@agent-cv/core/src/auth/index.ts";
import { MarkdownRenderer } from "@agent-cv/core/src/output/markdown-renderer.ts";
import { publishViaSync } from "@agent-cv/core/src/sync/publish.ts";
import type { Inventory, Project } from "@agent-cv/core/src/types.ts";
import type { AgentAdapter } from "@agent-cv/core/src/types.ts";
import type { PipelineResult } from "../../components/Pipeline.tsx";

export type GenerateFlowOptions = {
  output?: string;
  agent?: string;
  noCache?: boolean;
  dryRun?: boolean;
  all?: boolean;
  email?: string;
  github?: string;
  includeForks?: boolean;
  interactive?: boolean;
  fresh?: boolean;
  yes?: boolean;
};

export type GenerateFlowInput = {
  directory: string | undefined;
  options: GenerateFlowOptions;
};

type GenCtx = {
  error: string;
  directory?: string;
  resolvedDir: string;
  options: GenerateFlowOptions;
  hasJwt: boolean;
  markdown: string;
  result: PipelineResult | null;
  publishUrl: string;
  inventory: Inventory | null;
  projects: Project[];
  adapter: AgentAdapter | null;
};

const resolvePathActor = fromPromise(async () => {
  let inv;
  try {
    inv = await readInventory();
  } catch {
    throw new Error("No directory specified.\nUsage: agent-cv generate <directory>");
  }
  const paths = inv.scanPaths?.filter(Boolean) || [];
  if (paths.length === 0) {
    throw new Error("No directory specified and no previous scan paths found.\nUsage: agent-cv generate <directory>");
  }
  const pick = paths.length === 1 ? paths[0]! : paths[paths.length - 1]!;
  return { directory: pick };
});

const renderActor = fromPromise(
  async ({
    input,
  }: {
    input: {
      inventory: Inventory;
      projectIds: string[];
      output?: string;
      dryRun?: boolean;
    };
  }) => {
    const renderer = new MarkdownRenderer();
    const md = renderer.render(input.inventory, input.projectIds);
    if (input.output && !input.dryRun) {
      await Bun.write(input.output, md);
    }
    return { markdown: md };
  }
);

const publishActor = fromPromise(async ({ input }: { input: { inventory: Inventory } }) => {
  const auth = await readAuthToken();
  if (!auth?.jwt) throw new Error("Not authenticated");
  return publishViaSync(input.inventory);
});

export const generateFlowMachine = setup({
  types: {
    context: {} as GenCtx,
    events: {} as
      | { type: "AUTH_OK"; token: AuthToken }
      | { type: "AUTH_SKIPPED" }
      | { type: "PIPELINE_DONE"; result: PipelineResult }
      | { type: "PIPELINE_ERROR"; message: string }
      | { type: "OFFER_YES" }
      | { type: "OFFER_NO" },
    input: {} as GenerateFlowInput,
  },
  actors: {
    resolvePath: resolvePathActor,
    renderMarkdown: renderActor,
    publishInventory: publishActor,
  },
  guards: {
    hasDirectory: ({ context }) => Boolean(context.directory?.length),
    canAutoPublish: ({ context }) => Boolean(context.options.yes && context.hasJwt),
    canOfferPublish: ({ context }) => Boolean(context.hasJwt && !context.options.yes),
  },
}).createMachine({
  id: "generateFlow",
  context: ({ input }) => ({
    error: "",
    directory: input.directory,
    resolvedDir: input.directory || "",
    options: input.options,
    hasJwt: false,
    markdown: "",
    result: null,
    publishUrl: "",
    inventory: null,
    projects: [],
    adapter: null,
  }),
  initial: "awaitingAuth",
  states: {
    awaitingAuth: {
      on: {
        AUTH_OK: {
          target: "routeAfterAuth",
          actions: assign({ hasJwt: () => true }),
        },
        AUTH_SKIPPED: {
          target: "routeAfterAuth",
          actions: assign({ hasJwt: () => false }),
        },
      },
    },
    routeAfterAuth: {
      always: [
        {
          guard: "hasDirectory",
          target: "runningPipeline",
          actions: assign({ resolvedDir: ({ context }) => context.directory! }),
        },
        { target: "resolving" },
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
          target: "rendering",
          actions: assign({ result: ({ event }) => event.result, error: () => "" }),
        },
        PIPELINE_ERROR: { target: "failed", actions: assign({ error: ({ event }) => event.message }) },
      },
    },
    rendering: {
      invoke: {
        src: "renderMarkdown",
        input: ({ context }) => ({
          inventory: context.result!.inventory,
          projectIds: context.result!.projects.map((p) => p.id),
          output: context.options.output,
          dryRun: context.options.dryRun,
        }),
        onDone: {
          target: "afterRender",
          actions: assign({
            markdown: ({ event }) => (event.output as { markdown: string }).markdown,
            inventory: ({ context }) => context.result!.inventory,
            projects: ({ context }) => context.result!.projects,
            adapter: ({ context }) => context.result!.adapter,
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
    afterRender: {
      always: [
        { guard: "canAutoPublish", target: "publishing" },
        { guard: "canOfferPublish", target: "publishOffer" },
        { target: "done" },
      ],
    },
    publishOffer: {
      on: {
        OFFER_YES: { target: "publishing" },
        OFFER_NO: { target: "done" },
      },
    },
    publishing: {
      invoke: {
        src: "publishInventory",
        input: ({ context }) => ({ inventory: context.result!.inventory }),
        onDone: {
          target: "published",
          actions: assign({
            publishUrl: ({ event }) => {
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
                return "Session expired. Run `agent-cv publish` to re-authenticate.";
              }
              return `Publish failed: ${msg}`;
            },
          }),
        },
      },
    },
    published: { type: "final" },
    done: { type: "final" },
    failed: { type: "final" },
  },
});
